import { afterEach, expect } from "bun:test"
import { ConfigProvider, Effect, Layer, Schema } from "effect"
import { randomUUID } from "node:crypto"
import { mkdir } from "node:fs/promises"
import { Investigation, InvestigationFrame, Prepared, decode } from "@kilocode/forge"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "../server/httpapi-layer"
import { model, scenarios } from "./fixture/forge-investigation"

afterEach(async () => { await disposeAllInstances(); await resetDatabase() })
const it = testEffect(httpApiLayer.pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({
  KILO_SERVER_PASSWORD: "investigation-fixture",
  KILO_EXPERIMENTAL_DISABLE_FILEWATCHER: "true",
})))))
const authorization = `Basic ${Buffer.from("kilo:investigation-fixture").toString("base64")}`
const headers = { authorization, "content-type": "application/json" }

for (const scenario of scenarios) {
  const mode = scenario.name
  it.instance(`investigation HTTP ${mode} uses bounded native tools and preserves source permissions`, () => Effect.gen(function* () {
    const { directory } = yield* TestInstance
    yield* Effect.promise(() => mkdir(`${directory}/.kilo`, { recursive: true }))
    yield* Effect.promise(() => Bun.write(`${directory}/.kilo/forge.jsonc`, '{"investigation":true}'))
    yield* Effect.promise(() => Bun.write(`${directory}/queue.ts`, "export function enqueue(id: string) { return [id, id] }\n"))
    const endpoint = model(scenario)
    const bodies = endpoint.bodies
    const server = yield* Effect.acquireRelease(Effect.sync(() => Bun.serve({
      hostname: "127.0.0.1", port: 0, fetch: endpoint.fetch,
    })), (server) => Effect.promise(() => server.stop(true)))
    const provider = `investigation-${mode}`
    const id = scenario.alias ?? "model"
    const configured = yield* requestInDirectory("/config", directory, {
      method: "PATCH", headers,
      body: JSON.stringify({
        formatter: false, lsp: false, enabled_providers: [provider], model: `${provider}/${id}`,
        permission: scenario.deny ? { forge_investigate: "deny" } : {},
        provider: { [provider]: {
          npm: scenario.npm ?? "@ai-sdk/openai-compatible",
          options: { baseURL: new URL("/v1", server.url).href, apiKey: "fixture" },
          models: { [id]: {
            name: "Investigation fixture", tool_call: !scenario.unsupported, reasoning: !!scenario.reasoning,
            ...(scenario.reasoning ? { options: { reasoning: { effort: "high", exclude: true } } } : {}),
            limit: { context: 128_000, output: scenario.output ?? 16_000 },
          } },
        } },
      }),
    })
    expect(configured.status).toBe(200)
    yield* pollWithTimeout(Effect.gen(function* () {
      const response = yield* requestInDirectory("/config/providers", directory, { headers })
      const catalog = decode(Schema.Struct({ providers: Schema.Array(Schema.Struct({ id: Schema.String, models: Schema.Record(Schema.String, Schema.Unknown) })) }), yield* response.json)
      return catalog.providers.some((item) => item.id === provider && item.models[id] != null) ? true : undefined
    }), "Investigation fixture provider was not ready")
    const route = "/forge/investigations"
    expect((yield* requestInDirectory(route, directory, { method: "POST", body: "{}" })).status).toBe(401)
    const input = {
      key: randomUUID(),
      text: mode === "unresolved" ? "Improve backend throughput" : "Help fix duplicated queue entries",
      ...(mode === "unresolved" ? { answers: "Improve throughput or concurrency. I do not yet have reproducible details." } : {}),
      model: { providerID: provider, modelID: id },
    }
    const response = yield* requestInDirectory(mode === "stream" ? `${route}/stream` : route, directory, { method: "POST", headers, body: JSON.stringify(input) })
    if (mode === "rejected" || mode === "malformed" || mode === "clarify-invalid" || mode === "cutoff") {
      const visible = mode === "rejected" ? "HTTP 429" : mode === "cutoff" ? "output limit" : "Invalid findings or clarification format"
      expect(response.status).toBe(500)
      const error = yield* response.text
      expect(error).toContain(visible)
      expect(error).not.toContain("PRIVATE_")
      const stream = yield* requestInDirectory(`${route}/stream`, directory, {
        method: "POST", headers, body: JSON.stringify({ ...input, key: randomUUID() }),
      })
      expect(stream.status).toBe(200)
      const frames = yield* stream.text
      expect(frames).toContain('"type":"error"')
      expect(frames).toContain(visible)
      expect(frames).toContain("kept")
      expect(frames).not.toContain("PRIVATE_")
      expect(frames).not.toContain("Effect.tryPromise")
      expect(bodies).toHaveLength(2)
      const saved = decode(Investigation, yield* (yield* requestInDirectory(`${route}/${input.key}`, directory, { headers })).json)
      expect(saved.original).toBe(input.text)
      expect(saved.state).toBe("failed")
      expect(saved.observations).toEqual([])
      expect(saved.limitations.join(" ")).toContain(visible)
      expect(saved.limitations.join(" ")).not.toContain("PRIVATE_")
      return
    }
    if (mode === "denied" || mode === "unsupported") {
      expect(response.status).not.toBe(200)
      expect(yield* response.text).toContain(mode === "denied" ? "denied" : "does not support")
      expect(bodies).toEqual([])
      return
    }
    if (response.status !== 200) throw new Error(yield* response.text)
    expect(response.status).toBe(200)
    const text = yield* response.text
    expect(text).not.toContain("RAW_CALL_CANARY")
    const frames = mode === "stream" ? text.split("\n").filter((line) => line.startsWith("data: ")).map((line) => decode(InvestigationFrame, JSON.parse(line.slice(6)))) : []
    const record = decode(Investigation, mode === "stream" ? frames.find((item) => item.type === "result")?.investigation : JSON.parse(text))
    if (mode === "public") {
      expect(record.state).toBe("unstructured")
      expect(record.summary).toBe("Which backend behavior should change?")
      expect(record.findings).toEqual([])
      expect(record.questions).toEqual([])
      expect(record.calls).toBe(0)
      expect(bodies).toHaveLength(1)
      return
    }
    if (mode === "clarify" || mode === "clarify-missing" || mode === "clarify-malformed") {
      expect(record.state).toBe("needs_input")
      expect(record.questions).toMatchObject([
        { id: "scope", optional: false },
        { id: "request", optional: false, when: { question: "scope", options: ["Fix a failing request"] } },
      ])
      expect(record.findings).toEqual([])
      expect(record.observations).toEqual([])
      expect(record.calls).toBe(0)
      expect(record.turns).toBe(1)
      expect(bodies).toHaveLength(1)
      const saved = decode(Investigation, yield* (yield* requestInDirectory(`${route}/${input.key}`, directory, { headers })).json)
      expect(saved).toEqual(record)
      return
    }
    if (mode === "stream") {
      expect(frames.some((item) => item.type === "progress" && item.journal?.at(0)?.state === "model")).toBe(true)
      expect(frames.some((item) => item.type === "progress" && item.observations?.at(0)?.turn === 1)).toBe(true)
      expect(frames.at(-1)?.type).toBe("result")
    }
    expect(JSON.stringify(record)).not.toContain("PRIVATE_REASONING_CANARY")
    expect(record.journal?.at(0)?.note).toBe(mode === "quiet" ? undefined : mode === "purpose" ? "Compare queue behavior before recommending a fix." : "I will inspect queue.ts to check duplicate entries.")
    expect(record.journal?.at(-1)?.note).toBe("The implementation returns the same identifier twice.")
    expect(record.state).toBe("findings_ready")
    expect(record.findings).toHaveLength(1)
    if (mode === "metadata") {
      expect(JSON.stringify(record)).not.toContain("EXTRA_METADATA_CANARY")
      expect(record.findings.at(0)?.id).not.toBe("MODEL_ID_CANARY")
      expect(record.failure).toBeUndefined()
      expect(record.limitations.join(" ")).not.toContain("discarded")
    }
    if (mode === "unresolved") {
      expect(record.findings.at(0)).toMatchObject({ kind: "improvement", support: "unresolved" })
      expect(record.answers).toBe(input.answers!)
      expect(record.limitations.join(" ")).toContain("Unverified direction")
    }
    if (mode === "partial") expect(record.limitations.join(" ")).toContain("discarded: invalid action format")
    const count = mode === "bounded" ? bodies.length : mode === "symbol" || mode === "read-error" || mode === "source-error" || mode === "finish-batch" ? 3 : 2
    expect(count).toBeLessThanOrEqual(12)
    expect(count).toBeGreaterThan(1)
    expect(record.turns).toBe(count)
    expect(record.journal).toHaveLength(count)
    expect(record.journal?.every((item) => item.state === "complete")).toBe(true)
    expect(record.journal?.at(-1)?.included).toContain(record.observations.at(-1)?.id)
    expect(record.calls).toBe(mode === "batch" ? 3 : count - 1)
    if (mode === "finish-batch") {
      expect(record.limitations.join(" ")).toContain("Premature conclusions")
      expect(record.journal?.at(1)?.inspections.map((item) => item.state)).toEqual(["skipped", "complete"])
    }
    if (mode === "duplicate-finish") expect(record.limitations.join(" ")).toContain("Repeated identical conclusions")
    expect(record.usage.input).toBe(count * 100)
    expect(record.usage.measured).toBe(true)
    expect(record.observations.at(0)?.tool).toBe(mode === "source-error" ? "forge_get_symbol" : "forge_read_file")
    expect(bodies).toHaveLength(count)
    expect(bodies.slice(0, mode === "bounded" ? -1 : undefined).every((body) => body.tool_choice === "auto")).toBe(true)
    const duplicate = yield* requestInDirectory(route, directory, { method: "POST", headers, body: JSON.stringify(input) })
    expect(duplicate.status).toBe(200)
    expect(bodies).toHaveLength(count)
    const selection = yield* requestInDirectory("/forge/preparations", directory, {
      method: "POST", headers, body: JSON.stringify({ key: randomUUID(), investigation: record.id, revision: record.revision, selected: record.findings.map((item) => item.id) }),
    })
    if (selection.status !== 200) throw new Error(yield* selection.text)
    const direction = decode(Prepared, yield* selection.json)
    expect(direction.state).toBe("selected")
    expect(bodies).toHaveLength(count)
    const prepared = yield* requestInDirectory("/forge/preparations/write", directory, {
      method: "POST", headers, body: JSON.stringify({ id: direction.id, revision: direction.revision, key: randomUUID() }),
    })
    if (mode === "writer-rejected") {
      expect(prepared.status).toBe(500)
      const error = yield* prepared.text
      expect(error).toContain("HTTP 401")
      expect(error).toContain("login or API key")
      expect(error).not.toContain("PRIVATE_")
      expect(error).not.toContain("Effect.tryPromise")
      expect(bodies).toHaveLength(count + 1)
      expect(bodies.at(-1)?.tools).toBeUndefined()
      return
    }
    if (prepared.status !== 200) throw new Error(yield* prepared.text)
    const prompt = decode(Prepared, yield* prepared.json)
    expect(prompt.state).toBe("ready")
    expect(prompt.prompt).not.toContain("return [id, id]")
    expect(prompt.prompt).toContain(input.text)
    if (mode === "unresolved") {
      expect(prompt.prompt).toContain("Investigate and measure first")
      expect(prompt.prompt).toContain("The throughput impact has not been measured.")
      expect(prompt.prompt).toContain(input.answers!)
    }
    expect(prompt.usage.measured).toBe(true)
    expect(bodies).toHaveLength(count + 1)
    const status = decode(Schema.Struct({ preparation: Schema.Struct({ purpose: Schema.String }) }), yield* (yield* requestInDirectory("/forge/status", directory, { headers })).json)
    expect(status.preparation.purpose).toBe("investigation-write")
    const history = decode(Schema.Array(Schema.Struct({ purpose: Schema.String, operation: Schema.String, coverage: Schema.Array(Schema.String) })), yield* (yield* requestInDirectory("/forge/requests", directory, { headers })).json)
    expect(history.filter((item) => ["investigate", "investigation-write"].includes(item.purpose)).every((item) => item.operation === record.id)).toBe(true)
    expect(history.find((item) => item.purpose === "investigation-write")?.coverage.join("\n")).toContain(record.observations.flatMap((item) => item.sources).at(0)!.id)
    yield* Effect.promise(() => Bun.write(`${directory}/queue.ts`, "export function enqueue(id: string) { return [id] }\n"))
    expect((yield* requestInDirectory(`${route}/${record.id}`, directory, { headers })).status).not.toBe(200)
  }), 30_000)
}
