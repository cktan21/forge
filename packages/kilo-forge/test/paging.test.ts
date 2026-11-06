import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { store, type Query } from "../src/store"
import { source, relation } from "../src/parse"
import type { Snapshot } from "../src/schema"

test("legacy snapshots backfill indexed relationships once and preserve scoped page order", async () => {
  const db = new Database(":memory:")
  const queries: Query[] = []
  const sql = {
    all: async (query: Query) => {
      queries.push(query)
      return db.query<Record<string, unknown>, (string | number | null)[]>(query.text).all(...query.values ?? [])
    },
    batch: async (batch: readonly Query[]) => {
      db.transaction(() => {
        for (const query of batch) db.query(query.text).run(...query.values ?? [])
      })()
    },
  }
  try {
    // Simulate a persisted database before the paging indexes existed.
    db.run("CREATE TABLE forge_records (workspace TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY(workspace,kind,id))")
    db.run("CREATE TABLE forge_sources (workspace TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(workspace,id))")
    const a = source("a.ts", "alpha needle", "code", { id: "a" })
    const b = source("b.ts", "private needle", "code", { id: "b", detail: { session: "private" } })
    const c = source("c.ts", "charlie needle", "symbol", { id: "c", method: "syntax" })
    const d = source("d.ts", "delta needle", "code", { id: "d" })
    const edges = [relation(d.id, a.id, "imports", []), relation(a.id, c.id, "declares", []), relation(a.id, b.id, "imports", [])]
    const snapshot: Snapshot = { root: "/paging", generation: "legacy", revision: "", observed: 1, files: 3, partial: false, sources: [a, b, c, d], relations: edges, warnings: [] }
    for (const root of [snapshot.root, "/other"]) {
      db.query("INSERT INTO forge_records VALUES(?,?,?,?,?)").run(root, "snapshot", "current", JSON.stringify({ ...snapshot, root }), 1)
      for (const item of snapshot.sources) db.query("INSERT INTO forge_sources VALUES(?,?,?)").run(root, item.id, JSON.stringify(item))
    }
    const api = store(sql)
    await api.ready
    const page = await api.view(snapshot.root, { limit: 2 })
    expect(page.sources.map((item) => item.id)).toEqual(["a", "d"])
    expect(page.relations).toEqual([edges.at(0)!])
    expect(page.page.next).toBe(2)
    expect((await api.view(snapshot.root, { offset: 2 })).sources.map((item) => item.id)).toEqual(["c"])
    expect((await api.view(snapshot.root, { session: "private" })).sources.map((item) => item.id)).toEqual(["a", "b", "d", "c"])
    expect((await api.view(snapshot.root, { focus: "a" })).relations).toEqual(edges.slice(0, 2))
    expect((await api.view(snapshot.root, { query: "private" })).sources).toEqual([])
    expect((await api.view(snapshot.root, { query: "charlie" })).sources.map((item) => item.id)).toEqual(["c"])
    const select = queries.find((query) => query.text.startsWith("SELECT json_set"))!
    const plan = db.query<{ detail: string }, (string | number | null)[]>(`EXPLAIN QUERY PLAN ${select.text}`).all(...select.values ?? [])
    expect(plan.some((row) => row.detail.includes("forge_sources_page"))).toBe(true)
    expect(plan.some((row) => row.detail.includes("TEMP B-TREE"))).toBe(false)
    expect(queries.filter((query) => query.text.startsWith("SELECT body FROM forge_relations")).length).toBeGreaterThan(0)
    // Failed publication must roll back sources and the relationship projection together.
    db.run("CREATE TRIGGER fail_projection BEFORE INSERT ON forge_relations WHEN NEW.workspace = '/paging' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END")
    const failure: unknown = await api.replace({ ...snapshot, generation: "failed", sources: [a, c], relations: [edges.at(1)!] }).then(() => undefined, (err: unknown) => err)
    expect(failure).toBeInstanceOf(Error)
    expect(String(failure)).toContain("fixture failure")
    expect((await api.view(snapshot.root)).relations).toEqual(edges.slice(0, 2))
    expect((await api.view(snapshot.root)).generation).toBe("legacy")
    db.run("DROP TRIGGER fail_projection")
    await api.replace({ ...snapshot, generation: "next", sources: [a, c], relations: [edges.at(1)!] })
    expect((await api.view(snapshot.root)).relations).toEqual([edges.at(1)!])
    expect((await api.view("/other", { session: "private" })).relations).toEqual(edges)
    // Reopening must not backfill stale snapshot relations over an existing projection.
    db.query("UPDATE forge_records SET body = ? WHERE workspace = ? AND kind = 'snapshot'").run(JSON.stringify(snapshot), snapshot.root)
    const reopened = store(sql)
    await reopened.ready
    expect((await reopened.view(snapshot.root)).relations).toEqual([edges.at(1)!])
    await reopened.save(snapshot.root, {
      id: "manual", kind: "text", label: "Manual", location: "manual", origin: "interface",
      session: "", include: [], exclude: [], watch: false, approved: true, providers: [],
      state: "ready", observed: 1, generation: "first", files: 0, chunks: 0, warnings: [],
    })
    await reopened.purge(snapshot.root, "manual")
    expect(db.query("SELECT count(*) AS total FROM forge_relations WHERE workspace = ?").get(snapshot.root)).toEqual({ total: 0 })
    const purged = store(sql)
    await purged.ready
    expect((await purged.view(snapshot.root)).relations).toEqual([])
    expect((await purged.view("/other", { session: "private" })).relations).toEqual(edges)
  } finally {
    db.close()
  }
})
