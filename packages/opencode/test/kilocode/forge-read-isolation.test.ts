import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect, Exit, Fiber } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { source } from "@kilocode/forge/parse"
import { storage } from "@/kilocode/forge/storage"

test("disk-backed Forge reads see committed generations without waiting for an open writer", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "forge-isolation-"))
  try {
    await Effect.runPromise(Effect.gen(function* () {
      const { db } = yield* Database.Service
      const api = yield* storage
      const root = "/isolation"
      const item = source("queue.ts", "committedcanary", "code")
      const snapshot = { root, generation: "committed", revision: "", observed: 1, files: 1, partial: false, sources: [item], relations: [], warnings: [] }
      yield* Effect.promise(() => api.replace(snapshot))
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const writer = yield* db.transaction((tx) => Effect.gen(function* () {
        yield* tx.run(sql`UPDATE forge_records SET body = json_set(body, '$.generation', 'uncommitted') WHERE workspace = ${root} AND kind = 'inventory'`)
        yield* tx.run(sql`UPDATE forge_sources SET body = json_set(body, '$.text', 'uncommittedcanary') WHERE workspace = ${root}`)
        entered.resolve()
        yield* Effect.promise(() => release.promise)
      })).pipe(Effect.forkChild)
      yield* Effect.promise(() => entered.promise)
      const observed = yield* Effect.promise(async () => ({
        inventory: await api.inventory(root),
        source: await api.source(root, item.id),
      })).pipe(Effect.timeout(1000), Effect.exit)
      release.resolve()
      yield* Fiber.join(writer)
      expect(Exit.isSuccess(observed)).toBe(true)
      if (Exit.isFailure(observed)) throw new Error("Committed reads waited for the writer lock")
      expect(observed.value.inventory.generation).toBe("committed")
      expect(observed.value.source?.text).toBe("committedcanary")
      expect((yield* Effect.promise(() => api.inventory(root))).generation).toBe("uncommitted")
      expect((yield* Effect.promise(() => api.source(root, item.id)))?.text).toBe("uncommittedcanary")
      const rollback = yield* db.transaction((tx) => Effect.gen(function* () {
        yield* tx.run(sql`UPDATE forge_sources SET body = json_set(body, '$.text', 'rollbackcanary') WHERE workspace = ${root}`)
        expect((yield* Effect.promise(() => api.source(root, item.id)))?.text).toBe("uncommittedcanary")
        return yield* Effect.fail("rollback")
      })).pipe(Effect.exit)
      expect(Exit.isFailure(rollback)).toBe(true)
      expect((yield* Effect.promise(() => api.source(root, item.id)))?.text).toBe("uncommittedcanary")
      // A write admitted before a purge must still fail at commit, even though
      // its read-only connection could read the previous epoch during the write.
      const guard = yield* Effect.promise(() => api.guard(root))
      const admitted = Promise.withResolvers<void>()
      const proceed = Promise.withResolvers<void>()
      const pending = guard.run(async () => {
        admitted.resolve()
        await proceed.promise
        await api.replace({ ...snapshot, generation: "forbidden" })
      }).then(() => undefined, (err: unknown) => err)
      yield* Effect.promise(() => admitted.promise)
      yield* db.run(sql`INSERT OR REPLACE INTO forge_records(workspace,kind,id,body,updated) VALUES(${root},'purge-epoch','current',${JSON.stringify("purged")},0)`)
      proceed.resolve()
      const failure = yield* Effect.promise(() => pending)
      expect(failure).toBeInstanceOf(Error)
      expect(String(failure)).toContain("purged during this operation")
      expect((yield* Effect.promise(() => api.inventory(root))).generation).toBe("uncommitted")
    }).pipe(Effect.provide(Database.layerFromPath(path.join(directory, "test.db"))), Effect.scoped))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 30_000)
