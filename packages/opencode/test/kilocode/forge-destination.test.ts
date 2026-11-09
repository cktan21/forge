import { expect, test } from "bun:test"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Provider } from "@/provider/provider"
import * as Config from "@/config/config"
import { Env } from "@/env"
import { Plugin } from "@/plugin"
import { describe, destination } from "@/kilocode/forge/destination"
import { testEffect } from "../lib/effect"
import { oauth } from "./fixture/forge-oauth"

test("routing fingerprints bind endpoints, model routes, SDKs, and non-secret headers", () => {
  const base = { options: { baseURL: "https://first.example/v1", apiKey: "secret-one" }, models: { small: { api: { url: "https://small.example/v1", npm: "sdk-a" }, headers: { "X-Organization": "one", Authorization: "Bearer secret" } } } }
  const before = describe(base)
  expect(before.origins).toEqual(["https://first.example", "https://small.example"])
  expect(describe({ ...base, options: { ...base.options, apiKey: "rotated" } })).toEqual(before)
  expect(describe({ models: base.models, options: base.options })).toEqual(before)
  for (const changed of [
    { ...base, options: { ...base.options, baseURL: "https://second.example/v1" } },
    { ...base, options: { ...base.options, baseURL: "https://first.example/other" } },
    { ...base, models: { small: { api: { url: "https://other.example/v1", npm: "sdk-a" } } } },
    { ...base, models: { small: { api: { url: "https://small.example/v1", npm: "sdk-b" } } } },
    { ...base, models: { small: { ...base.models.small, headers: { "X-Organization": "two" } } } },
  ]) expect(describe(changed).fingerprint).not.toBe(before.fingerprint)
  expect(JSON.stringify(before)).not.toContain("secret")
  expect(describe({ baseURL: "https://user:secret@first.example/v1?api_key=secret" })).toEqual(describe({ baseURL: "https://first.example/v1" }))
  expect(describe({ baseURL: "https://${HOST}/v1" }, { HOST: "first.example" })).toEqual(describe({ baseURL: "https://first.example/v1" }))
  expect(() => describe({ fetch: () => fetch("https://custom.example") })).toThrow("routing functions")
})

test("the built-in OAuth route is fingerprinted without rejecting its auth adapter", async () => {
  const first = await oauth("https://chatgpt.com/backend-api/codex/responses")
  const second = await oauth("https://chatgpt.com/backend-api/codex/responses")
  const changed = await oauth("https://other.example/responses")
  const before = describe(first.options)
  expect(before.origins).toEqual(["https://chatgpt.com"])
  expect(describe(second.options)).toEqual(before)
  expect(describe(changed.options).fingerprint).not.toBe(before.fingerprint)
  expect(JSON.stringify(before)).not.toContain("fixture-access")
  expect(() => describe({ ...first.options, fetch: () => fetch("https://other.example") })).toThrow("routing functions")
})

const it = testEffect(LayerNode.compile(LayerNode.group([Provider.node, Config.node, Env.node, Plugin.node])))

it.instance("reads effective custom provider routing through the real services", () => Effect.gen(function* () {
  const before = yield* destination("custom")
  expect(before.origins).toContain("https://first.example")
  expect(before.fingerprint).toMatch(/^[a-f0-9]{64}$/)
  const config = yield* Config.Service
  yield* config.update({ provider: { custom: { options: { baseURL: "https://second.example/v1" } } } })
  const after = yield* destination("custom")
  expect(after.fingerprint).not.toBe(before.fingerprint)
  expect(after.origins).toContain("https://second.example")
}), {
  config: {
    provider: {
      custom: {
        name: "Custom",
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: "https://first.example/v1", apiKey: "fixture-secret" },
        models: { model: { name: "Model", limit: { context: 128_000, output: 16_000 } } },
      },
    },
  },
})
