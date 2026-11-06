import { afterEach, expect } from "bun:test"
import { ConfigProvider, Effect, Fiber, Layer, Schema } from "effect"
import { HttpServer } from "effect/unstable/http"
import { createKiloClient } from "@kilocode/sdk/v2"
import { Collection, Registry, EmbeddingJob, EmbeddingCoverage, EmbeddingLedger, decode } from "@kilocode/forge/schema"
import { request as http } from "node:http"
import { disposeAllInstances, TestInstance, tmpdirScoped } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "../server/httpapi-layer"

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})
const it = testEffect(
  httpApiLayer.pipe(
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          KILO_SERVER_PASSWORD: "fixture-password",
          KILO_EXPERIMENTAL_DISABLE_FILEWATCHER: "true",
        }),
      ),
    ),
  ),
)
const authorization = `Basic ${Buffer.from("kilo:fixture-password").toString("base64")}`
const Session = Schema.Struct({ id: Schema.String })
const Review = Schema.Struct({ approved: Schema.Boolean, revision: Schema.String, endpoint: Schema.String })
const config = {
  formatter: false as const,
  lsp: false as const,
  model: "fixture/model",
  small_model: "fixture/model",
  enabled_providers: ["fixture"],
  provider: {
    fixture: {
      npm: "@ai-sdk/openai-compatible",
      api: "http://127.0.0.1:1/v1",
      models: { model: { name: "Fixture", limit: { context: 32000, output: 1000 } } },
      options: { apiKey: "fixture" },
    },
  },
}

it.instance(
  "authenticated embedding HTTP lifecycle preserves approval, scope, cancellation and source originals",
  () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const requests: string[] = []
      let entered = Promise.withResolvers<void>()
      let released = Promise.withResolvers<void>()
      let closed = Promise.withResolvers<void>()
      let held = false
      const server = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            async fetch(request) {
              requests.push(await request.text())
              if (held) {
                request.signal.addEventListener("abort", () => closed.resolve(), { once: true })
                entered.resolve()
                await released.promise
              }
              return Response.json({
                data: [{ index: 0, embedding: [1, 0] }],
                usage: { prompt_tokens: 7, total_tokens: 7 },
              })
            },
          }),
        ),
        (server) =>
          Effect.promise(async () => {
            released.resolve()
            await server.stop(true)
          }),
      )
      const variables = {
        KILO_FORGE_EMBEDDING_ENDPOINT: `${server.url}v1/embeddings`,
        KILO_FORGE_EMBEDDING_MODEL: "fixture",
        KILO_FORGE_EMBEDDING_DIMENSIONS: "2",
        KILO_FORGE_EMBEDDING_KEY: "embedding-private-key",
      }
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const previous = Object.fromEntries(Object.keys(variables).map((key) => [key, process.env[key]]))
          Object.assign(process.env, variables)
          return previous
        }),
        (previous) =>
          Effect.sync(() => {
            for (const [key, value] of Object.entries(previous)) {
              if (value == null) delete process.env[key]
              else process.env[key] = value
            }
          }),
      )
      const call = (route: string, body?: unknown, root = directory) =>
        requestInDirectory(route, root, {
          method: body === undefined ? "GET" : "POST",
          headers: { authorization, "content-type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
      const mutate = (route: string, body: unknown) =>
        requestInDirectory(route, directory, {
          method: "PUT",
          headers: { authorization, "content-type": "application/json" },
          body: JSON.stringify(body),
        })
      const session = decode(Session, yield* (yield* call("/session", {})).json)
      const other = decode(Session, yield* (yield* call("/session", {})).json)
      const registration = yield* call("/forge/knowledge", {
        kind: "text",
        label: "Manual",
        location: "",
        content: "Release ownership after the signed receipt arrives.",
        session: session.id,
      })
      expect(registration.status).toBe(200)
      const collection = decode(Collection, yield* registration.json)
      const root = `/forge/knowledge/${collection.id}`
      const route = `${root}/embeddings`
      const query = `?session=${session.id}`
      const registry = decode(Registry, yield* (yield* call(`/forge/knowledge${query}`)).json)
      expect(registry.provider).toBe("fixture")
      expect(
        (yield* mutate(root, {
          action: "approve",
          session: session.id,
          providers: ["fixture"],
          grants: { fixture: registry.destination!.fingerprint },
        })).status,
      ).toBe(200)
      expect((yield* mutate(root, { action: "index", session: session.id })).status).toBe(200)
      yield* pollWithTimeout(
        Effect.gen(function* () {
          const state = decode(Registry, yield* (yield* call(`/forge/knowledge${query}`)).json)
          const current = state.collections.find((item) => item.id === collection.id)
          if (current?.state === "failed") throw new Error(current.warnings.join(" "))
          return current?.state === "ready" ? true : undefined
        }),
        "Local collection did not finish",
        "10 seconds",
      )
      // Authenticate inspection as well as data-bearing operations.
      for (const [suffix, method, body] of [
        [query, "GET", undefined],
        [`/coverage${query}`, "GET", undefined],
        ["/approve", "POST", { session: session.id, revision: "0".repeat(64) }],
        ["/revoke", "POST", { session: session.id }],
        ["/index", "POST", { session: session.id }],
      ] as const) {
        const response = yield* requestInDirectory(`${route}${suffix}`, directory, {
          method,
          headers: { "content-type": "application/json" },
          body: body ? JSON.stringify(body) : undefined,
        })
        expect(response.status).toBe(401)
      }
      expect((yield* call(`${route}/index`, { session: session.id })).status).not.toBe(200)
      expect((yield* call(`${route}/coverage${query}`)).status).not.toBe(200)
      const review = decode(Review, yield* (yield* call(`${route}${query}`)).json)
      expect(review.approved).toBe(false)
      expect(review.endpoint).toBe(variables.KILO_FORGE_EMBEDDING_ENDPOINT)
      expect(JSON.stringify(review)).not.toContain("embedding-private-key")
      for (const body of [
        { session: session.id },
        { session: session.id, revision: "" },
        { session: session.id, revision: "stale" },
      ]) {
        expect((yield* call(`${route}/approve`, body)).status).toBe(400)
      }
      expect(requests).toEqual([])
      const foreign = yield* tmpdirScoped({ git: true, config })
      for (const scope of ["", other.id, "ses_missing"]) {
        expect((yield* call(`${route}?session=${scope}`)).status).not.toBe(200)
        expect((yield* call(`${route}/coverage?session=${scope}`)).status).not.toBe(200)
        for (const action of ["approve", "revoke", "index"]) {
          expect((yield* call(`${route}/${action}`, { session: scope, revision: review.revision })).status).not.toBe(
            200,
          )
        }
      }
      expect((yield* call(`${route}${query}`, undefined, foreign)).status).not.toBe(200)
      expect((yield* call(`${route}/coverage${query}`, undefined, foreign)).status).not.toBe(200)
      for (const action of ["approve", "revoke", "index"]) {
        expect(
          (yield* call(`${route}/${action}`, { session: session.id, revision: review.revision }, foreign)).status,
        ).not.toBe(200)
      }
      expect(requests).toEqual([])
      expect((yield* call(`${route}/approve`, { session: session.id, revision: review.revision })).status).toBe(200)
      const missing = decode(EmbeddingCoverage, yield* (yield* call(`${route}/coverage${query}`)).json)
      expect(missing).toMatchObject({
        collection: collection.id,
        session: session.id,
        sections: 1,
        reusable: 0,
        missing: 1,
        outdated: 0,
        stale: 0,
        excluded: 0,
      })
      expect(missing.finished).toBeGreaterThanOrEqual(missing.started)
      expect(JSON.stringify(missing)).not.toContain("signed receipt")
      expect(JSON.stringify(missing)).not.toContain("embedding-private-key")
      expect(requests).toEqual([])
      expect((yield* call(`${route}/approve`, { session: session.id, revision: review.revision })).status).not.toBe(200)
      expect(yield* (yield* call(`${route}/index`, { session: session.id })).json).toEqual({
        sections: 1,
        embedded: 1,
        reused: 0,
      })
      expect(yield* (yield* call(`${route}/index`, { session: session.id })).json).toEqual({
        sections: 1,
        embedded: 0,
        reused: 1,
      })
      expect(requests).toHaveLength(1)
      expect(decode(EmbeddingCoverage, yield* (yield* call(`${route}/coverage${query}`)).json)).toMatchObject({
        reusable: 1,
        missing: 0,
        outdated: 0,
        stale: 0,
      })
      expect(requests).toHaveLength(1)
      const selected = yield* (yield* call(`/forge/search?q=retire%20locks&session=${session.id}`)).json
      expect(JSON.stringify(selected)).toContain("signed receipt")
      expect(requests).toHaveLength(2)
      expect(yield* (yield* call(`${route}/revoke`, { session: session.id })).json).toEqual({ revoked: true })
      expect((yield* call(`${route}/coverage${query}`)).status).not.toBe(200)
      expect((yield* call(`${route}/index`, { session: session.id })).status).not.toBe(200)
      expect(
        JSON.stringify(yield* (yield* call(`/forge/search?q=retire%20locks&session=${session.id}`)).json),
      ).not.toContain("signed receipt")
      expect(requests).toHaveLength(2)
      const listener = yield* HttpServer.HttpServer
      const sdk = createKiloClient({ baseUrl: HttpServer.formatAddress(listener.address), headers: { authorization } })
      yield* Effect.promise(async () => {
        const parameters = { id: collection.id, directory, session: session.id }
        const reviewed = await sdk.forge.embeddingReview(parameters, { throwOnError: true })
        expect(reviewed.data.approved).toBe(false)
        expect(
          (
            await sdk.forge.embeddingApprove(
              { ...parameters, revision: reviewed.data.revision },
              { throwOnError: true },
            )
          ).data,
        ).toEqual({ approved: true })
        expect((await sdk.forge.embeddingIndex(parameters, { throwOnError: true })).data).toEqual({
          sections: 1,
          embedded: 0,
          reused: 1,
        })
        expect((await sdk.forge.embeddingCoverage(parameters, { throwOnError: true })).data).toMatchObject({
          collection: collection.id,
          session: session.id,
          sections: 1,
          reusable: 1,
          missing: 0,
        })
        expect((await sdk.forge.embeddingRevoke(parameters, { throwOnError: true })).data).toEqual({ revoked: true })
        expect((await sdk.forge.embeddingIndex(parameters)).error).toBeDefined()
      })
      expect(requests).toHaveLength(2)
      // A fresh document has no reusable cache; its first embedding must be held.
      const fresh = decode(
        Collection,
        yield* (yield* call("/forge/knowledge", {
          kind: "text",
          label: "Fresh",
          location: "",
          content: "Retain the dispatch journal for signed receipts.",
          session: session.id,
        })).json,
      )
      const target = `/forge/knowledge/${fresh.id}`
      const vectors = `${target}/embeddings`
      yield* mutate(target, { action: "approve", session: session.id, providers: [], grants: {} })
      yield* mutate(target, { action: "index", session: session.id })
      yield* pollWithTimeout(
        Effect.gen(function* () {
          const state = decode(Registry, yield* (yield* call(`/forge/knowledge${query}`)).json)
          return state.collections.find((item) => item.id === fresh.id)?.state === "ready" ? true : undefined
        }),
        "Reindex did not finish",
        "10 seconds",
      )
      const next = decode(Review, yield* (yield* call(`${vectors}${query}`)).json)
      yield* call(`${vectors}/approve`, { session: session.id, revision: next.revision })
      held = true
      const pending = yield* call(`${vectors}/index`, { session: session.id }).pipe(Effect.forkChild)
      yield* awaitWithTimeout(
        Effect.promise(() => entered.promise),
        "Embedding HTTP request did not start",
        "5 seconds",
      )
      yield* Fiber.interrupt(pending)
      yield* awaitWithTimeout(
        Effect.promise(() => closed.promise),
        "Embedding transport did not close after HTTP interruption",
        "2 seconds",
      )
      held = false
      expect(yield* (yield* call(`${vectors}/index`, { session: session.id })).json).toEqual({
        sections: 1,
        embedded: 1,
        reused: 0,
      })
      released.resolve()
      expect(yield* (yield* call(`${vectors}/index`, { session: session.id })).json).toEqual({
        sections: 1,
        embedded: 0,
        reused: 1,
      })
      // New job endpoints use engine ownership, unlike the synchronous route above.
      const shared = decode(
        Collection,
        yield* (yield* call("/forge/knowledge", {
          kind: "text",
          label: "Shared job",
          location: "",
          content: "Verify the amber receipt before releasing the transfer.",
        })).json,
      )
      const library = `/forge/knowledge/${shared.id}`
      const jobs = `${library}/embeddings/jobs`
      yield* mutate(library, { action: "approve", session: session.id, providers: [] })
      yield* mutate(library, { action: "index", session: session.id })
      yield* pollWithTimeout(
        Effect.gen(function* () {
          const state = decode(Registry, yield* (yield* call(`/forge/knowledge${query}`)).json)
          return state.collections.find((item) => item.id === shared.id)?.state === "ready" ? true : undefined
        }),
        "Job collection did not finish extraction",
        "10 seconds",
      )
      const count = requests.length
      const usage = `/forge/embeddings/usage${query}`
      expect((yield* requestInDirectory(usage, directory)).status).toBe(401)
      expect((yield* call(usage, undefined, foreign)).status).not.toBe(200)
      expect((yield* call(`/forge/embeddings/usage?session=ses_missing`)).status).not.toBe(200)
      for (const suffix of ["&limit=0", "&limit=101", "&after=0", "&after=9007199254740992"])
        expect((yield* call(usage + suffix)).status).not.toBe(200)
      const previous = decode(EmbeddingLedger, yield* (yield* call(usage)).json)
      expect(previous.entries).toHaveLength(count)
      expect(previous.entries.filter((entry) => entry.purpose === "query")).toHaveLength(1)
      expect(previous.entries.filter((entry) => entry.purpose === "index")).toHaveLength(count - 1)
      expect(yield* (yield* call(`${jobs}${query}`)).json).toEqual([])
      expect((yield* call(jobs, { session: session.id })).status).not.toBe(200)
      for (const [route, method] of [
        [`${jobs}${query}`, "GET"],
        [jobs, "POST"],
        [`${jobs}/missing/cancel`, "POST"],
      ] as const) {
        expect(
          (yield* requestInDirectory(route, directory, {
            method,
            headers: { "content-type": "application/json" },
            ...(method === "POST" ? { body: JSON.stringify({ session: session.id }) } : {}),
          })).status,
        ).toBe(401)
      }
      for (const scope of [other.id, "", "ses_missing"]) {
        expect((yield* call(`${vectors}/jobs?session=${scope}`)).status).not.toBe(200)
        expect((yield* call(`${vectors}/jobs`, { session: scope })).status).not.toBe(200)
        expect((yield* call(`${vectors}/jobs/missing/cancel`, { session: scope })).status).not.toBe(200)
      }
      for (const [route, body] of [
        [`${jobs}${query}`, undefined],
        [jobs, { session: session.id }],
        [`${jobs}/missing/cancel`, { session: session.id }],
        [jobs, undefined],
        [jobs, {}],
        [`${jobs}/missing/cancel`, {}],
      ] as const) {
        expect((yield* call(route, body, foreign)).status).not.toBe(200)
      }
      expect((yield* call(`${jobs}/${"x".repeat(129)}/cancel`, { session: session.id })).status).toBe(404)
      expect((yield* call(jobs, { session: 42 })).status).toBe(400)
      expect(requests).toHaveLength(count)
      const reviewed = decode(Review, yield* (yield* call(`${library}/embeddings${query}`)).json)
      yield* call(`${library}/embeddings/approve`, { session: session.id, revision: reviewed.revision })
      held = true
      entered = Promise.withResolvers<void>()
      released = Promise.withResolvers<void>()
      closed = Promise.withResolvers<void>()
      // Drop a real HTTP response after headers, without reading the admitted job ID.
      yield* Effect.promise(async () => {
        const dropped = Promise.withResolvers<void>()
        const url = new URL(jobs, HttpServer.formatAddress(listener.address))
        url.searchParams.set("directory", directory)
        const body = JSON.stringify({ session: session.id })
        const request = http(
          url,
          {
            method: "POST",
            headers: { authorization, "content-type": "application/json", "content-length": Buffer.byteLength(body) },
          },
          (response) => {
            if (response.statusCode !== 200) {
              dropped.reject(new Error(`Start failed: ${response.statusCode}`))
              response.resume()
              return
            }
            response.on("error", dropped.reject)
            response.destroy()
            dropped.resolve()
          },
        )
        request.on("error", dropped.reject)
        request.end(body)
        await dropped.promise
      }).pipe((effect) => awaitWithTimeout(effect, "Disconnected start did not return headers", "5 seconds"))
      yield* awaitWithTimeout(
        Effect.promise(() => entered.promise),
        "Detached job did not reach embedding transport",
        "5 seconds",
      )
      const history = decode(Schema.Array(EmbeddingJob), yield* (yield* call(`${jobs}${query}`)).json)
      const job = history.at(0)!
      expect(history).toHaveLength(1)
      expect(job.state).toBe("running")
      expect(job.progress.phase).toBe("embedding")
      expect(job.usage).toMatchObject({ attempts: 1, pending: 1, responses: 0, promptReports: 0 })
      expect(JSON.stringify(history)).not.toContain("amber receipt")
      expect(JSON.stringify(history)).not.toContain("embedding-private-key")
      expect(requests).toHaveLength(count + 1)
      const parameters = { id: shared.id, directory, session: session.id }
      yield* Effect.promise(async () => {
        const options = { throwOnError: true as const }
        const joined = await sdk.forge.embeddingStart(parameters, options)
        expect(joined.data.id).toBe(job.id)
        expect((await sdk.forge.embeddingJobs({ ...parameters, session: other.id }, options)).data).toEqual([])
        expect(
          (await sdk.forge.embeddingCancel({ ...parameters, session: other.id, job: job.id }, options)).data,
        ).toEqual({ requested: true })
        expect((await sdk.forge.embeddingJobs(parameters, options)).data.at(0)?.state).toBe("running")
      })
      const heartbeat = yield* pollWithTimeout(
        Effect.gen(function* () {
          const rows = decode(Schema.Array(EmbeddingJob), yield* (yield* call(`${jobs}${query}`)).json)
          const value = rows.at(0)!
          return value.updated > job.updated ? value : undefined
        }),
        "Shared job did not persist heartbeat",
        "3 seconds",
      )
      expect(heartbeat.state).toBe("running")
      expect(heartbeat.progressed).toBe(job.progressed)
      expect(heartbeat.progress.processed).toBe(0)
      yield* Effect.promise(async () => {
        const options = { throwOnError: true as const }
        expect((await sdk.forge.embeddingCancel({ ...parameters, job: job.id }, options)).data).toEqual({
          requested: true,
        })
        expect((await sdk.forge.embeddingJobs(parameters, options)).data.at(0)?.state).toBe("cancelled")
      })
      yield* awaitWithTimeout(
        Effect.promise(() => closed.promise),
        "Explicit job cancellation did not close transport",
        "2 seconds",
      )
      held = false
      const retry = yield* Effect.promise(
        async () => (await sdk.forge.embeddingStart(parameters, { throwOnError: true })).data,
      )
      const result = yield* pollWithTimeout(
        Effect.gen(function* () {
          const rows = decode(Schema.Array(EmbeddingJob), yield* (yield* call(`${jobs}${query}`)).json)
          const value = rows.find((item) => item.id === retry.id)
          if (value?.state === "failed") throw new Error(value.error)
          return value?.state === "completed" ? value : undefined
        }),
        "Retried shared job did not complete",
        "5 seconds",
      )
      expect(result.result).toEqual({ sections: 1, embedded: 1, reused: 0 })
      expect(result.usage).toMatchObject({
        attempts: 1,
        inputs: 1,
        responses: 1,
        pending: 0,
        failed: 0,
        promptTokens: 7,
        promptReports: 1,
        totalTokens: 7,
        totalReports: 1,
      })
      yield* Effect.promise(async () => {
        const value = (await sdk.forge.embeddingJobs(parameters, { throwOnError: true })).data.find(
          (row) => row.id === retry.id,
        )
        expect(value?.usage).toEqual(result.usage)
      })
      released.resolve()
      const final = decode(Schema.Array(EmbeddingJob), yield* (yield* call(`${jobs}${query}`)).json)
      expect(final.find((item) => item.id === job.id)?.state).toBe("cancelled")
      expect(requests).toHaveLength(count + 2)
      const ledger = decode(EmbeddingLedger, yield* (yield* call(usage)).json)
      expect(ledger.entries).toHaveLength(requests.length)
      expect(ledger.entries.at(0)!.usage).toEqual(result.usage!)
      expect(ledger.entries.at(0)!.purpose).toBe("job")
      expect(ledger.entries.at(0)!.collections).toEqual([shared.id])
      expect(ledger.entries.filter((entry) => entry.purpose === "job")).toHaveLength(2)
      expect(JSON.stringify(ledger)).not.toMatch(/amber receipt|embedding-private-key/)
      yield* Effect.promise(async () => {
        const options = { throwOnError: true as const }
        const first = (await sdk.forge.embeddingUsage({ directory, session: session.id, limit: "1" }, options)).data
        const rest = (await sdk.forge.embeddingUsage({ directory, session: session.id, after: first.next }, options))
          .data
        expect(ledger.entries).toEqual([...first.entries, ...rest.entries])
        expect((await sdk.forge.embeddingUsage({ directory, session: other.id }, options)).data.entries).toEqual([])
      })
      const home = yield* tmpdirScoped({ git: true, config })
      yield* Effect.promise(async () => {
        const output = `${home}/usage.json`
        const origin = new URL(HttpServer.formatAddress(listener.address))
        origin.hostname = "127.0.0.1"
        const proc = Bun.spawn(
          [
            ...(process.env.FORGE_USAGE_BINARY
              ? [process.env.FORGE_USAGE_BINARY]
              : [process.execPath, "run", "--conditions=node", `${import.meta.dir}/../../src/index.ts`]),
            "forge-usage",
            origin.origin,
            "--directory",
            directory,
            "--session",
            session.id,
            "--max",
            "2",
            "--output",
            output,
          ],
          {
            cwd: directory,
            env: {
              ...process.env,
              HOME: home,
              XDG_CONFIG_HOME: `${home}/config`,
              XDG_DATA_HOME: `${home}/data`,
              XDG_STATE_HOME: `${home}/state`,
              XDG_CACHE_HOME: `${home}/cache`,
              KILO_TEST_HOME: home,
              KILO_CONFIG_CONTENT: JSON.stringify(config),
              KILO_AUTH_CONTENT: "{}",
              KILO_DISABLE_PROJECT_CONFIG: "1",
              KILO_DISABLE_MODELS_FETCH: "1",
              KILO_DISABLE_AUTOUPDATE: "1",
              KILO_TELEMETRY_LEVEL: "off",
              KILO_SERVER_PASSWORD: "fixture-password",
              KILO_SERVER_USERNAME: "kilo",
              KILO_NO_DAEMON: "1",
            },
            stdout: "pipe",
            stderr: "pipe",
          },
        )
        const timer = setTimeout(() => proc.kill(), 45000)
        try {
          const [code, stdout, stderr] = await Promise.all([
            proc.exited,
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
          ])
          expect({ code, stderr: code === 0 ? "" : stderr }).toEqual({ code: 0, stderr: "" })
          expect(stdout.trim()).toBe("")
          const exported = await Bun.file(output).json()
          expect(exported.entries).toEqual(ledger.entries.slice(0, 2))
          expect(exported).toMatchObject({
            traversal: "limited",
            snapshot: false,
            history: "recorded-admissions-only",
            cost: null,
          })
          expect(JSON.stringify(exported)).not.toContain("fixture-password")
        } finally {
          clearTimeout(timer)
          proc.kill()
          await proc.exited
        }
      })
      expect(requests).toHaveLength(count + 2)
      const retention = { session: session.id, before: Date.now() + 1000, keep: 1 }
      for (const route of ["/forge/embeddings/retention", "/forge/embeddings/prune"]) {
        expect(
          (yield* requestInDirectory(route, directory, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ...retention, revision: "0".repeat(64), confirmation: "DELETE" }),
          })).status,
        ).toBe(401)
        expect(
          (yield* call(route, { ...retention, revision: "0".repeat(64), confirmation: "DELETE" }, foreign)).status,
        ).not.toBe(200)
      }
      yield* Effect.promise(async () => {
        const options = { throwOnError: true as const }
        const preview = (await sdk.forge.embeddingRetention({ directory, ...retention }, options)).data
        expect(preview.selected).toBeGreaterThan(0)
        const observed = decode(
          EmbeddingLedger,
          (await sdk.forge.embeddingUsage({ directory, session: session.id }, options)).data,
        )
        expect(observed.entries).toEqual(ledger.entries)
        const result = (
          await sdk.forge.embeddingPrune(
            {
              directory,
              ...retention,
              revision: preview.revision,
              confirmation: "DELETE",
            },
            options,
          )
        ).data
        expect(result.deleted).toBe(preview.selected)
        const page = (await sdk.forge.embeddingUsage({ directory, session: session.id }, options)).data
        expect(page.entries).toHaveLength(ledger.entries.length - preview.selected)
        expect(page.observation?.deleted).toBe(true)
        expect(
          (
            await sdk.forge.embeddingPrune({
              directory,
              ...retention,
              revision: preview.revision,
              confirmation: "DELETE",
            })
          ).error,
        ).toBeDefined()
        expect((await sdk.forge.embeddingJobs(parameters, options)).data).toHaveLength(final.length)
      })
      expect(requests).toHaveLength(count + 2)
      const updated = yield* requestInDirectory(`/session/${session.id}`, directory, {
        method: "PATCH",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify({ permission: [{ permission: "forge_embed", pattern: "*", action: "deny" }] }),
      })
      expect(updated.status).toBe(200)
      const sends = requests.length
      expect((yield* call(jobs, { session: session.id })).status).not.toBe(200)
      expect((yield* call(`${jobs}${query}`)).status).toBe(200)
      expect((yield* call(usage)).status).toBe(200)
      expect((yield* call(`${jobs}/${retry.id}/cancel`, { session: session.id })).status).toBe(200)
      const denied = yield* call(`${vectors}/index`, { session: session.id })
      expect(denied.status).not.toBe(200)
      expect(JSON.stringify(yield* denied.json)).toContain("Kilo permission denies forge_embed")
      const coverage = yield* call(`${vectors}/coverage${query}`)
      expect(coverage.status).not.toBe(200)
      expect(JSON.stringify(yield* coverage.json)).toContain("Kilo permission denies forge_embed")
      const latest = decode(Review, yield* (yield* call(`${vectors}${query}`)).json)
      expect((yield* call(`${vectors}/approve`, { session: session.id, revision: latest.revision })).status).not.toBe(
        200,
      )
      expect((yield* call(`${vectors}/revoke`, { session: session.id })).status).toBe(200)
      expect(requests).toHaveLength(sends)
      const forbidden = yield* requestInDirectory(`/session/${session.id}`, directory, {
        method: "PATCH",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify({ permission: [{ permission: "forge_knowledge", pattern: "*", action: "deny" }] }),
      })
      expect(forbidden.status).toBe(200)
      expect((yield* call("/forge/embeddings/retention", { ...retention, keep: 0 })).status).not.toBe(200)
      for (const [route, body] of [
        [`${vectors}/coverage${query}`, undefined],
        [`${jobs}${query}`, undefined],
        [jobs, { session: session.id }],
        [`${jobs}/${retry.id}/cancel`, { session: session.id }],
      ] as const) {
        const denied = yield* call(route, body)
        expect(denied.status).not.toBe(200)
        expect(JSON.stringify(yield* denied.json)).toContain("Kilo permission denies forge_knowledge")
      }
      expect(requests).toHaveLength(sends)
      // A fresh workspace with no host endpoint still supports withdrawing consent.
      delete process.env.KILO_FORGE_EMBEDDING_ENDPOINT
      const local = yield* tmpdirScoped({ git: true, config })
      const offline = decode(
        Collection,
        yield* (yield* call(
          "/forge/knowledge",
          {
            kind: "text",
            label: "Offline",
            location: "",
            content: "Do not send this document.",
          },
          local,
        )).json,
      )
      const unconfigured = `/forge/knowledge/${offline.id}/embeddings`
      expect((yield* call(unconfigured, undefined, local)).status).not.toBe(200)
      expect((yield* call(`${unconfigured}/coverage`, undefined, local)).status).not.toBe(200)
      expect((yield* call(`${unconfigured}/index`, {}, local)).status).not.toBe(200)
      expect(yield* (yield* call(`${unconfigured}/jobs`, undefined, local)).json).toEqual([])
      expect((yield* call(`${unconfigured}/jobs`, {}, local)).status).not.toBe(200)
      expect(yield* (yield* call(`${unconfigured}/jobs/missing/cancel`, {}, local)).json).toEqual({ requested: true })
      expect(yield* (yield* call(`${unconfigured}/revoke`, {}, local)).json).toEqual({ revoked: true })
      expect(requests).toHaveLength(sends)
    }),
  { config },
  60_000,
)
