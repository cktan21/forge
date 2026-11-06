import { afterEach, beforeEach, expect, spyOn } from "bun:test"
import path from "node:path"
import { Cause, Effect, Exit, Fiber } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import * as Tool from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { SemanticSearchTool } from "@/kilocode/tool/semantic-search"
import { KiloIndexing } from "@/kilocode/indexing"
import { EffectBridge } from "@/effect/bridge"
import { SessionID, MessageID } from "@/session/schema"
import { TestInstance } from "../fixture/fixture"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Agent.node, Truncate.node, Config.node])))
const env = { lance: process.env.KILO_LANCEDB_PATH, platform: process.env.KILO_PLATFORM }
const offline = Flag.KILO_DISABLE_MODELS_FETCH
let server: ReturnType<typeof Bun.serve>
let entered = Promise.withResolvers<void>()
let release = Promise.withResolvers<void>()
const calls: string[] = []

beforeEach(() => {
  process.env.KILO_LANCEDB_PATH = new URL(
    "../../../kilo-indexing/node_modules/@lancedb/lancedb/dist/index.js",
    import.meta.url,
  ).pathname
  process.env.KILO_PLATFORM = "cli"
  Flag.KILO_DISABLE_MODELS_FETCH = true
  entered = Promise.withResolvers<void>()
  release = Promise.withResolvers<void>()
  calls.length = 0
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body: { input: string | string[] } = await request.json()
      const texts = Array.isArray(body.input) ? body.input : [body.input]
      calls.push(...texts)
      if (texts.includes("heldquery")) {
        entered.resolve()
        await release.promise
      }
      return Response.json({
        data: texts.map((_, index) => ({ index, embedding: [1, 0, 0] })),
        usage: { prompt_tokens: 1, total_tokens: 1 },
      })
    },
  })
})

afterEach(async () => {
  release.resolve()
  await server.stop(true)
  if (env.lance == null) delete process.env.KILO_LANCEDB_PATH
  else process.env.KILO_LANCEDB_PATH = env.lance
  if (env.platform == null) delete process.env.KILO_PLATFORM
  else process.env.KILO_PLATFORM = env.platform
  Flag.KILO_DISABLE_MODELS_FETCH = offline
})

for (const mode of ["task", "fiber"] as const) {
  it.instance(
    `semantic tool ${mode} cancellation releases real worker before embedding completes`,
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        yield* Effect.promise(() =>
          Bun.write(
            path.join(directory, "file.ts"),
            "export function checkpoint(epoch: number) {\n  return `Current queue lease ${epoch} is checked before dispatch and retry`;\n}\n",
          ),
        )
        yield* pollWithTimeout(
          EffectBridge.fromPromise(async () => {
            const status = await KiloIndexing.current()
            if (status.state === "Error") throw new Error(status.message)
            return status.state === "Complete" ? true : undefined
          }),
          "Index did not become ready",
          "60 seconds",
        )
        const tool = yield* (yield* SemanticSearchTool).init()
        const controller = new AbortController()
        const requests: string[] = []
        const ctx: Tool.Context = {
          sessionID: SessionID.make("ses_tool-cancel"),
          messageID: MessageID.make("msg_tool-cancel"),
          agent: "code",
          abort: controller.signal,
          messages: [],
          metadata: () => Effect.void,
          ask: (request) =>
            Effect.sync(() => {
              requests.push(request.permission)
            }),
        }
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            controller.abort()
            release.resolve()
          }),
        )
        const signals: AbortSignal[] = []
        const search = KiloIndexing.search
        const observer = spyOn(KiloIndexing, "search").mockImplementation((query, prefix, scope, signal) => {
          if (query === "heldquery" && signal) signals.push(signal)
          return search(query, prefix, scope, signal)
        })
        yield* Effect.addFinalizer(() => Effect.sync(() => observer.mockRestore()))
        const pending = yield* tool.execute({ query: "heldquery" }, ctx).pipe(Effect.forkChild)
        yield* awaitWithTimeout(
          Effect.raceFirst(
            Effect.promise(() => entered.promise),
            Fiber.await(pending).pipe(
              Effect.flatMap((exit) =>
                Effect.die(
                  new Error(Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "Tool finished before held embedding"),
                ),
              ),
            ),
          ),
          "Embedding did not start",
          "10 seconds",
        )
        if (mode === "task") controller.abort(new Error("Coding task stopped"))
        if (mode === "fiber") yield* Fiber.interrupt(pending)
        const stopped = yield* awaitWithTimeout(Fiber.await(pending), "Tool did not stop", "1 second")
        expect(Exit.isFailure(stopped)).toBe(true)
        expect(signals).toHaveLength(1)
        expect(signals.at(0)?.aborted).toBe(true)
        const fresh = yield* awaitWithTimeout(
          tool.execute({ query: "freshquery" }, { ...ctx, abort: AbortSignal.any([]) }),
          "Cancelled search still occupies worker queue",
          "1 second",
        )
        expect(fresh.metadata.results.some((item) => item.filePath === "file.ts")).toBe(true)
        expect(fresh.output).toContain("Current queue lease")
        expect(requests).toEqual(["semantic_search", "semantic_search"])
        expect(calls).toContain("freshquery")
        const count = calls.length
        const early = yield* tool
          .execute({ query: "neverquery" }, { ...ctx, abort: AbortSignal.abort() })
          .pipe(Effect.exit)
        expect(Exit.isFailure(early)).toBe(true)
        expect(calls).toHaveLength(count)
        release.resolve()
        const final = yield* tool.execute({ query: "afterrelease" }, { ...ctx, abort: AbortSignal.any([]) })
        expect(final.metadata.results.some((item) => item.filePath === "file.ts")).toBe(true)
        expect(calls).not.toContain("neverquery")
      }),
    {
      config: () => ({
        plugin: ["@kilocode/kilo-indexing"],
        indexing: {
          enabled: true,
          provider: "openai-compatible",
          model: "fixture",
          dimension: 3,
          vectorStore: "lancedb",
          "openai-compatible": { baseUrl: `${server.url}v1` },
        },
      }),
    },
    120_000,
  )
}
