import { expect, test } from "bun:test"
import { Database as Native } from "bun:sqlite"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { source } from "@kilocode/forge/parse"
import { unpack } from "@kilocode/forge/snapshot"
import { storage } from "@/kilocode/forge/storage"
import { setTimeout as delay } from "node:timers/promises"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

test("actual disk-backed host adapter publishes complete generations and preserves scoped evidence", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "forge-publication-"))
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const api = yield* storage
        yield* Effect.promise(() => api.ready)
        const root = `/publication-${crypto.randomUUID()}`
        const snapshot = yield* Effect.promise(async () => {
          const filename = process.env.FORGE_PUBLICATION_SNAPSHOT
          if (!filename)
            return {
              root,
              generation: "first",
              revision: "",
              observed: 1,
              files: 2000,
              partial: false,
              warnings: [],
              relations: [],
              sources: Array.from({ length: 2000 }, (_, index) =>
                source(`queue-${index}.ts`, `export const queue${index} = "publicationcanary"`, "code"),
              ),
            }
          const db = new Native(filename, { readonly: true })
          try {
            const row = db
              .query<{ body: string }, []>("SELECT body FROM forge_records WHERE kind = 'snapshot' LIMIT 1")
              .get()
            if (!row) throw new Error("Measurement snapshot is missing")
            return { ...(await unpack(JSON.parse(row.body))), root }
          } finally {
            db.close()
          }
        })
        async function measure(name: string, value: typeof snapshot) {
          const previous = await api.inventory(root)
          const gaps: number[] = []
          const reads: number[] = []
          const generations = new Set<string>()
          const stop = new AbortController()
          let last = performance.now()
          const pending = (async () => {
            while (!stop.signal.aborted) {
              await delay(10)
              const now = performance.now()
              gaps.push(Math.max(0, now - last - 10))
              const start = performance.now()
              generations.add((await api.inventory(root)).generation)
              reads.push(performance.now() - start)
              last = performance.now()
            }
          })()
          const start = performance.now()
          try {
            await api.replace(value)
          } finally {
            stop.abort()
            await pending
          }
          const elapsed = performance.now() - start
          for (const generation of generations) expect([previous.generation, value.generation]).toContain(generation)
          if (process.env.FORGE_PUBLICATION_SNAPSHOT)
            console.log(
              JSON.stringify({
                name,
                sources: value.sources.length,
                relations: value.relations.length,
                elapsed,
                gap: Math.max(...gaps),
                read: Math.max(...reads),
                samples: reads.length,
              }),
            )
        }
        yield* Effect.promise(() => measure("initial", snapshot))
        const inventory = yield* Effect.promise(() => api.inventory(root))
        expect(inventory.generation).toBe(snapshot.generation)
        expect(Object.values(inventory.counts).reduce((sum, count) => sum + count, 0)).toBe(snapshot.sources.length)
        const page = yield* Effect.promise(() => api.view(root, { limit: 25 }))
        expect(page.sources).toHaveLength(25)
        const changed = { ...snapshot.sources.at(0)!, text: "replacementcanary", hash: "updated" }
        const next = { ...snapshot, generation: "next", sources: [changed, ...snapshot.sources.slice(1)] }
        yield* Effect.promise(() => measure("changed", next))
        expect((yield* Effect.promise(() => api.inventory(root))).generation).toBe("next")
        expect((yield* Effect.promise(() => api.source(root, changed.id)))?.text).toBe("replacementcanary")
        expect(
          (yield* Effect.promise(() => api.search(root, "replacementcanary"))).some(
            (item) => item.source.id === changed.id,
          ),
        ).toBe(true)
        yield* Effect.promise(() => measure("unchanged", next))
        expect((yield* Effect.promise(() => api.inventory(root))).generation).toBe("next")
      }).pipe(Effect.provide(Database.layerFromPath(path.join(dir, "test.db"))), Effect.scoped),
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}, 120_000)
