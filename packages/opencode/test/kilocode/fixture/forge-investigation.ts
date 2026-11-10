import { expect } from "bun:test"
import { Schema } from "effect"
import { decode } from "@kilocode/forge"

const Request = Schema.Struct({
  messages: Schema.Array(Schema.Struct({ role: Schema.String, content: Schema.Unknown })),
  tools: Schema.optional(
    Schema.Array(Schema.Struct({ function: Schema.Struct({ name: Schema.String, parameters: Schema.Unknown }) })),
  ),
  tool_choice: Schema.optional(Schema.Unknown),
  max_tokens: Schema.optional(Schema.Number),
  max_completion_tokens: Schema.optional(Schema.Number),
  parallel_tool_calls: Schema.optional(Schema.Boolean),
  reasoning: Schema.optional(
    Schema.Struct({
      max_tokens: Schema.Number,
      effort: Schema.optional(Schema.String),
      exclude: Schema.optional(Schema.Boolean),
    }),
  ),
})
type Call = { name: string; input: unknown }
type Context = { body: typeof Request.Type; count: number; source?: { id: string }; final: boolean }
type Scenario = {
  name: string
  output?: number
  npm?: string
  alias?: string
  deny?: boolean
  unsupported?: boolean
  reasoning?: boolean
  quiet?: boolean
  cutoff?: boolean
  check?: (body: typeof Request.Type) => void
  respond?: (context: Context) => Response | undefined
  calls?: (context: Context) => Call[]
}

function response(
  calls: Call[],
  content: string | null,
  count: number,
  finish = calls.length ? "tool_calls" : "stop",
  writing = false,
) {
  return Response.json({
    id: `completion-${count}`,
    object: "chat.completion",
    created: 1,
    model: "model",
    choices: [
      {
        index: 0,
        finish_reason: finish,
        message: {
          role: "assistant",
          content,
          reasoning: "PRIVATE_REASONING_CANARY",
          reasoning_content: "PRIVATE_REASONING_CANARY",
          ...(calls.length
            ? {
                tool_calls: calls.map((call, index) => ({
                  id: `tool-${count}-${index}`,
                  type: "function",
                  function: { name: call.name, arguments: JSON.stringify(call.input) },
                })),
              }
            : {}),
        },
      },
    ],
    usage: writing
      ? { prompt_tokens: 150, completion_tokens: 70, total_tokens: 220 }
      : { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 },
  })
}

function reject(status: number, message: string) {
  return Response.json({ error: { message } }, { status })
}

function read(path = "queue.ts", purpose?: string): Call {
  return { name: "forge_read_file", input: { path, ...(purpose ? { purpose } : {}) } }
}

function finish(source: { id: string }, mode: "ready" | "partial" | "unresolved" | "metadata" = "ready"): Call {
  const finding = {
    title: "Duplicate return value",
    kind: mode === "unresolved" ? "improvement" : "defect",
    support: mode === "unresolved" ? "unresolved" : "observed",
    explanation: "enqueue returns two copies of its input.",
    benefit: "Prevent duplicated work.",
    evidence: [source.id],
    counterevidence: [],
    unknowns: mode === "unresolved" ? ["The throughput impact has not been measured."] : [],
    action: "Return one item per enqueue.",
    verification: ["Add a regression for a single identifier."],
    ...(mode === "metadata" ? { id: "MODEL_ID_CANARY", confidence: 0.8, extra: "EXTRA_METADATA_CANARY" } : {}),
  }
  return {
    name: "forge_finish",
    input: {
      intent: "Fix duplicated queue entries",
      summary: "The implementation returns the same identifier twice.",
      findings: mode === "partial" ? [{ ...finding, action: null }, finding] : [finding],
      questions: [],
      limitations: ["Tests have not been run."],
    },
  }
}

function next(context: Context) {
  return [context.source ? finish(context.source) : read()]
}

function clarification(optional: unknown, malformed = false) {
  return (context: Context) => {
    if (!context.body.tools) return undefined
    expect(context.body.tool_choice).toBe("auto")
    expect(context.body.tools.find((item) => item.function.name === "forge_finish")).toMatchObject({
      function: {
        parameters: {
          properties: {
            questions: {
              maxItems: 12,
              items: {
                required: ["id", "question", "impact", "options", "optional"],
                properties: {
                  when: {
                    anyOf: [
                      expect.objectContaining({
                        properties: {
                          question: { type: "string" },
                          options: expect.objectContaining({ type: "array" }),
                        },
                      }),
                      { type: "null" },
                    ],
                  },
                },
              },
            },
          },
        },
      },
    })
    return response(
      [
        {
          name: "forge_finish",
          input: {
            intent: "Clarify the backend target",
            summary: "The failing behavior is not specified.",
            findings: malformed ? [{ action: null }] : [],
            limitations: ["No code has been inspected."],
            questions: [
              {
                id: "scope",
                question: "Which backend behavior should change?",
                impact: "Selects the target.",
                options: ["Fix a failing request", "Improve a specific operation"],
                when: null,
                ...(optional === undefined ? {} : { optional }),
              },
              {
                id: "request",
                question: "Which request fails?",
                impact: "Narrows the selected request behavior.",
                options: ["Session creation", "Response streaming"],
                optional: false,
                when: { question: "scope", options: ["Fix a failing request"] },
              },
            ],
          },
        },
      ],
      null,
      context.count,
    )
  }
}

export const scenarios: Scenario[] = [
  { name: "ready" },
  { name: "small-output", output: 2000 },
  { name: "quiet", quiet: true },
  {
    name: "purpose",
    quiet: true,
    calls: (ctx) => (ctx.source ? next(ctx) : [read("queue.ts", "Compare queue behavior before recommending a fix.")]),
  },
  { name: "stream" },
  {
    name: "auto",
    alias: "kilo-auto/free",
    npm: "@kilocode/kilo-gateway",
    respond: (ctx) =>
      ctx.body.tools && ctx.body.tool_choice !== "auto"
        ? reject(400, "This model does not support a required or named tool choice. Remove it and retry.")
        : undefined,
  },
  {
    name: "public",
    check: (body) => {
      if (body.tools) expect(body.tool_choice).toBe("auto")
    },
    respond: (ctx) => (ctx.body.tools ? response([], "Which backend behavior should change?", ctx.count) : undefined),
  },
  { name: "partial", calls: (ctx) => (ctx.source ? [finish(ctx.source, "partial")] : next(ctx)) },
  { name: "unresolved", calls: (ctx) => (ctx.source ? [finish(ctx.source, "unresolved")] : next(ctx)) },
  { name: "metadata", calls: (ctx) => (ctx.source ? [finish(ctx.source, "metadata")] : next(ctx)) },
  {
    name: "serial",
    npm: "@openrouter/ai-sdk-provider",
    check: (body) => {
      if (body.tools) expect(body.parallel_tool_calls).toBe(false)
    },
  },
  {
    name: "reasoning",
    npm: "@openrouter/ai-sdk-provider",
    reasoning: true,
    check: (body) => {
      expect(body.reasoning).toMatchObject({ max_tokens: 1024, exclude: true })
      expect(body.reasoning?.effort).toBeUndefined()
    },
  },
  { name: "clarify", respond: clarification(false) },
  { name: "clarify-missing", respond: clarification(undefined) },
  { name: "clarify-malformed", respond: clarification(false, true) },
  { name: "clarify-invalid", respond: clarification("false") },
  {
    name: "symbol",
    calls: (ctx) =>
      ctx.source && ctx.count === 2 ? [{ name: "forge_get_symbol", input: { id: ctx.source.id } }] : next(ctx),
  },
  { name: "read-error", calls: (ctx) => (ctx.count === 1 ? [read("missing.ts")] : next(ctx)) },
  {
    name: "source-error",
    calls: (ctx) => (ctx.count === 1 ? [{ name: "forge_get_symbol", input: { id: "missing" } }] : next(ctx)),
  },
  { name: "batch", calls: (ctx) => (ctx.source ? next(ctx) : [read(), read(), read()]) },
  { name: "finish-batch", calls: (ctx) => (ctx.source && ctx.count === 2 ? [finish(ctx.source), read()] : next(ctx)) },
  { name: "duplicate-finish", calls: (ctx) => (ctx.source ? [finish(ctx.source), finish(ctx.source)] : next(ctx)) },
  { name: "bounded", calls: (ctx) => (ctx.final && ctx.source ? [finish(ctx.source)] : [read()]) },
  { name: "rejected", respond: () => reject(429, "Too many requests PRIVATE_PROVIDER_CANARY") },
  { name: "cutoff", cutoff: true },
  {
    name: "malformed",
    calls: () => [{ name: "forge_finish", input: { intent: 42, PRIVATE_KEY_CANARY: "PRIVATE_MODEL_CANARY" } }],
  },
  {
    name: "writer-rejected",
    respond: (ctx) => (!ctx.body.tools ? reject(401, "Invalid API key PRIVATE_WRITER_CANARY") : undefined),
  },
  { name: "denied", deny: true },
  { name: "unsupported", unsupported: true },
]

export function model(scenario: Scenario) {
  const bodies: Array<typeof Request.Type> = []
  return {
    bodies,
    fetch: async (request: globalThis.Request) => {
      const body = decode(Request, await request.json())
      bodies.push(body)
      expect(body.max_tokens ?? body.max_completion_tokens).toBe(Math.min(8000, scenario.output ?? 16_000))
      scenario.check?.(body)
      const final = body.tools?.length === 1 && body.tools.at(0)?.function.name === "forge_finish"
      const last = body.messages.findLast((item) => item.role === "tool")
      const source =
        last && typeof last.content === "string"
          ? decode(
              Schema.Struct({ source: Schema.optional(Schema.Struct({ id: Schema.String })) }),
              JSON.parse(last.content),
            ).source
          : undefined
      const context = { body, count: bodies.length, source, final }
      const custom = scenario.respond?.(context)
      if (custom) return custom
      if (!body.tools) {
        const user = body.messages.findLast((item) => item.role === "user")?.content
        if (typeof user !== "string") throw new Error("Expected writer input")
        const data = decode(
          Schema.Struct({
            requirements: Schema.Array(Schema.Struct({ id: Schema.String })),
            sources: Schema.Array(Schema.Struct({ id: Schema.String })),
          }),
          JSON.parse(user),
        )
        expect(user).not.toContain("return [id, id]")
        return response(
          [],
          JSON.stringify({
            objective: "Fix the duplicate queue return value.",
            basis: "The inspected function duplicates its identifier. Tests remain to be run.",
            changes: ["Return one identifier and add a regression test."],
            constraints: [],
            verification: ["Proposed: test a single enqueue call."],
            evidence: data.sources.map((item) => item.id),
            requirements: data.requirements.map((item) => item.id),
          }),
          bodies.length,
          "stop",
          true,
        )
      }
      const system = JSON.stringify(body.messages.find((item) => item.role === "system")?.content)
      expect(system).toContain("The deliverable is a clearer task, not a solved task")
      expect(system).toContain("Preparation checkpoint:")
      if (final) {
        expect(system).toContain("final allowed investigation turn")
        expect(system).toContain("return a concise unresolved diagnostic direction")
      }
      expect(body.tool_choice).toEqual(final ? { type: "function", function: { name: "forge_finish" } } : "auto")
      expect(body.tools.map((item) => item.function.name).sort()).toEqual(
        final
          ? ["forge_finish"]
          : [
              "forge_finish",
              "forge_get_symbol",
              "forge_lookup",
              "forge_read_file",
              "forge_relationships",
              "forge_search_code",
              "forge_search_docs",
            ],
      )
      if (!final)
        expect(body.tools.find((item) => item.function.name === "forge_read_file")).toMatchObject({
          function: {
            parameters: { required: ["path", "purpose"], properties: { path: { pattern: "^[\\s\\S]*\\S[\\s\\S]*$" } } },
          },
        })
      const calls = (scenario.calls ?? next)(context)
      return response(
        calls,
        scenario.quiet
          ? null
          : calls.some((call) => call.name === "forge_finish")
            ? "<tool_call>RAW_CALL_CANARY</tool_call>"
            : "I will inspect queue.ts to check duplicate entries.",
        bodies.length,
        scenario.cutoff ? "length" : "tool_calls",
      )
    },
  }
}
