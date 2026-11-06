import { expect } from "bun:test"
import { NodeServices } from "@effect/platform-node"
import { Database } from "@opencode-ai/core/database/database"
import { Effect } from "effect"
import { rejects } from "node:assert/strict"
import { source } from "@kilocode/forge/parse"
import { storage } from "@/kilocode/forge/storage"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(NodeServices.layer)

for (const mode of ["memory", "delete", "wal"] as const) {
  it.live(`Forge ${mode} storage binds values and preserves classification and atomic publication`, () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const { db } = yield* Database.Service
        if (mode === "delete") yield* db.run("PRAGMA journal_mode = DELETE")
        expect((yield* db.all<{ journal_mode: string }>("PRAGMA journal_mode")).at(0)?.journal_mode).toBe(mode)
        const api = yield* storage
        const root = `${dir}/workspace?'--`
        const session = "private?'--"
        expect((yield* Effect.promise(() => api.view(root))).sources).toEqual([])

        const sources = [
          source("manual.pdf?download=1", "Queue ownership", "document"),
          source("notes.txt?format=.pdf", "Retry policy", "document"),
          source("attachment://guide", "Queue reference", "attachment", { detail: { document: "README.MD#queue" } }),
          source("private.pdf#page=2", "Private queue", "document", { detail: { session } }),
        ]
        const snapshot = {
          root,
          generation: "original",
          revision: "",
          observed: 1,
          files: sources.length,
          partial: false,
          sources,
          relations: [],
          warnings: [],
        }
        yield* Effect.promise(() => api.replace(snapshot))
        yield* Effect.promise(() => api.replace({ ...snapshot, root: `${root}-other` }))
        const view = yield* Effect.promise(() => api.view(root, { category: "pdf", limit: 1 }))
        expect(view.categories).toEqual({ pdf: 1, text: 1, markdown: 1 })
        expect(view.sources.map((item) => item.uri)).toEqual(["manual.pdf?download=1"])
        expect(view.page).toEqual({ offset: 0, limit: 1 })
        expect((yield* Effect.promise(() => api.view(root, { category: "pdf", session }))).sources).toHaveLength(2)
        expect(
          (yield* Effect.promise(() => api.view(root, { category: "text", query: "Retry" }))).sources,
        ).toHaveLength(1)
        expect((yield* Effect.promise(() => api.view(root, { query: "' OR 1=1 -- ?" }))).sources).toEqual([])
        expect((yield* Effect.promise(() => api.view(`${root}-missing`))).sources).toEqual([])
        yield* Effect.promise(() => api.content(root, "key?'--", "Literal '?', \"?\", -- ?, /* ? */"))
        expect(yield* Effect.promise(() => api.contents(root, "key?'--"))).toBe("Literal '?', \"?\", -- ?, /* ? */")
        expect(yield* Effect.promise(() => api.contents(`${root}-other`, "key?'--"))).toBeUndefined()

        // Fail after source writes so the host-client path must roll back the entire batch.
        yield* db.run(`CREATE TRIGGER reject_snapshot BEFORE INSERT ON forge_records
          WHEN NEW.kind = 'inventory' AND json_extract(NEW.body, '$.generation') = 'blocked'
          BEGIN SELECT RAISE(ABORT, 'snapshot rejected'); END`)
        yield* Effect.promise(() =>
          rejects(
            api.replace({
              ...snapshot,
              generation: "blocked",
              sources: sources.map((item) => ({ ...item, text: "Uncommitted replacement", hash: "changed" })),
            }),
          ),
        )
        expect((yield* Effect.promise(() => api.inventory(root))).generation).toBe("original")
        for (const item of sources) {
          expect(yield* Effect.promise(() => api.source(root, item.id))).toEqual(item)
        }
        yield* Effect.promise(() => api.replace({ ...snapshot, generation: "recovered" }))
        expect((yield* Effect.promise(() => api.inventory(root))).generation).toBe("recovered")
      }).pipe(Effect.provide(Database.layerFromPath(mode === "memory" ? ":memory:" : `${dir}/storage.db`)))
    }),
  )
}
