import { afterEach, beforeEach, expect, spyOn } from "bun:test"
import { randomUUID } from "node:crypto"
import path from "node:path"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { Flag } from "@opencode-ai/core/flag/flag"
import {
  CodeIndexConfigManager,
  CodeIndexManager,
  CodeIndexSearchService,
  CodeIndexServiceFactory,
  CodeIndexStateManager,
  type PointStruct,
} from "@kilocode/kilo-indexing/engine"
import { normalizeIndexingStatus } from "@kilocode/kilo-indexing/status"
import { LanceDBVectorStore } from "../../../kilo-indexing/src/indexing/vector-store/lancedb-vector-store"
import { Forge } from "@/kilocode/forge/service"
import { EffectBridge } from "@/effect/bridge"
import { authorize } from "@/kilocode/forge/access"
import { Config } from "@/config/config"
import { Git } from "@/git"
import { Session } from "@/session/session"
import { Agent } from "@/agent/agent"
import { KiloIndexing } from "@/kilocode/indexing"
import { IndexingWorker } from "@/kilocode/indexing-worker-client"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Forge.node, Config.node, Git.node, Session.node, Agent.node])))
const stores = new Map<string, LanceDBVectorStore>()
const configs = new Map<string, CodeIndexConfigManager>()
const calls: string[] = []
const gates = new Map<
  string,
  { entered: ReturnType<typeof Promise.withResolvers<void>>; release: ReturnType<typeof Promise.withResolvers<void>> }
>()
const searches = new Map<string, { signal?: AbortSignal; pending: Promise<unknown> }>()
const env = { lance: process.env.KILO_LANCEDB_PATH, platform: process.env.KILO_PLATFORM }
const offline = Flag.KILO_DISABLE_MODELS_FETCH
const fetch = globalThis.fetch
let network = spyOn(globalThis, "fetch")

function point(filePath: string, codeChunk: string, offset = 0, start = 1, end = 1): PointStruct {
  return {
    id: randomUUID(),
    vector: [1, offset],
    payload: { filePath, codeChunk, fileHash: "fixture-index-version", startLine: start, endLine: end },
  }
}

beforeEach(() => {
  // Resolve installed native code explicitly: host ensure() must never install it.
  process.env.KILO_LANCEDB_PATH = new URL(
    "../../../kilo-indexing/node_modules/@lancedb/lancedb/dist/index.js",
    import.meta.url,
  ).pathname
  process.env.KILO_PLATFORM = "cli"
  Flag.KILO_DISABLE_MODELS_FETCH = true
  network = spyOn(globalThis, "fetch")
  network.mockImplementation(
    Object.assign(
      () => {
        throw new Error("Network forbidden in semantic boundary tests")
      },
      { preconnect: fetch.preconnect },
    ),
  )
  calls.length = 0
  gates.clear()
  searches.clear()
  IndexingWorker.override((directory, root) => {
    const store = new LanceDBVectorStore(directory, 2, root)
    const state = new CodeIndexStateManager()
    const cfg = new CodeIndexConfigManager({
      enabled: true,
      embedderProvider: "ollama",
      vectorStoreProvider: "lancedb",
      searchMaxResults: 3,
      searchMinScore: 0,
    })
    const search = new CodeIndexSearchService(
      cfg,
      state,
      {
        async createEmbeddings(texts) {
          calls.push(...texts)
          for (const text of texts) {
            const gate = gates.get(text)
            if (!gate) continue
            gate.entered.resolve()
            await gate.release.promise
          }
          return { embeddings: texts.map(() => [1, 0]) }
        },
        async validateConfiguration() {
          throw new Error("Provider validation is not part of this offline fixture")
        },
        embedderInfo: { name: "ollama" },
      },
      store,
    )
    stores.set(directory, store)
    configs.set(directory, cfg)
    return {
      async init() {
        await store.initialize()
        await store.markIndexingComplete()
        state.setSystemState("Indexed")
        return {
          state: "Complete",
          message: "Locally seeded vector fixture",
          processedFiles: 0,
          totalFiles: 0,
          percent: 100,
        }
      },
      search(query, prefix, scope, signal) {
        const pending = search.searchIndex(query, prefix, scope, signal)
        searches.set(query, { signal, pending })
        return pending
      },
      async dispose() {
        state.dispose()
        await store.close()
      },
    }
  })
})

afterEach(async () => {
  IndexingWorker.override()
  for (const store of stores.values()) await store.close()
  stores.clear()
  configs.clear()
  const attempted = network.mock.calls.length
  network.mockRestore()
  Flag.KILO_DISABLE_MODELS_FETCH = offline
  if (env.lance == null) delete process.env.KILO_LANCEDB_PATH
  else process.env.KILO_LANCEDB_PATH = env.lance
  if (env.platform == null) delete process.env.KILO_PLATFORM
  else process.env.KILO_PLATFORM = env.platform
  expect(attempted).toBe(0)
})

const options = {
  config: {
    plugin: ["@kilocode/kilo-indexing"],
    indexing: { enabled: true, provider: "ollama" as const, vectorStore: "lancedb" as const },
  },
}

it.instance(
  "Forge cancellation reaches the initialized semantic search before held embedding completes",
  () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const text = "export const checkpoint = 'Current queue lease is checked before dispatch and retry'"
      yield* Effect.promise(() => Bun.write(path.join(directory, "queue.ts"), text))
      yield* EffectBridge.fromPromise(() => KiloIndexing.search("initialize"))
      const api = yield* (yield* Forge.Service).get()
      yield* Effect.promise(() => api.refresh())
      yield* Effect.promise(() => stores.get(directory)!.upsertPoints([point("queue.ts", text)]))
      const gate = { entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() }
      gates.set("cancelledquery", gate)
      const controller = new AbortController()
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          controller.abort()
          gate.release.resolve()
        }),
      )
      yield* Effect.promise(async () => {
        const pending = api.retrieve("cancelledquery", { provider: "", signal: controller.signal }).then(
          (value) => value,
          (err: unknown) => err,
        )
        const deadline = Promise.withResolvers<undefined>()
        const timer = setTimeout(() => deadline.resolve(undefined), 5000)
        try {
          expect(await Promise.race([gate.entered.promise.then(() => true), deadline.promise])).toBe(true)
          const active = searches.get("cancelledquery")!
          expect(active.signal).toBeInstanceOf(AbortSignal)
          const reason = new Error("Preparation closed")
          controller.abort(reason)
          expect(active.signal?.aborted).toBe(true)
          const stopped = Promise.withResolvers<undefined>()
          const timer = setTimeout(() => stopped.resolve(undefined), 1000)
          try {
            expect(await Promise.race([active.pending.catch((err: unknown) => err), stopped.promise])).toBe(
              active.signal?.reason,
            )
            expect(await Promise.race([pending, stopped.promise])).toBe(reason)
          } finally {
            clearTimeout(timer)
          }
          const fresh = await api.retrieve("freshquery", { provider: "" })
          expect(fresh.audit?.channels?.find((item) => item.name === "semantic")?.state).toBe("completed")
        } finally {
          clearTimeout(timer)
          controller.abort()
          gate.release.resolve()
          await pending
        }
      })
    }),
  options,
  30_000,
)

it.instance(
  "initialized semantic search preserves valid double-dot filenames at the result limit",
  () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const text = "export const boundary = 'in-root original passage'"
      yield* Effect.promise(() => Bun.write(path.join(directory, "..helpers.ts"), text))
      yield* EffectBridge.fromPromise(() => KiloIndexing.search("initialize"))
      expect(KiloIndexing.peek(directory)).toEqual({ initialized: true, state: "Complete" })
      const api = yield* (yield* Forge.Service).get()
      const snapshot = yield* Effect.promise(() => api.refresh())
      const file = snapshot.sources.find((item) => item.uri === "..helpers.ts" && item.method === "file")!
      expect(file).toBeDefined()
      const store = stores.get(directory)!
      configs
        .get(directory)!
        .loadConfiguration({
          enabled: true,
          embedderProvider: "ollama",
          vectorStoreProvider: "lancedb",
          searchMaxResults: 1,
          searchMinScore: 0,
        })
      for (const uri of ["..helpers.ts", path.join(directory, "..helpers.ts")]) {
        yield* Effect.promise(() => store.clearCollection())
        yield* Effect.promise(() =>
          store.upsertPoints([point(uri, text), point("../foreign.ts", "foreigncanary", 0.1)]),
        )
        const raw = yield* Effect.promise(() => KiloIndexing.search("orthogonalquery"))
        expect(raw).toHaveLength(1)
        expect(raw.at(0)?.payload?.filePath).toBe(uri)
        const result = yield* Effect.promise(() => api.retrieve("orthogonalquery", { provider: "" }))
        expect(result.audit?.channels?.find((item) => item.name === "semantic")).toMatchObject({
          state: "completed",
          candidates: 1,
          readiness: { state: "ready", searchable: true },
        })
        expect(result.matches.map((item) => item.source.id)).toContain(file.id)
        expect(result.matches.find((item) => item.source.id === file.id)?.source).toMatchObject({
          uri: file.uri,
          hash: file.hash,
          text,
          method: "file",
        })
        expect(result.text).not.toContain("foreigncanary")
      }
    }),
  options,
  30_000,
)

it.instance(
  "strict eligibility precedes initialized vector limits and retains lexical fallback",
  () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const allowed = "export const allowed = 'fallbackcanary current evidence'"
      const excluded = "export const excluded = 'excludedcanary'"
      yield* Effect.promise(() =>
        Promise.all([
          Bun.write(path.join(directory, "allowed.ts"), allowed),
          Bun.write(path.join(directory, "excluded.ts"), excluded),
          Bun.write(path.join(directory, "stale.ts"), "export const current = 'replacementcanary'"),
          Bun.write(path.join(directory, "ignored.ts"), "ignoredcanary"),
          Bun.write(path.join(directory, ".kilocodeignore"), "ignored.ts\n"),
        ]),
      )
      yield* EffectBridge.fromPromise(() => KiloIndexing.search("initialize"))
      const api = yield* (yield* Forge.Service).get()
      const snapshot = yield* Effect.promise(() => api.refresh())
      const omitted = snapshot.sources.find((item) => item.uri === "excluded.ts" && item.method === "file")!
      const exclude = snapshot.sources.filter((item) => item.uri === "excluded.ts").map((item) => item.id)
      const file = snapshot.sources.find((item) => item.uri === "allowed.ts" && item.method === "file")!
      expect(snapshot.sources.some((item) => item.uri === "ignored.ts")).toBe(false)
      const store = stores.get(directory)!
      const points = [
        point("excluded.ts", excluded),
        point("ignored.ts", "ignoredcanary", 0.1),
        point("stale.ts", "stalecanary", 0.2),
        point("allowed.ts", allowed, 0.8),
      ]
      yield* Effect.promise(() => store.upsertPoints(points))
      const foreign = new LanceDBVectorStore(`${directory}-foreign`, 2, path.join(Global.Path.state, "indexing"))
      yield* Effect.addFinalizer(() => Effect.promise(() => foreign.deleteCollection()))
      yield* Effect.promise(async () => {
        await foreign.initialize()
        await foreign.upsertPoints([point("allowed.ts", "foreigncanary")])
        expect((await foreign.search([1, 0], undefined, 0, 1)).at(0)?.payload?.codeChunk).toBe("foreigncanary")
      })
      const raw = yield* Effect.promise(() => KiloIndexing.search("orthogonalquery"))
      expect(raw.map((item) => item.payload?.filePath)).toEqual(["excluded.ts", "ignored.ts", "stale.ts"])
      expect(raw.some((item) => item.payload?.codeChunk === "foreigncanary")).toBe(false)
      const identity = yield* Effect.promise(() =>
        api.retrieve("excludedcanary", { provider: "", exclude: [omitted.id] }),
      )
      expect(identity.matches.some((item) => item.source.id === omitted.id)).toBe(false)
      expect(
        identity.matches.some((item) => item.source.uri === "excluded.ts" && item.source.method === "line-window"),
      ).toBe(true)
      const result = yield* Effect.promise(() => api.retrieve("fallbackcanary", { provider: "", exclude }))
      expect(result.audit?.channels?.find((item) => item.name === "semantic")).toMatchObject({
        state: "completed",
        candidates: 1,
        withheld: 0,
      })
      expect(result.matches.map((item) => item.source.id)).toContain(file.id)
      expect(
        result.audit?.candidates
          .find((item) => item.source === file.id)
          ?.channels?.some((item) => item.name === "semantic"),
      ).toBe(true)
      for (const text of ["excludedcanary", "ignoredcanary", "stalecanary", "foreigncanary"])
        expect(result.text).not.toContain(text)
      // An expanded limit still returns only current eligible rows with catalog provenance.
      configs
        .get(directory)!
        .loadConfiguration({
          enabled: true,
          embedderProvider: "ollama",
          vectorStoreProvider: "lancedb",
          searchMaxResults: 10,
          searchMinScore: 0,
        })
      yield* Effect.promise(() =>
        store.upsertPoints([
          point("../outside.ts", "outsidecanary"),
          point(`${directory}-foreign/allowed.ts`, "foreigncanary"),
        ]),
      )
      const policy = yield* Effect.promise(() => api.policy(""))
      yield* Effect.promise(() => api.configure({ ...policy, exclude }))
      const lookup = yield* Effect.promise(() =>
        api.lookup({ tool: "forge_search_code", query: "orthogonalquery", provider: "", session: "" }),
      )
      const expanded = lookup.result
      expect(expanded.matches.map((item) => item.source.id)).toEqual([file.id])
      expect(expanded.matches.at(0)?.source).toMatchObject({
        hash: file.hash,
        uri: "allowed.ts",
        text: allowed,
        method: "file",
      })
      expect(expanded.audit?.channels?.find((item) => item.name === "semantic")).toMatchObject({
        candidates: 1,
        withheld: 0,
      })
      const manifest = yield* Effect.promise(() => api.request(lookup.request, ""))
      expect(manifest?.entries).toEqual([
        expect.objectContaining({ source: file.id, uri: file.uri, hash: file.hash, text: allowed, stage: "assembled" }),
      ])
      // A failure in an initialized index must retain the production lexical channel.
      yield* Effect.promise(() => store.deleteCollection())
      const fallback = yield* Effect.promise(() => api.retrieve("fallbackcanary", { provider: "", exclude }))
      expect(fallback.audit?.channels?.find((item) => item.name === "semantic")?.state).toBe("failed")
      expect(fallback.matches.map((item) => item.source.id)).toContain(file.id)
      expect(calls.filter((query) => query === "fallbackcanary")).toHaveLength(1)
    }),
  options,
  30_000,
)

it.instance(
  "denied registered documents cannot reenter through an initialized repository index",
  () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const denied = "registereddenialcanary"
      const allowed = "export const evidence = 'allowedfallbackcanary'"
      yield* Effect.promise(() =>
        Promise.all([
          Bun.write(path.join(directory, "denied.md"), denied),
          Bun.write(path.join(directory, "allowed.ts"), allowed),
        ]),
      )
      yield* EffectBridge.fromPromise(() => KiloIndexing.search("initialize"))
      const api = yield* (yield* Forge.Service).get()
      const collection = yield* Effect.promise(() =>
        api.register({ kind: "file", label: "Denied", location: "./denied.md" }),
      )
      yield* (yield* Config.Service).update({ permission: { read: { [path.join(directory, "denied.md")]: "deny" } } })
      const decision = yield* authorize(collection, "", []).pipe(Effect.exit)
      expect(decision._tag).toBe("Failure")
      const store = stores.get(directory)!
      configs
        .get(directory)!
        .loadConfiguration({
          enabled: true,
          embedderProvider: "ollama",
          vectorStoreProvider: "lancedb",
          searchMaxResults: 1,
          searchMinScore: 0,
        })
      yield* Effect.promise(() => store.upsertPoints([point("denied.md", denied), point("allowed.ts", allowed, 0.8)]))
      expect(
        (yield* EffectBridge.fromPromise(() => KiloIndexing.search("allowedfallbackcanary"))).at(0)?.payload?.codeChunk,
      ).toBe(denied)
      const result = yield* Effect.promise(() => api.retrieve("allowedfallbackcanary", { provider: "" }))
      expect(result.audit?.channels?.find((item) => item.name === "semantic")).toMatchObject({
        state: "completed",
        candidates: 1,
        withheld: 0,
      })
      expect(result.text).toContain("allowedfallbackcanary")
      expect(result.text).not.toContain(denied)
      expect(result.matches.every((item) => item.source.uri !== "denied.md")).toBe(true)
    }),
  options,
  30_000,
)

it.instance(
  "pre-limit exact source exclusions preserve eligible sibling excerpts in the same file",
  () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const text = Array.from({ length: 120 }, (_, index) => `// original passage number ${index}`).join("\n")
      yield* Effect.promise(() => Bun.write(path.join(directory, "windows.ts"), text))
      yield* EffectBridge.fromPromise(() => KiloIndexing.search("initialize"))
      const api = yield* (yield* Forge.Service).get()
      const snapshot = yield* Effect.promise(() => api.refresh())
      const file = snapshot.sources.find((item) => item.uri === "windows.ts" && item.method === "file")!
      const windows = snapshot.sources.filter((item) => item.uri === "windows.ts" && item.method === "line-window")
      const denied = windows.at(0)!
      const allowed = windows.at(-1)!
      expect(allowed.id).not.toBe(denied.id)
      configs
        .get(directory)!
        .loadConfiguration({
          enabled: true,
          embedderProvider: "ollama",
          vectorStoreProvider: "lancedb",
          searchMaxResults: 1,
          searchMinScore: 0,
        })
      yield* Effect.promise(() =>
        stores
          .get(directory)!
          .upsertPoints([
            point(file.uri, file.text),
            point(file.uri, denied.text, 0.1, denied.start, denied.end),
            point(file.uri, allowed.text, 0.8, allowed.start, allowed.end),
          ]),
      )
      const result = yield* Effect.promise(() =>
        api.retrieve("orthogonalquery", { provider: "", exclude: [file.id, denied.id] }),
      )
      expect(result.audit?.channels?.find((item) => item.name === "semantic")).toMatchObject({
        candidates: 1,
        withheld: 0,
      })
      expect(result.audit?.candidates.find((item) => item.source === allowed.id)?.channels).toContainEqual(
        expect.objectContaining({ name: "semantic" }),
      )
      expect(result.matches.some((item) => item.source.id === allowed.id)).toBe(true)
      expect(result.matches.some((item) => item.source.id === denied.id || item.source.id === file.id)).toBe(false)
    }),
  options,
  30_000,
)

it.instance(
  "mask overflow reports semantic failure and preserves lexical evidence without query embedding",
  () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const text = "export const current = 'capfallbackcanary'"
      yield* Effect.promise(() => Bun.write(path.join(directory, "allowed.ts"), text))
      yield* EffectBridge.fromPromise(() => KiloIndexing.search("initialize"))
      const api = yield* (yield* Forge.Service).get()
      yield* Effect.promise(() => api.refresh())
      yield* Effect.promise(() =>
        stores.get(directory)!.upsertPoints(Array.from({ length: 10_001 }, () => point("allowed.ts", text))),
      )
      const result = yield* Effect.promise(() => api.retrieve("capfallbackcanary", { provider: "" }))
      expect(result.audit?.channels?.find((item) => item.name === "semantic")).toMatchObject({
        state: "failed",
        candidates: 0,
      })
      expect(result.text).toContain("capfallbackcanary")
      expect(calls).not.toContain("capfallbackcanary")
    }),
  options,
  30_000,
)

it.instance(
  "actual indexing manager scans local originals and feeds Forge without a model",
  () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const text =
        "export function dispatch(epoch: number) {\n  return `Current queue lease ${epoch} is checked before dispatch and retry`;\n}\n"
      yield* Effect.promise(() => Bun.write(path.join(directory, "queue.ts"), text))
      const factory = yield* Effect.acquireRelease(
        Effect.sync(() =>
          spyOn(CodeIndexServiceFactory.prototype, "createEmbedder").mockReturnValue({
            async createEmbeddings(texts) {
              calls.push(...texts)
              return { embeddings: texts.map(() => [1, 0]) }
            },
            async validateConfiguration() {
              return { valid: true }
            },
            embedderInfo: { name: "ollama" },
          }),
        ),
        (spy) => Effect.sync(() => spy.mockRestore()),
      )
      const managers: CodeIndexManager[] = []
      yield* Effect.addFinalizer(() => Effect.promise(() => Promise.all(managers.map((manager) => manager.dispose()))))
      IndexingWorker.override((directory, root, hooks) => {
        const manager = new CodeIndexManager(directory, root)
        managers.push(manager)
        const progress = manager.onProgressUpdate.on(() => hooks.status(normalizeIndexingStatus(manager)))
        return {
          async init(input) {
            await manager.initialize({ ...input, modelDimension: 2, searchMinScore: 0 })
            await manager.startIndexing()
            return normalizeIndexingStatus(manager)
          },
          search: (query, prefix, scope, signal) => manager.searchIndex(query, prefix, scope, signal),
          async dispose() {
            progress.dispose()
            await manager.dispose()
          },
        }
      })
      const raw = yield* EffectBridge.fromPromise(() => KiloIndexing.search("orthogonalquery"))
      expect(KiloIndexing.peek(directory)).toEqual({ initialized: true, state: "Complete" })
      expect(factory).toHaveBeenCalledTimes(1)
      expect(raw.some((item) => item.payload?.filePath === "queue.ts" && text.includes(item.payload.codeChunk))).toBe(
        true,
      )
      expect(calls.some((value) => value.includes("Current queue lease"))).toBe(true)
      const api = yield* (yield* Forge.Service).get()
      const result = yield* Effect.promise(() => api.retrieve("orthogonalquery", { provider: "" }))
      expect(result.audit?.channels?.find((item) => item.name === "semantic")?.candidates).toBeGreaterThan(0)
      expect(result.text).toContain("Current queue lease")
      expect(result.matches.some((item) => item.source.uri === "queue.ts" && text.includes(item.source.text))).toBe(
        true,
      )
      for (const match of result.matches) {
        const original = yield* Effect.promise(() => Bun.file(path.join(directory, match.source.uri)).text())
        expect(original).toContain(match.source.text)
      }
    }),
  options,
  30_000,
)
