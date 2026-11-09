import { afterEach, expect } from "bun:test"
import { ConfigProvider, Effect, Layer, Schema } from "effect"
import { randomUUID } from "node:crypto"
import { mkdir } from "node:fs/promises"
import { Investigation, InvestigationFrame, Prepared, decode } from "@kilocode/forge"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "../server/httpapi-layer"

afterEach(async () => { await disposeAllInstances(); await resetDatabase() })
const it = testEffect(httpApiLayer.pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({
  KILO_SERVER_PASSWORD: "investigation-fixture",
  KILO_EXPERIMENTAL_DISABLE_FILEWATCHER: "true",
})))))
const authorization = `Basic ${Buffer.from("kilo:investigation-fixture").toString("base64")}`
const headers = { authorization, "content-type": "application/json" }

for (const mode of ["ready", "quiet", "purpose", "stream", "auto", "serial", "reasoning", "symbol", "read-error", "source-error", "batch", "finish-batch", "duplicate-finish", "bounded", "rejected", "cutoff", "malformed", "writer-rejected", "denied", "unsupported"] as const) {
  it.instance(`investigation HTTP ${mode} uses bounded native tools and preserves source permissions`, () => Effect.gen(function* () {
    const { directory } = yield* TestInstance
    yield* Effect.promise(() => mkdir(`${directory}/.kilo`, { recursive: true }))
    yield* Effect.promise(() => Bun.write(`${directory}/.kilo/forge.jsonc`, '{"investigation":true}'))
    yield* Effect.promise(() => Bun.write(`${directory}/queue.ts`, "export function enqueue(id: string) { return [id, id] }\n"))
    const bodies: Array<{ tools?: readonly { function: { name: string } }[]; tool_choice?: unknown }> = []
    const server = yield* Effect.acquireRelease(Effect.sync(() => Bun.serve({
      hostname: "127.0.0.1", port: 0,
      async fetch(request) {
        const body = decode(Schema.Struct({
          messages: Schema.Array(Schema.Struct({ role: Schema.String, content: Schema.Unknown })),
          tools: Schema.optional(Schema.Array(Schema.Struct({ function: Schema.Struct({ name: Schema.String, parameters: Schema.Unknown }) }))),
          tool_choice: Schema.optional(Schema.Unknown),
          parallel_tool_calls: Schema.optional(Schema.Boolean),
          reasoning: Schema.optional(Schema.Struct({ max_tokens: Schema.Number, effort: Schema.optional(Schema.String), exclude: Schema.optional(Schema.Boolean) })),
        }), await request.json())
        bodies.push(body)
        if (mode === "serial" && body.tools) expect(body.parallel_tool_calls).toBe(false)
        if (mode === "reasoning") {
          expect(body.reasoning).toMatchObject({ max_tokens: 1024, exclude: true })
          expect(body.reasoning?.effort).toBeUndefined()
        }
        if (mode === "auto" && body.tools && body.tool_choice !== "auto") {
          return Response.json({ error: { message: "This model does not support a required or named tool choice. Remove it and retry." } }, { status: 400 })
        }
        if (mode === "rejected") {
          return Response.json({ error: { message: "Too many requests PRIVATE_PROVIDER_CANARY" } }, { status: 429 })
        }
        if (!body.tools) {
          if (mode === "writer-rejected") {
            return Response.json({ error: { message: "Invalid API key PRIVATE_WRITER_CANARY" } }, { status: 401 })
          }
          const user = body.messages.findLast((item) => item.role === "user")
          if (typeof user?.content !== "string") throw new Error("Expected writer input")
          const data = decode(Schema.Struct({
            requirements: Schema.Array(Schema.Struct({ id: Schema.String })),
            sources: Schema.Array(Schema.Struct({ id: Schema.String })),
          }), JSON.parse(user.content))
          expect(user.content).not.toContain("return [id, id]")
          return Response.json({
            id: "writer", object: "chat.completion", created: 1, model: "model",
            choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify({
              objective: "Fix the duplicate queue return value.",
              basis: "The inspected function duplicates its identifier. Tests remain to be run.",
              changes: ["Return one identifier and add a regression test."], constraints: [],
              verification: ["Proposed: test a single enqueue call."],
              evidence: data.sources.map((item) => item.id), requirements: data.requirements.map((item) => item.id),
            }) } }],
            usage: { prompt_tokens: 150, completion_tokens: 70, total_tokens: 220 },
          })
        }
        const final = mode === "bounded" && body.tools.length === 1 && body.tools.at(0)?.function.name === "forge_finish"
        if (final) expect(body.messages.find((item) => item.role === "system")?.content).toContain("final allowed investigation turn")
        expect(body.tool_choice).toEqual(final ? { type: "function", function: { name: "forge_finish" } } : "auto")
        expect(body.tools.map((item) => item.function.name).sort()).toEqual(final ? ["forge_finish"] : [
          "forge_finish", "forge_get_symbol", "forge_lookup", "forge_read_file", "forge_relationships", "forge_search_code", "forge_search_docs",
        ])
        if (!final) expect(body.tools.find((item) => item.function.name === "forge_read_file")).toMatchObject({
          function: { parameters: { required: ["path", "purpose"], properties: { path: { pattern: "^[\\s\\S]*\\S[\\s\\S]*$" } } } },
        })
        const last = body.messages.findLast((item) => item.role === "tool")
        const source = last && typeof last.content === "string" ? decode(Schema.Struct({ source: Schema.optional(Schema.Struct({ id: Schema.String })) }), JSON.parse(last.content)).source : undefined
        const inspect = source && mode === "symbol" && bodies.length === 2
        const finish = source && !inspect && (mode !== "bounded" || final)
        const missing = mode === "source-error" && bodies.length === 1
        const name = inspect || missing ? "forge_get_symbol" : finish ? "forge_finish" : "forge_read_file"
        const input = finish ? {
          intent: "Fix duplicated queue entries",
          summary: "The implementation returns the same identifier twice.",
          findings: [{
            title: "Duplicate return value", kind: "defect", support: "observed",
            explanation: "enqueue returns two copies of its input.", benefit: "Prevent duplicated work.",
            evidence: [source.id], counterevidence: [], unknowns: [],
            action: "Return one item per enqueue.", verification: ["Add a regression for a single identifier."],
          }], questions: [], limitations: ["Tests have not been run."],
        } : missing ? { id: "missing" } : inspect ? { id: source.id } : {
          path: mode === "read-error" && bodies.length === 1 ? "missing.ts" : "queue.ts",
          ...(mode === "purpose" ? { purpose: "Compare queue behavior before recommending a fix." } : {}),
        }
        return Response.json({
          id: `completion-${bodies.length}`, object: "chat.completion", created: 1, model: "model",
          choices: [{ index: 0, finish_reason: mode === "cutoff" ? "length" : "tool_calls", message: {
            role: "assistant", content: mode === "quiet" || mode === "purpose" ? null : finish ? "<tool_call>RAW_CALL_CANARY</tool_call>" : "I will inspect queue.ts to check duplicate entries.",
            reasoning: "PRIVATE_REASONING_CANARY", reasoning_content: "PRIVATE_REASONING_CANARY",
            tool_calls: Array.from({ length: mode === "batch" && !source ? 3 : (mode === "finish-batch" || mode === "duplicate-finish") && source ? 2 : 1 }, (_, index) => ({
              id: `tool-${bodies.length}-${index}`, type: "function", function: {
                name: mode === "malformed" ? "forge_finish" : mode === "finish-batch" && index === 1 ? "forge_read_file" : name,
                arguments: JSON.stringify(mode === "malformed" ? { intent: 42, PRIVATE_KEY_CANARY: "PRIVATE_MODEL_CANARY" } : mode === "finish-batch" && index === 1 ? { path: "unread.ts" } : input),
              },
            })),
          } }],
          usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 },
        })
      },
    })), (server) => Effect.promise(() => server.stop(true)))
    const provider = `investigation-${mode}`
    const id = mode === "auto" ? "kilo-auto/free" : "model"
    const configured = yield* requestInDirectory("/config", directory, {
      method: "PATCH", headers,
      body: JSON.stringify({
        formatter: false, lsp: false, enabled_providers: [provider], model: `${provider}/${id}`,
        permission: mode === "denied" ? { forge_investigate: "deny" } : {},
        provider: { [provider]: {
          npm: mode === "auto" ? "@kilocode/kilo-gateway" : mode === "serial" || mode === "reasoning" ? "@openrouter/ai-sdk-provider" : "@ai-sdk/openai-compatible",
          options: { baseURL: new URL("/v1", server.url).href, apiKey: "fixture" },
          models: { [id]: {
            name: "Investigation fixture", tool_call: mode !== "unsupported", reasoning: mode === "reasoning",
            ...(mode === "reasoning" ? { options: { reasoning: { effort: "high", exclude: true } } } : {}),
            limit: { context: 128_000, output: 8000 },
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
    const input = { key: randomUUID(), text: "Help fix duplicated queue entries", model: { providerID: provider, modelID: id } }
    const response = yield* requestInDirectory(mode === "stream" ? `${route}/stream` : route, directory, { method: "POST", headers, body: JSON.stringify(input) })
    if (mode === "rejected" || mode === "malformed" || mode === "cutoff") {
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
      expect(yield* response.text).toContain(mode === "denied" ? "denies" : "does not support")
      expect(bodies).toEqual([])
      return
    }
    if (response.status !== 200) throw new Error(yield* response.text)
    expect(response.status).toBe(200)
    const text = yield* response.text
    expect(text).not.toContain("RAW_CALL_CANARY")
    const frames = mode === "stream" ? text.split("\n").filter((line) => line.startsWith("data: ")).map((line) => decode(InvestigationFrame, JSON.parse(line.slice(6)))) : []
    const record = decode(Investigation, mode === "stream" ? frames.find((item) => item.type === "result")?.investigation : JSON.parse(text))
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
    const count = mode === "bounded" ? bodies.length : mode === "symbol" || mode === "read-error" || mode === "source-error" ? 3 : 2
    expect(count).toBeLessThanOrEqual(12)
    expect(count).toBeGreaterThan(1)
    expect(record.turns).toBe(count)
    expect(record.journal).toHaveLength(count)
    expect(record.journal?.every((item) => item.state === "complete")).toBe(true)
    expect(record.journal?.at(-1)?.included).toContain(record.observations.at(-1)?.id)
    expect(record.calls).toBe(mode === "batch" ? 3 : count - 1)
    if (mode === "finish-batch") expect(record.limitations.join(" ")).toContain("not executed")
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
