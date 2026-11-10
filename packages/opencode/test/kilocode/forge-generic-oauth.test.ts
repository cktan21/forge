import { afterEach, expect } from "bun:test"
import { ConfigProvider, Effect, Layer } from "effect"
import { pathToFileURL } from "node:url"
import { Auth } from "@/auth"
import { disposeAllInstances, TestInstance, withTmpdirInstance } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import { httpApiLayer, requestInDirectory } from "../server/httpapi-layer"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})
const it = testEffect(
  httpApiLayer.pipe(
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          KILO_SERVER_PASSWORD: "generic-oauth",
          KILO_EXPERIMENTAL_DISABLE_FILEWATCHER: "true",
        }),
      ),
    ),
    Layer.provideMerge(Auth.defaultLayer),
  ),
)

it.live(
  "generic baseline preserves rewrite semantics over the actual ChatGPT streaming adapter",
  () =>
    Effect.gen(function* () {
      const calls: Record<string, unknown>[] = []
      const server = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            async fetch(request) {
              const body: Record<string, unknown> = await request.json()
              calls.push(body)
              expect(body).toMatchObject({ stream: true, store: false, model: "gpt-5.6-sol" })
              expect(String(body.instructions)).toContain("Return only the enhanced prompt")
              expect(body).not.toHaveProperty("max_output_tokens")
              expect(body).not.toHaveProperty("temperature")
              expect(request.headers.get("authorization")).toBe("Bearer fixture-access")
              const item = { type: "message", id: "message" }
              const events = [
                { type: "response.created", response: { id: "response", created_at: 1, model: "gpt-5.6-sol" } },
                { type: "response.output_item.added", output_index: 0, item },
                {
                  type: "response.output_text.delta",
                  item_id: item.id,
                  delta: "Implement queue pagination according to the documented contract.",
                },
                { type: "response.output_item.done", output_index: 0, item },
                { type: "response.completed", response: { usage: { input_tokens: 30, output_tokens: 20 } } },
              ]
              return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
                headers: { "content-type": "text/event-stream" },
              })
            },
          }),
        ),
        (server) => Effect.promise(() => server.stop(true)),
      )
      yield* (yield* Auth.Service).set("generic-oauth", {
        type: "oauth",
        access: "fixture-access",
        refresh: "fixture-refresh",
        expires: Date.now() + 60_000,
      })
      yield* Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const result = yield* requestInDirectory("/forge/baseline", directory, {
          method: "POST",
          headers: {
            authorization: `Basic ${Buffer.from("kilo:generic-oauth").toString("base64")}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ text: "Implement queue pagination." }),
        })
        expect(result.status).toBe(200)
        expect(yield* result.json).toMatchObject({
          text: "Implement queue pagination according to the documented contract.",
          usage: { input: 30, output: 20, model: "generic-oauth/gpt-5.6-sol" },
        })
        expect(calls).toHaveLength(1)
      }).pipe(
        withTmpdirInstance({
          init: (directory) =>
            Effect.promise(async () => {
              const plugin = `${directory}/oauth.ts`
              await Bun.write(`${directory}/queue.ts`, "export const queue = []\n")
              await Bun.write(
                plugin,
                [
                  `import { oauth } from ${JSON.stringify(import.meta.resolve("./fixture/forge-oauth"))}`,
                  `export default async () => ({ auth: { provider: "generic-oauth", methods: [], loader: async () => (await oauth(${JSON.stringify(new URL("/responses", server.url).href)})).options } })`,
                ].join("\n"),
              )
              await Bun.write(
                `${directory}/opencode.json`,
                JSON.stringify({
                  formatter: false,
                  lsp: false,
                  enabled_providers: ["generic-oauth"],
                  model: "generic-oauth/gpt-5.6-sol",
                  small_model: "generic-oauth/gpt-5.6-sol",
                  plugin: [pathToFileURL(plugin).href],
                  provider: {
                    "generic-oauth": {
                      npm: "@ai-sdk/openai",
                      options: { baseURL: new URL("/v1", server.url).href },
                      models: {
                        "gpt-5.6-sol": { name: "OAuth generic fixture", limit: { context: 128_000, output: 5000 } },
                      },
                    },
                  },
                }),
              )
            }),
        }),
      )
    }),
  30_000,
)
