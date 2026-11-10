import { afterEach, expect } from "bun:test"
import { ConfigProvider, Effect, Layer, Schema, Stream } from "effect"
import * as Sse from "effect/unstable/encoding/Sse"
import { pathToFileURL } from "node:url"
import { EnhancementFrame, Manifest, Proposal, decode } from "@kilocode/forge/schema"
import { Auth } from "@/auth"
import { disposeAllInstances, TestInstance, withTmpdirInstance } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import { httpApiLayer, requestInDirectory } from "../server/httpapi-layer"
import { pollWithTimeout, testEffect } from "../lib/effect"

afterEach(async () => { await disposeAllInstances(); await resetDatabase() })
const it = testEffect(httpApiLayer.pipe(
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({
    KILO_SERVER_PASSWORD: "oauth-enhancement",
    KILO_EXPERIMENTAL_DISABLE_FILEWATCHER: "true",
  }))),
  Layer.provideMerge(Auth.defaultLayer),
))
const headers = {
  authorization: `Basic ${Buffer.from("kilo:oauth-enhancement").toString("base64")}`,
  "content-type": "application/json",
}
const provider = "forge-oauth"
const original = "Improve queue processing without changing insertion order."
const draft = {
  summary: "Preserve insertion order and add a focused regression.",
  objective: "Improve queue processing", reuse: [], inspect: [],
  changes: ["Add a queue regression test"], constraints: ["Preserve insertion order"],
  hypotheses: [], questions: [], acceptance: [], verification: [], evidence: [],
}

for (const mode of ["ready", "json", "large", "reasoning", "reported", "failure", "cancel"] as const) {
  it.live(`legacy OAuth enhancement ${mode} preserves streaming and request limits`, () => Effect.gen(function* () {
    const calls: Record<string, unknown>[] = []
    const state = { closed: false }
    const server = yield* Effect.acquireRelease(Effect.sync(() => Bun.serve({
      hostname: "127.0.0.1", port: 0,
      async fetch(request) {
        const body: Record<string, unknown> = await request.json()
        calls.push(body)
        if (body.stream !== true || body.store !== false || typeof body.instructions !== "string"
          || body.max_output_tokens != null || body.temperature != null) {
          return Response.json({ error: { message: "Invalid Codex request parameters" } }, { status: 400 })
        }
        expect(request.headers.get("authorization")).toBe("Bearer fixture-access")
        expect(body.model).toBe("gpt-5.4-mini")
        expect(body.instructions).toContain("Allowed evidence IDs for this revision")
        expect(body).toMatchObject({ text: { format: { type: "json_schema" } } })
        expect(body.input).not.toEqual(expect.arrayContaining([expect.objectContaining({ role: "system" })]))
        if (mode === "failure") return Response.json({ error: { message: "PRIVATE_PROVIDER_CANARY" } }, { status: 400 })
        const item = { type: "message", id: "message" }
        const value = JSON.stringify(draft)
        const events = [
          { type: "response.created", response: { id: "response", created_at: 1, model: "gpt-5.4-mini" } },
          { type: "response.output_item.added", output_index: 0, item },
          ...(mode === "reasoning" ? [{
            type: "response.reasoning_summary_text.delta", item_id: "reasoning", summary_index: 0,
            delta: "PRIVATE_REASONING_CANARY".repeat(200),
          }] : []),
          { type: "response.output_text.delta", item_id: item.id, delta: mode === "large" ? "x".repeat(5000) : value },
          { type: "response.output_item.done", output_index: 0, item },
          { type: "response.completed", response: { usage: { input_tokens: 30, output_tokens: mode === "reported" ? 5000 : 100 } } },
        ]
        const encode = (items: typeof events) => items.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")
        const content = mode === "cancel" ? new ReadableStream({
          start(controller) { controller.enqueue(new TextEncoder().encode(encode(events.slice(0, -2)))) },
          cancel() { state.closed = true },
        }) : encode(events)
        return new Response(content, {
          headers: { "content-type": "text/event-stream" },
        })
      },
    })), (server) => Effect.promise(() => server.stop(true)))
    const auth = yield* Auth.Service
    yield* auth.set(provider, { type: "oauth", access: "fixture-access", refresh: "fixture-refresh", expires: Date.now() + 60_000 })
    yield* Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const result = yield* requestInDirectory(mode === "json" ? "/forge/enhance" : "/forge/enhance/stream", directory, {
        method: "POST", headers,
        body: JSON.stringify({ text: original, model: { providerID: provider, modelID: "gpt-5.4-mini" } }),
      })
      expect(result.status).toBe(200)
      const frames = mode === "json"
        ? [{ type: "result" as const, proposal: decode(Proposal, yield* result.json) }]
        : yield* result.stream.pipe(
          Stream.decodeText(), Stream.pipeThroughChannel(Sse.decode()),
          Stream.map((event) => decode(EnhancementFrame, JSON.parse(event.data))),
          Stream.takeUntil((frame) => mode === "cancel" && frame.type === "progress" && !!frame.preview),
          Stream.runCollect,
        )
      const final = frames.at(-1)!
      expect(calls).toHaveLength(1)
      if (mode === "ready" || mode === "json") {
        expect(final.type).toBe("result")
        if (final.type !== "result") throw new Error("Expected a successful OAuth enhancement")
        expect(final.proposal.original).toBe(original)
        expect(final.proposal.summary).toBe(draft.summary)
        expect(final.proposal.model).toEqual({ providerID: provider, modelID: "gpt-5.4-mini" })
        expect(final.proposal.usage.output).toBe(100)
        if (mode === "ready") expect(frames.some((frame) => frame.type === "progress" && frame.summary === draft.summary)).toBe(true)
      }
      if (mode !== "ready" && mode !== "json" && mode !== "cancel") {
        expect(final.type).toBe("error")
        if (final.type !== "error") throw new Error("Expected a bounded enhancement failure")
        expect(final.failure?.code).toBe(mode === "failure" ? "transport" : "cutoff")
        expect(final.message).toContain(mode === "failure" ? "HTTP 400" : "output limit")
        expect(frames.some((frame) => frame.type === "result")).toBe(false)
      }
      if (mode === "cancel") {
        yield* pollWithTimeout(Effect.sync(() => state.closed ? true : undefined), "Cancelling enhancement did not close the provider stream")
        expect(final.type).toBe("progress")
        expect(frames.some((frame) => frame.type === "result")).toBe(false)
      }
      expect(JSON.stringify(frames)).not.toContain("PRIVATE_")
      const history = yield* requestInDirectory("/forge/requests", directory, { headers })
      const records = decode(Schema.Array(Manifest), yield* history.json)
      expect(records).toHaveLength(1)
      expect(records.at(0)?.state).toBe(mode === "ready" || mode === "json" ? "completed" : "failed")
      expect(records.at(0)?.attempts).toHaveLength(1)
      expect(JSON.stringify(records)).not.toContain("PRIVATE_")
    }).pipe(withTmpdirInstance({
      init: (directory) => Effect.promise(async () => {
        const plugin = `${directory}/oauth.ts`
        await Bun.write(`${directory}/queue.ts`, "export const queue = []\n")
        await Bun.write(plugin, [
          `import { oauth } from ${JSON.stringify(import.meta.resolve("./fixture/forge-oauth"))}`,
          `export default async () => ({ auth: { provider: ${JSON.stringify(provider)}, methods: [], loader: async () => (await oauth(${JSON.stringify(new URL("/responses", server.url).href)})).options } })`,
        ].join("\n"))
        await Bun.write(`${directory}/opencode.json`, JSON.stringify({
          formatter: false, lsp: false, enabled_providers: [provider],
          model: `${provider}/gpt-5.4-mini`, small_model: `${provider}/gpt-5.4-mini`,
          plugin: [pathToFileURL(plugin).href],
          provider: { [provider]: {
            npm: "@ai-sdk/openai",
            options: { baseURL: new URL("/v1", server.url).href },
            models: { "gpt-5.4-mini": { name: "OAuth enhancement fixture", limit: { context: 128_000, output: 2000 } } },
          } },
        }))
      }),
    }))
  }), 30_000)
}
