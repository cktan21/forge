import { afterEach, expect } from "bun:test"
import { ConfigProvider, Effect, Layer, Schema } from "effect"
import { Manifest, Proposal, RequestObservation, decode } from "@kilocode/forge/schema"
import { reconcile } from "@kilocode/forge/model-accounting"
import { disposeAllInstances, TestInstance, withTmpdirInstance } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "../server/httpapi-layer"
import { response as streamed } from "./forge-model-stream"

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})
const it = testEffect(
  httpApiLayer.pipe(
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          KILO_SERVER_PASSWORD: "response-fixture",
          KILO_EXPERIMENTAL_DISABLE_FILEWATCHER: "true",
        }),
      ),
    ),
  ),
)
const authorization = `Basic ${Buffer.from("kilo:response-fixture").toString("base64")}`
const config = {
  formatter: false as const,
  lsp: false as const,
  enabled_providers: ["fixture"],
  model: "fixture/model",
  small_model: "fixture/model",
}
const draft = {
  objective: "Implement the original request",
  reuse: [],
  inspect: [],
  changes: [],
  constraints: [],
  hypotheses: [],
  questions: [],
  acceptance: [],
  verification: [],
  evidence: [],
}

for (const mode of ["retry", "failure", "disabled"] as const) {
  const provider = `fixture-${mode}`
  const setup = {
    ...config,
    enabled_providers: [provider],
    model: `${provider}/model`,
    small_model: `${provider}/model`,
  }
  it.live(
    `actual preparation HTTP retains ${mode} usage for both enhancers`,
    () =>
      Effect.gen(function* () {
        if (mode === "disabled")
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              const previous = process.env.KILO_FORGE_DISABLED
              process.env.KILO_FORGE_DISABLED = "1"
              return previous
            }),
            (previous) =>
              Effect.sync(() => {
                if (previous == null) {
                  delete process.env.KILO_FORGE_DISABLED
                  return
                }
                process.env.KILO_FORGE_DISABLED = previous
              }),
          )
        const calls: Array<{ generic: boolean; body: string }> = []
        const server = yield* Effect.acquireRelease(
          Effect.sync(() =>
            Bun.serve({
              hostname: "127.0.0.1",
              port: 0,
              async fetch(request) {
                const body = await request.text()
                const generic = body.includes("You rewrite draft user prompts")
                const previous = calls.filter((call) => call.generic === generic).length
                calls.push({ generic, body })
                if (mode === "failure")
                  return Response.json(
                    { error: { message: "Fixture rejection", type: "invalid_request_error" } },
                    { status: 400 },
                  )
                if (previous === 0)
                  return Response.json({ error: { message: "Fixture retry", type: "server_error" } }, { status: 503 })
                if (!generic)
                  return streamed(
                    JSON.stringify({
                      ...draft,
                      summary: "I will preserve the original requirements and tailor examples to the audience.",
                      questions: [
                        {
                          kind: "clarify",
                          question: "Which audience?",
                          impact: "Sets the examples.",
                          options: ["Developers", "Users"],
                        },
                      ],
                    }),
                  )
                return Response.json({
                  id: "fixture",
                  created: 1,
                  model: "model",
                  object: "chat.completion",
                  choices: [
                    {
                      index: 0,
                      message: {
                        role: "assistant",
                        content: generic
                          ? "Generic response output canary"
                          : JSON.stringify({
                              ...draft,
                              questions: [
                                {
                                  kind: "clarify",
                                  question: "Which audience?",
                                  impact: "Sets the examples.",
                                  options: ["Developers", "Users"],
                                },
                              ],
                            }),
                      },
                      finish_reason: "stop",
                    },
                  ],
                  usage: {
                    prompt_tokens: 10,
                    completion_tokens: 2,
                    total_tokens: 12,
                    prompt_tokens_details: { cached_tokens: 0 },
                  },
                })
              },
            }),
          ),
          (server) => Effect.promise(() => server.stop(true)),
        )
        // Configure the transport before either the HTTP or legacy baseline
        // runtime loads provider state; this test is not a config-reload test.
        yield* Effect.gen(function* () {
          const { directory } = yield* TestInstance
          const call = (route: string, body?: unknown) =>
            requestInDirectory(route, directory, {
              method: body == null ? "GET" : "POST",
              headers: { authorization, "content-type": "application/json" },
              ...(body == null ? {} : { body: JSON.stringify(body) }),
            })
          yield* pollWithTimeout(
            Effect.gen(function* () {
              const response = yield* call("/config/providers")
              const catalog = decode(
                Schema.Struct({
                  providers: Schema.Array(
                    Schema.Struct({ id: Schema.String, models: Schema.Record(Schema.String, Schema.Unknown) }),
                  ),
                }),
                yield* response.json,
              )
              return catalog.providers.some((item) => item.id === provider && item.models.model != null)
                ? true
                : undefined
            }),
            "Configured fixture model is not ready",
          )
          expect((yield* requestInDirectory("/forge/requests-observation", directory)).status).toBe(401)
          const initial = decode(RequestObservation, yield* (yield* call("/forge/requests-observation")).json)
          expect(initial).toMatchObject({ admitted: 0, deleted: false })
          for (const route of ["/forge/enhance", "/forge/baseline"]) {
            const input = {
              text: "Keep the original request authoritative",
              ...(route === "/forge/enhance"
                ? {
                    answers: "Keep compatibility.",
                    feedback: "Add accessibility examples.",
                    revision: "Previous AI proposal canary",
                  }
                : {}),
            }
            const first = yield* call(route, input)
            if (mode === "retry" && route === "/forge/enhance") {
              expect(first.status).toBe(500)
              expect(calls.filter((call) => !call.generic)).toHaveLength(1)
              const error = yield* first.json
              expect(error).toMatchObject({ failure: { code: "transport", status: 503, reason: "unavailable" } })
            }
            const response = mode === "retry" && route === "/forge/enhance" ? yield* call(route, input) : first
            expect(response.status).toBe(mode === "retry" ? 200 : 500)
            if (mode === "failure")
              expect(yield* response.text).toContain(
                route === "/forge/enhance" ? "rejected the request parameters" : "Fixture rejection",
              )
            if (mode === "disabled") expect(yield* response.text).toContain("capture is unavailable")
            if (mode === "retry" && route === "/forge/enhance") {
              const proposal = decode(Proposal, yield* response.json)
              expect(proposal.original).toBe("Keep the original request authoritative")
              expect(proposal.status).toBe("ready")
              expect(proposal.task.questions).toEqual([])
              expect(proposal.questions?.at(0)).toMatchObject({
                question: "Which audience?",
                optional: true,
                options: ["Developers", "Users"],
              })
              expect(proposal.prompt).toContain("Keep compatibility.")
              expect(proposal.prompt).toContain("Add accessibility examples.")
              expect(proposal.prompt).not.toContain("Previous AI proposal canary")
              const body = calls.findLast((call) => !call.generic)?.body
              expect(body).toContain("Previous proposed prompt (non-authoritative)")
              expect(body).toContain("Previous AI proposal canary")
              expect(body).toContain("Add accessibility examples.")
            }
          }
          const response = yield* call("/forge/requests")
          const records = decode(Schema.Array(Manifest), yield* response.json)
          if (mode === "disabled") {
            expect(calls).toHaveLength(0)
            expect(records.every((record) => (record.attempts?.length ?? 0) === 0)).toBe(true)
            return
          }
          expect(records.map((record) => record.purpose).sort()).toEqual(
            mode === "retry" ? ["enhance", "enhance", "generic-enhance"] : ["enhance", "generic-enhance"],
          )
          const final = decode(RequestObservation, yield* (yield* call("/forge/requests-observation")).json)
          expect(final).toMatchObject({ admitted: mode === "retry" ? 3 : 2, deleted: false, since: initial.since })
          expect(final.revision).not.toBe(initial.revision)
          for (const purpose of ["generic-enhance", "enhance"]) {
            const record = records.find(
              (record) => record.purpose === purpose && (mode !== "retry" || record.state === "completed"),
            )!
            expect(record).toBeDefined()
            expect(record.state).toBe(mode === "failure" ? "failed" : "completed")
            expect(record.attempts?.map((attempt) => attempt.status)).toEqual(
              mode === "failure" ? [400] : purpose === "enhance" ? [200] : [503, 200],
            )
            expect(reconcile(record).complete).toBe(mode === "retry" && purpose === "enhance")
            expect(reconcile(record).usage).toMatchObject({
              input: mode === "failure" ? 0 : 10,
              output: mode === "failure" ? 0 : 2,
            })
            expect(record.attempts?.at(-1)?.response?.state).toBe("completed")
          }
          if (mode === "retry") {
            const failed = records.find((record) => record.purpose === "enhance" && record.state === "failed")!
            expect(failed.attempts?.map((attempt) => attempt.status)).toEqual([503])
            expect(failed.failure?.code).toBe("transport")
            expect(reconcile(failed).complete).toBe(false)
          }
          expect(JSON.stringify(records)).not.toContain("Generic response output canary")
          expect(calls.filter((call) => call.generic)).toHaveLength(mode === "failure" ? 1 : 2)
          expect(calls.filter((call) => !call.generic)).toHaveLength(mode === "failure" ? 1 : 2)
        }).pipe(
          withTmpdirInstance({
            config: {
              ...setup,
              provider: {
                [provider]: {
                  npm: "@ai-sdk/openai-compatible",
                  options: { baseURL: new URL("/v1", server.url).href, apiKey: "fixture" },
                  models: { model: { name: "Fixture", limit: { context: 32000, output: 1000 } } },
                },
              },
            },
          }),
        )
      }),
    30_000,
  )
}
