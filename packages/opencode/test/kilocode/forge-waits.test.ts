import { expect, test } from "bun:test"
import { Database as Native } from "bun:sqlite"
import { Effect } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Database } from "@opencode-ai/core/database/database"
import { knowledge } from "@kilocode/forge/knowledge"
import { engine } from "@kilocode/forge/engine"
import { deadline } from "@kilocode/forge/deadline"
import { storage } from "@/kilocode/forge/storage"

test.each(["commit", "purge"] as const)("real worker lock contention exposes live publication and %s without heartbeat writes", async (mode) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "forge-wait-worker-"))
  const file = path.join(dir, "test.db")
  try {
    await Effect.runPromise(Effect.gen(function* () {
      const api = yield* storage
      yield* Effect.promise(() => api.ready)
      yield* Effect.promise(async () => {
        const root = path.join(dir, "workspace")
        const library = knowledge(root, api)
        const service = engine({ root, store: api, complete: async () => { throw new Error("No model calls allowed") } })
        const external = new Native(file, { create: false, readwrite: true })
        const entered = Promise.withResolvers<void>()
        const beat = Promise.withResolvers<void>()
        const cancelled = Promise.withResolvers<void>()
        const stamps: number[] = []
        const publish = api.publish.bind(api)
        let writes = 0
        api.publish = async (root, collection, sources, run) => {
          writes++
          if (collection.state === "ready") {
            external.run("BEGIN IMMEDIATE")
            entered.resolve()
          }
          return publish(root, collection, sources, run)
        }
        const item = await library.register({ kind: "text", label: "Slow worker", location: "", content: "# Lease\nOriginal epoch ownership evidence." })
        await library.approve(item.id)
        const off = api.subscribe(root, (event) => {
          if (event.topic !== "knowledge") return
          void service.collections().then((items) => {
            const live = items.find((value) => value.id === item.id)
            if (live?.warnings.some((line) => line.includes("Publishing documents") && /\([12]s\)/.test(line))) stamps.push(live.progress!.updated)
            if (live?.warnings.some((line) => line.includes("Publishing documents") && line.includes("(2s)"))) beat.resolve()
            if (live?.warnings.some((line) => line.includes("cancellation pending"))) cancelled.resolve()
          }, beat.reject)
        })
        const started = performance.now()
        const pending = library.index(item.id).then(() => "published", () => "cancelled")
        let cleanup: Promise<void> | undefined
        try {
          await deadline(() => entered.promise, undefined, 2000)
          const count = writes
          await deadline(() => beat.promise, undefined, 4000)
          expect(writes).toBe(count)
          expect(stamps.at(-1)! - stamps.at(0)!).toBeGreaterThanOrEqual(900)
          expect(await api.knowledge(root)).toEqual([])
          if (mode === "purge") {
            cleanup = library.purge(item.id)
            await deadline(() => cancelled.promise, undefined, 1000)
            expect(writes).toBe(count)
          }
          external.run("COMMIT")
          expect(await pending).toBe(mode === "commit" ? "published" : "cancelled")
          await cleanup
          if (mode === "commit") expect((await api.knowledge(root)).some((source) => source.text.includes("epoch ownership"))).toBe(true)
          if (mode === "purge") {
            expect(await api.knowledge(root)).toEqual([])
            expect(await api.collection(root, item.id)).toBeUndefined()
          }
          console.log(JSON.stringify({ workflow: "Task24 real worker", mode, elapsed: performance.now() - started, heartbeatSpacing: stamps.at(-1)! - stamps.at(0)!, heartbeatSamples: stamps.length, extraPublicationCallsWhileHeld: 0 }))
        } finally {
          off()
          if (external.inTransaction) external.run("ROLLBACK")
          await pending
          await cleanup
          await service.dispose()
          await library.dispose()
          external.close()
        }
      })
    }).pipe(Effect.provide(Database.layerFromPath(file)), Effect.scoped))
  } finally { await rm(dir, { recursive: true, force: true }) }
}, 15_000)
