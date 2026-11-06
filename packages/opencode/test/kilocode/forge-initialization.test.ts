import { expect, test, spyOn } from "bun:test"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Forge } from "@/kilocode/forge/service"
import { KiloIndexing } from "@/kilocode/indexing"
import { peek } from "@/kilocode/indexing-observation"
import { EffectBridge } from "@/effect/bridge"
import { Config } from "@/config/config"
import { TestInstance, provideTestInstance, tmpdir } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Forge.node, Config.node])))

it.instance("Forge inspection observes live indexing state without booting it", () => Effect.gen(function* () {
  const { directory } = yield* TestInstance
  const offline = Flag.KILO_DISABLE_MODELS_FETCH
  Flag.KILO_DISABLE_MODELS_FETCH = true
  const fetch = globalThis.fetch
  const network = spyOn(globalThis, "fetch").mockImplementation(Object.assign(() => {
    throw new Error("Inspection must not use the network")
  }, { preconnect: fetch.preconnect }))
  yield* Effect.addFinalizer(() => Effect.sync(() => {
    Flag.KILO_DISABLE_MODELS_FETCH = offline
    const calls = network.mock.calls.length
    network.mockRestore()
    expect(calls).toBe(0)
  }))
  expect(peek(directory)).toBeUndefined()
  const host = yield* Forge.Service
  const api = yield* host.get()
  expect(yield* host.get()).toBe(api)
  for (let index = 0; index < 3; index++) {
    expect((yield* Effect.promise(() => api.status())).semantic).toEqual({ state: "uninitialized", searchable: false })
    yield* Effect.promise(() => api.view({}))
    expect(peek(directory)).toBeUndefined()
  }
  // Explicit owner initialization becomes visible to an already-created engine.
  yield* EffectBridge.fromPromise(() => KiloIndexing.search("disabled initialization control"))
  expect(peek(directory)).toEqual(KiloIndexing.peek(directory))
  expect((yield* Effect.promise(() => api.status())).semantic).toEqual({ state: "disabled", searchable: false })
}), { config: { plugin: [], indexing: { enabled: false } } })

test("lightweight observations follow owner disposal and directory isolation", async () => {
  await using first = await tmpdir({ config: { plugin: [], indexing: { enabled: false } } })
  await using second = await tmpdir({ config: { plugin: [], indexing: { enabled: false } } })
  expect(peek(first.path)).toBeUndefined()
  await provideTestInstance({
    directory: first.path,
    fn: async () => {
      await KiloIndexing.search("disabled initialization control")
      expect(peek(first.path)).toEqual({ initialized: false, state: "Disabled" })
      expect(peek(second.path)).toBeUndefined()
    },
  })
  expect(peek(first.path)).toBeUndefined()
  expect(peek(second.path)).toBeUndefined()
})
