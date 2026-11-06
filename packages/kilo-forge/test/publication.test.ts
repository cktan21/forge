import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { store, type Query } from "../src/store"
import { source } from "../src/parse"
import { Source, decode, type Snapshot } from "../src/schema"

test("repository publication batches FTS removal and preserves unrelated evidence", async () => {
  const db = new Database(":memory:")
  const batches: Query[][] = []
  const reads: Query[] = []
  const storage = store({
    all: async (query) => {
      reads.push(query)
      const rows = db.query<Record<string, unknown>, (string | number | null)[]>(query.text).all(...query.values ?? [])
      if (query.text.startsWith("SELECT id,body FROM forge_sources")) {
        expect(rows.length).toBeLessThanOrEqual(200)
        expect(rows.every((row) => !decode(Source, JSON.parse(String(row.body))).detail.collection)).toBe(true)
      }
      return rows
    },
    batch: async (queries) => {
      batches.push([...queries])
      db.transaction(() => {
        for (const query of queries) db.query(query.text).run(...query.values ?? [])
      })()
    },
  })
  try {
    const sources = Array.from({ length: 1000 }, (_, index) => source(`queue-${index}.ts`, `export const queue${index} = "originalcanary"`, "code", index === 999 ? { detail: { collection: "" } } : {}))
    const snapshot: Snapshot = { root: "/publication", generation: "first", revision: "", observed: 1, files: sources.length, partial: false, sources, relations: [], warnings: [] }
    await storage.replace({ ...snapshot, root: "/other" })
    await storage.replace(snapshot)
    const published = batches.at(-1)!
    expect(published.filter((query) => query.text.startsWith("INSERT OR REPLACE INTO forge_sources"))).toHaveLength(5)
    expect(published.filter((query) => query.text.startsWith("INSERT INTO forge_search"))).toHaveLength(5)
    for (const query of published.filter((query) => query.text.startsWith("INSERT OR REPLACE INTO forge_sources"))) {
      expect(JSON.parse(String(query.values?.at(1))).length).toBeLessThanOrEqual(200)
    }
    const imported = source("knowledge:manual", "importedcanary", "document", {
      detail: { collection: "manual", providers: '["fixture"]' },
    })
    db.query("INSERT INTO forge_sources(workspace,id,body) VALUES(?,?,?)").run(snapshot.root, imported.id, JSON.stringify(imported))
    db.query("INSERT INTO forge_search(workspace,id,path,content) VALUES(?,?,?,?)").run(snapshot.root, imported.id, imported.uri, imported.text)
    const changed = source("queue-0.ts", 'export const queue0 = "changedcanary"', "code")
    const next = { ...snapshot, generation: "second", sources: [changed, ...sources.slice(2)] }
    batches.length = 0
    reads.length = 0
    await storage.replace(next)
    const pages = reads.filter((query) => query.text.startsWith("SELECT id,body FROM forge_sources"))
    expect(pages).toHaveLength(6)
    expect(pages.slice(1).every((query) => query.text.includes("id > ?"))).toBe(true)
    expect((await storage.search(snapshot.root, "changedcanary")).map((item) => item.source.id)).toEqual([changed.id])
    expect((await storage.search("/other", "originalcanary", 100))).toHaveLength(100)
    expect((await storage.search(snapshot.root, "importedcanary", 10, { provider: "fixture" })).at(0)?.source.id).toBe(imported.id)
    expect(db.query("SELECT count(*) AS total FROM forge_search WHERE workspace = ? AND id = ?").get(snapshot.root, changed.id)).toEqual({ total: 1 })
    expect(db.query("SELECT count(*) AS total FROM forge_search WHERE workspace = ? AND id = ?").get(snapshot.root, sources.at(1)!.id)).toEqual({ total: 0 })
    expect(db.query("SELECT count(*) AS total FROM forge_search WHERE workspace = ?").get(snapshot.root)).toEqual({ total: 1000 })
    expect(batches).toHaveLength(1)
    expect(batches.flat().filter((query) => query.text.startsWith("INSERT OR REPLACE INTO forge_sources"))).toHaveLength(1)
    expect(batches.flat().filter((query) => query.text.startsWith("DELETE FROM forge_search")).length).toBeLessThanOrEqual(2)
    batches.length = 0
    await storage.replace(next)
    expect(batches.flat().filter((query) => query.text.startsWith("INSERT OR REPLACE INTO forge_sources"))).toHaveLength(0)
    batches.length = 0
    await storage.replace({ ...next, sources: next.sources.map((item) => ({ ...item, observed: 2 })) })
    expect(batches.flat().filter((query) => query.text.startsWith("DELETE FROM forge_search")).length).toBeLessThanOrEqual(2)
    expect(db.query("SELECT count(*) AS total FROM forge_search WHERE workspace = ?").get(snapshot.root)).toEqual({ total: 1000 })
    const collection = {
      id: "manual", kind: "text" as const, label: "Manual", location: "manual", origin: "interface" as const,
      session: "", include: [], exclude: [], watch: false, approved: true, providers: ["fixture"],
      state: "ready" as const, observed: 1, generation: "first", files: 1, chunks: 1, warnings: [],
    }
    batches.length = 0
    const revised = { ...imported, text: 'revisedcanary "quoted"\nback\\slash queueLease key_value' }
    await storage.publish(snapshot.root, collection, [revised])
    expect(batches.flat().filter((query) => query.text.startsWith("DELETE FROM forge_search"))).toHaveLength(1)
    expect(await storage.search(snapshot.root, "importedcanary", 10, { provider: "fixture" })).toHaveLength(0)
    expect((await storage.search(snapshot.root, "revisedcanary", 10, { provider: "fixture" })).at(0)?.source.id).toBe(imported.id)
    expect((await storage.search(snapshot.root, "changedcanary")).at(0)?.source.id).toBe(changed.id)
    expect((await storage.source(snapshot.root, imported.id))?.text).toBe(revised.text)
    expect((await storage.search(snapshot.root, "queue lease", 10, { provider: "fixture" })).at(0)?.source.id).toBe(imported.id)
    expect((await storage.search(snapshot.root, "key value", 10, { provider: "fixture" })).at(0)?.source.id).toBe(imported.id)
    await storage.publish(snapshot.root, { ...collection, state: "removed" }, [])
    expect(await storage.search(snapshot.root, "revisedcanary", 10, { provider: "fixture" })).toHaveLength(0)
    expect(await storage.retired(snapshot.root, imported.id)).toBe(true)
  } finally {
    db.close()
  }
})
