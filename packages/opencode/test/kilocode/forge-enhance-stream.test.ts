import { afterEach, expect } from "bun:test"
import { ConfigProvider, Effect, Layer, Schema, Stream } from "effect"
import * as Sse from "effect/unstable/encoding/Sse"
import { EnhancementFrame, Manifest, decode } from "@kilocode/forge/schema"
import { GlobalBus } from "@/bus/global"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "../server/httpapi-layer"
import { response } from "./forge-model-stream"

afterEach(async () => { await disposeAllInstances(); await resetDatabase() })
const it = testEffect(httpApiLayer.pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({
  KILO_SERVER_PASSWORD: "stream-fixture",
  KILO_EXPERIMENTAL_DISABLE_FILEWATCHER: "true",
})))))
const authorization = `Basic ${Buffer.from("kilo:stream-fixture").toString("base64")}`
const original = "Improve queue processing in queue.ts"
const draft = {
  summary: "I will make the requested scope explicit and preserve existing behavior.",
  objective: "Improve the codebase within the requested scope",
  reuse: [], inspect: [], changes: ["Add tests for the requested behavior"], constraints: [],
  hypotheses: [], questions: [], acceptance: [], verification: [], evidence: [],
}

for (const mode of ["ready", "schema", "gateway", "gateway-rejected", "gateway-unsupported", "routed", "routed-missing", "routed-cutoff", "routed-citation", "routed-blocking", "shortened", "schema-shortened", "hypothesis", "invalid-hypothesis", "missing", "schema-missing", "null", "schema-null", "scalar", "schema-scalar", "objects", "schema-objects", "mixed", "schema-mixed", "empty", "schema-empty", "strings", "schema-strings", "malformed", "cutoff", "citation"] as const) {
  const routed = mode.startsWith("routed")
  const gateway = mode.startsWith("gateway") || routed
  const structured = (mode === "schema" || mode.startsWith("schema-") || gateway) && !routed
  const variant = mode.replace(/^(?:schema|routed)-/, "")
  const verification = ["missing", "null", "scalar", "objects", "mixed"].includes(variant)
  const explicit = mode === "ready" || mode === "schema" || routed
  const rejected = mode === "gateway-rejected" || mode === "gateway-unsupported"
  const id = routed ? "kilo-auto/free" : explicit ? "large" : "model"
  const provider = `stream-${mode}`
  const config = {
    formatter: false as const, lsp: false as const, enabled_providers: [provider],
    model: `${provider}/model`, small_model: `${provider}/model`,
  }
  it.instance(`private enhancement stream handles ${mode} JSON without broadcasting model text`, () => Effect.gen(function* () {
    const { directory } = yield* TestInstance
    const calls: string[] = []
    const notices: string[] = []
    const listener = (event: unknown) => notices.push(JSON.stringify(event))
    yield* Effect.acquireRelease(
      Effect.sync(() => GlobalBus.on("event", listener)),
      () => Effect.sync(() => void GlobalBus.off("event", listener)),
    )
    const server = yield* Effect.acquireRelease(Effect.sync(() => Bun.serve({
      hostname: "127.0.0.1", port: 0,
      async fetch(request) {
        const text = await request.text()
        calls.push(text)
        if (routed) {
          const body = decode(Schema.Struct({
            max_tokens: Schema.Number,
            response_format: Schema.optional(Schema.Unknown),
            messages: Schema.Array(Schema.Struct({
              role: Schema.String,
              content: Schema.Union([Schema.String, Schema.Array(Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }))]),
            })),
          }), JSON.parse(text))
          if (body.response_format != null) return Response.json({ error: {
            message: "This model does not support structured output. Remove it and retry.",
            type: "invalid_request_error",
          } }, { status: 400 })
          expect(body.max_tokens).toBe(12_000)
          const content = body.messages.find((item) => item.role === "system")?.content
          expect(typeof content === "string" ? content : content?.map((part) => part.text).join("\n")).toContain("Required JSON response schema")
        }
        if (gateway && !routed) {
          const body = decode(Schema.Struct({
            response_format: Schema.Struct({
              type: Schema.Literal("json_schema"),
              json_schema: Schema.Struct({ strict: Schema.Literal(true), schema: Schema.Unknown }),
            }),
          }), JSON.parse(text))
          function unsupported(value: unknown): boolean {
            if (Array.isArray(value)) return value.some(unsupported)
            if (!value || typeof value !== "object") return false
            return Object.hasOwn(value, "allOf")
              || Object.hasOwn(value, "minLength") && Object.hasOwn(value, "pattern")
              || Object.values(value).some(unsupported)
          }
          // Reproduce the gateway's rejection instead of accepting any schema.
          if (rejected || unsupported(body.response_format.json_schema.schema)) {
            return Response.json({ error: {
              message: mode === "gateway-unsupported"
                ? "This model does not support structured output. Remove it and retry. PRIVATE_PROVIDER_CANARY"
                : "Invalid schema for response_format 'forge_enhancement': 'allOf' is not permitted. PRIVATE_PROVIDER_CANARY",
              type: "invalid_request_error",
            } }, { status: 400 })
          }
        }
        const shortened = (() => {
          if (mode !== "shortened" && mode !== "schema-shortened") return ""
          const body = decode(Schema.Struct({
            messages: Schema.Array(Schema.Struct({ role: Schema.String, content: Schema.String })),
          }), JSON.parse(text))
          const allowed = body.messages.find((item) => item.role === "system")?.content.match(/Allowed evidence IDs for this revision[^\n]*?: (\[[^\n]*\])/)
          if (!allowed?.at(1)) throw new Error("Expected revision-scoped evidence IDs")
          return decode(Schema.Array(Schema.String), JSON.parse(allowed.at(1)!)).at(0)!.slice(0, -1)
        })()
        return response(
          mode === "malformed" ? '{"summary":"Broken response","objective":"missing closing brace"'
            : variant === "missing" ? JSON.stringify(Object.fromEntries(Object.entries(draft).filter(([key]) => key !== "verification")))
            : variant === "null" ? JSON.stringify({ ...draft, verification: null })
            : variant === "scalar" ? JSON.stringify({ ...draft, verification: "PRIVATE_VERIFICATION_CANARY" })
            : variant === "objects" ? JSON.stringify({ ...draft, verification: [{ command: "PRIVATE_VERIFICATION_CANARY" }] })
            : variant === "mixed" ? JSON.stringify({ ...draft, verification: ["Run existing tests", { action: "PRIVATE_VERIFICATION_CANARY" }] })
            : variant === "strings" ? JSON.stringify({ ...draft, verification: ["Run existing tests"], evidence: ["queue.ts"] })
            : shortened ? JSON.stringify({ ...draft, evidence: [shortened] })
            : mode === "hypothesis" || mode === "invalid-hypothesis" || variant === "blocking" ? JSON.stringify({
              ...draft, evidence: ["queue.ts"],
              hypotheses: [{ statement: "An index may reduce queue latency", reason: "Verify query plans before changing code", ...(mode === "invalid-hypothesis" ? { approval: "Delete" } : {}) }],
              questions: [{ kind: "blocking", question: "May customer records be deleted?", impact: "Deletion cannot be undone", options: ["Retain", "Delete only with explicit authorization"] }],
            })
            : JSON.stringify({ ...draft, evidence: [variant === "citation" ? "invented.ts" : "queue.ts"] }),
          variant === "cutoff" ? "length" : "stop",
        )
      },
    })), (server) => Effect.promise(() => server.stop(true)))
    const configured = yield* requestInDirectory("/config", directory, {
      method: "PATCH", headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({
        ...config,
        provider: { [provider]: {
          npm: gateway ? "@kilocode/kilo-gateway" : "@ai-sdk/openai-compatible",
          options: { baseURL: new URL("/v1", server.url).href, apiKey: "fixture", supportsStructuredOutputs: structured },
          models: {
            model: { name: "Stream fixture", limit: { context: 32000, output: 10000 } },
            large: { name: "Explicit chat model", limit: { context: 32000, output: 16000 } },
            "kilo-auto/free": { name: "Routed free fixture", temperature: true, limit: { context: 64000, output: 16000 } },
          },
        } },
      }),
    })
    expect(configured.status).toBe(200)
    yield* pollWithTimeout(Effect.gen(function* () {
      const result = yield* requestInDirectory("/config/providers", directory, { headers: { authorization } })
      const catalog = decode(Schema.Struct({
        providers: Schema.Array(Schema.Struct({ id: Schema.String, models: Schema.Record(Schema.String, Schema.Unknown) })),
      }), yield* result.json)
      return catalog.providers.some((item) => item.id === provider && item.models.model != null) ? true : undefined
    }), "Configured fixture model is not ready")
    const route = "/forge/enhance/stream"
    expect((yield* requestInDirectory(route, directory, { method: "POST", body: "{}" })).status).toBe(401)
    for (const body of [{ text: "x".repeat(30_001) }, { text: "Inspect this project", session: "ses_missing" }]) {
      const rejected = yield* requestInDirectory(route, directory, {
        method: "POST", headers: { authorization, "content-type": "application/json" }, body: JSON.stringify(body),
      })
      expect(rejected.status).not.toBe(200)
    }
    expect(calls).toHaveLength(0)
    const chat = decode(Schema.Struct({ id: Schema.String }), yield* (yield* requestInDirectory("/session", directory, {
      method: "POST", headers: { authorization },
    })).json)
    const result = yield* requestInDirectory(route, directory, {
      method: "POST", headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({ text: original, session: chat.id, ...(explicit ? { model: { providerID: provider, modelID: id } } : {}) }),
    })
    expect(result.status).toBe(200)
    const frames = yield* result.stream.pipe(
      Stream.decodeText(),
      Stream.pipeThroughChannel(Sse.decode()),
      Stream.map((event) => decode(EnhancementFrame, JSON.parse(event.data))),
      Stream.runCollect,
    )
    expect(frames.some((frame) => frame.type === "progress" && frame.stage.includes(provider))).toBe(true)
    expect(frames.some((frame) => frame.type === "progress" && frame.activity?.entries.some((item) => item.action === "Read locally" && item.path === "queue.ts"))).toBe(true)
    expect(frames.some((frame) => frame.type === "progress" && frame.activity?.entries.some((item) => item.action === "Selected for model" && item.path?.startsWith("queue.ts:")))).toBe(true)
    const final = frames.at(-1)!
    const completed = mode === "ready" || mode === "schema" || mode === "gateway" || mode === "routed" || mode === "shortened" || mode === "schema-shortened" || mode === "hypothesis" || variant === "blocking" || variant === "empty" || variant === "strings"
    if (completed) {
      expect(final.type).toBe("result")
      if (final.type !== "result") throw new Error("Expected a completed proposal")
      expect(final.proposal.summary).toBe(draft.summary)
      expect(final.proposal.original).toBe(original)
      expect(final.proposal.session).toBe(chat.id)
      expect(final.proposal.model).toEqual({ providerID: provider, modelID: id })
      if (explicit) {
        expect(JSON.parse(calls.at(0)!).model).toBe(id)
        const checked = yield* requestInDirectory("/forge/validate", directory, {
          method: "POST", headers: { authorization, "content-type": "application/json" }, body: JSON.stringify(final.proposal),
        })
        expect(decode(Schema.Struct({ valid: Schema.Boolean }), yield* checked.json).valid).toBe(true)
      }
      expect(final.proposal.task.evidence).toEqual(final.proposal.context.matches.map((item) => item.source.id))
      expect(final.proposal.activity?.counts?.repository).toBeGreaterThan(0)
      expect(final.proposal.activity?.counts?.checks).toBeGreaterThan(0)
      if (mode === "shortened" || mode === "schema-shortened") {
        expect(final.proposal.warnings.some((warning) => warning.startsWith("Resolved model citation formatting"))).toBe(true)
      }
      if (mode === "hypothesis" || variant === "blocking") {
        expect(final.proposal.task.hypotheses).toEqual(["An index may reduce queue latency (Verify query plans before changing code)"])
        expect(final.proposal.status).toBe("needs_clarification")
        expect(final.proposal.questions?.at(0)?.optional).toBe(false)
        expect(final.proposal.warnings).toContain("Converted 1 structured hypothesis to text, preserving its statement and reason.")
      }
      expect(frames.some((frame) => frame.type === "progress" && frame.summary === draft.summary)).toBe(true)
    }
    if (!completed) {
      expect(final.type).toBe("error")
      if (final.type !== "error") throw new Error("Expected a safe enhancement error")
      expect(final.message).toContain(mode === "gateway-unsupported" ? "model does not support structured output" : mode === "gateway-rejected" ? "Forge/provider compatibility error" : mode === "invalid-hypothesis" ? "check: hypotheses" : verification ? "check: verification" : variant === "citation" ? "outside this revision" : variant === "cutoff" ? "cut off at its output limit" : "incomplete or invalid JSON")
      expect(final.message).toContain(rejected || variant === "citation" || verification || mode === "invalid-hypothesis" ? "Your prompt and answers were kept" : "Your prompt was kept")
      expect(final.message).not.toContain("SchemaError")
      expect(final.message).not.toContain("PRIVATE_VERIFICATION_CANARY")
      expect(final.failure?.code).toBe(rejected ? "transport" : verification || mode === "invalid-hypothesis" ? "schema" : variant === "citation" ? "citation" : variant === "cutoff" ? "cutoff" : "json")
      expect(final.failure?.model).toBe(`${provider}/${id}`)
      if (rejected) {
        expect(final.failure).toMatchObject({ status: 400, reason: mode === "gateway-unsupported" ? "unsupported-format" : "request-schema" })
        expect(final.message).toContain("HTTP 400")
        expect(final.message.toLowerCase()).toContain("repeating the unchanged request will not fix it")
      }
      if (verification) {
        const index = variant === "objects" ? 0 : variant === "mixed" ? 1 : undefined
        expect(final.failure?.issues).toContainEqual({
          path: index == null ? ["verification"] : ["verification", index], expected: index == null ? "array" : "string",
          actual: variant === "missing" ? "missing" : variant === "null" ? "null" : variant === "scalar" ? "string" : "object",
        })
        expect(final.failure?.finish).toBe("stop")
      }
      expect(frames.some((frame) => frame.type === "result")).toBe(false)
    }
    expect(calls).toHaveLength(1)
    if (routed) expect(JSON.parse(calls.at(0)!).response_format).toBeUndefined()
    if (!routed) expect(calls.at(0)).toContain(structured ? '"response_format":{"type":"json_schema"' : '"response_format":{"type":"json_object"}')
    if (structured) {
      const body = decode(Schema.Struct({
        response_format: Schema.Struct({
          json_schema: Schema.Struct({ schema: Schema.Struct({
            required: Schema.Array(Schema.String),
            properties: Schema.Struct({ evidence: Schema.Unknown }),
          }) }),
        }),
      }), JSON.parse(calls.at(0)!))
      expect(body.response_format.json_schema.schema.required).toEqual(expect.arrayContaining(Object.keys(draft)))
      expect(body.response_format.json_schema.schema.required.at(0)).toBe("summary")
      expect(body.response_format.json_schema.schema.properties.evidence).toMatchObject({
        items: { anyOf: [{ enum: final.type === "result" ? final.proposal.context.matches.map((item) => item.source.id) : expect.arrayContaining([expect.stringMatching(/^[a-f0-9]{24}$/)]) }] },
      })
    }
    expect(calls.at(0)).toContain("Allowed evidence IDs for this revision")
    expect(JSON.stringify(frames)).not.toContain("PRIVATE_REASONING_CANARY")
    expect(JSON.stringify(frames)).not.toContain("PRIVATE_PROVIDER_CANARY")
    expect(JSON.stringify(notices)).not.toContain(draft.summary)
    expect(JSON.stringify(notices)).not.toContain("PRIVATE_REASONING_CANARY")
    const history = yield* requestInDirectory(`/forge/requests?session=${chat.id}`, directory, { headers: { authorization } })
    const records = decode(Schema.Array(Manifest), yield* history.json)
    expect(records).toHaveLength(1)
    expect(records.at(0)?.state).toBe(completed ? "completed" : "failed")
    expect(records.at(0)?.usage.output).toBe(rejected ? 0 : 2)
    if (routed) expect(records.at(0)?.entries.some((entry) => entry.label === "Provider instructions and options" && entry.text === "prompt")).toBe(true)
    if (rejected) {
      expect(records.at(0)?.usage.measured).toBe(false)
      expect(records.at(0)?.attempts?.at(0)?.status).toBe(400)
      expect(JSON.stringify(records)).not.toContain("PRIVATE_PROVIDER_CANARY")
    }
    if (final.type === "error") expect(records.at(0)?.failure).toEqual(final.failure)
  }), {
    config,
    init: (directory) => Effect.promise(async () => {
      await Bun.write(`${directory}/queue.ts`, "export function queue() { return 'queue processing' }\n")
    }),
  }, 30_000)
}
