import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { store, type Query } from "../src/store"
import { source } from "../src/parse"
import type { Collection, Source } from "../src/schema"

function connect(db: Database, queries: Query[] = []) {
  return store({
    all: async (query) => {
      queries.push(query)
      return db.query<Record<string, unknown>, (string | number | null)[]>(query.text).all(...query.values ?? [])
    },
    batch: async (batch) => {
      queries.push(...batch)
      db.transaction(() => {
        for (const query of batch) db.query(query.text).run(...query.values ?? [])
      })()
    },
  })
}

const collection: Collection = {
  id: "local", kind: "folder", label: "Manual", location: "/manuals", origin: "interface",
  session: "private", include: [], exclude: [], watch: false, approved: true, providers: ["provider"],
  state: "ready", observed: 1, generation: "saved", files: 1, chunks: 1, warnings: [],
}
const document = source("manual.md", "privatecanary", "document", {
  detail: { collection: collection.id, session: "private", providers: '["provider"]' },
})

function snapshot(root: string, sources: Source[]) {
  return { root, sources, generation: "saved", revision: "fixture", observed: 1, files: sources.length, partial: true, warnings: [], relations: [] }
}

function rows(db: Database, table = "forge_search") {
  return db.query<{ rowid: number; workspace: string; id: string }, []>(`SELECT rowid,workspace,id FROM ${table} ORDER BY rowid`).all()
}

function consistent(db: Database) {
  expect(rows(db, "forge_fts_rows")).toEqual(rows(db))
  db.run("INSERT INTO forge_search(forge_search) VALUES('integrity-check')")
}

test("legacy FTS migration preserves sparse rowids and duplicates, rolls back, and reopens once", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "forge-fts-migration-"))
  const filename = path.join(dir, "store.sqlite")
  const db = new Database(filename)
  try {
    db.run("CREATE TABLE forge_records (workspace TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY(workspace,kind,id))")
    db.run("CREATE TABLE forge_sources (workspace TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(workspace,id))")
    db.run("CREATE VIRTUAL TABLE forge_search USING fts5(workspace UNINDEXED, id UNINDEXED, path, content, tokenize='porter unicode61')")
    for (const root of ["/one", "/two"]) {
      db.query("INSERT INTO forge_records VALUES(?,?,?,?,?)").run(root, "collection", collection.id, JSON.stringify(collection), 1)
      db.query("INSERT INTO forge_sources VALUES(?,?,?)").run(root, document.id, JSON.stringify(document))
    }
    for (const [rowid, root] of [[7, "/one"], [91, "/two"], [104, "/one"]] as const)
      db.query("INSERT INTO forge_search(rowid,workspace,id,path,content) VALUES(?,?,?,?,?)").run(rowid, root, document.id, document.uri, document.text)
    const before = rows(db)
    db.run("CREATE TRIGGER reject_marker BEFORE INSERT ON forge_records WHEN NEW.kind = 'search-index' BEGIN SELECT RAISE(ABORT, 'migration failed'); END")
    expect(await connect(db).ready.then(() => undefined, (err: unknown) => err)).toMatchObject({ message: "migration failed" })
    expect(rows(db)).toEqual(before)
    expect(db.query("SELECT name FROM sqlite_master WHERE name = 'forge_fts_rows'").get()).toBeNull()
    expect(db.query("SELECT id FROM forge_records WHERE kind = 'search-index'").all()).toEqual([])
    db.run("DROP TRIGGER reject_marker")
    db.run("CREATE TABLE forge_fts_rows (rowid INTEGER PRIMARY KEY, workspace TEXT NOT NULL, id TEXT NOT NULL)")
    db.query("INSERT INTO forge_fts_rows VALUES(?,?,?)").run(999, "/stale", "absent")
    db.query("INSERT INTO forge_fts_rows VALUES(?,?,?)").run(7, "/wrong", "wrong")
    const api = connect(db)
    await api.ready
    consistent(db)
    expect(rows(db)).toEqual(before)
    expect(db.query("PRAGMA index_info(forge_fts_rows_source)").all()).toEqual([
      { seqno: 0, cid: 1, name: "workspace" }, { seqno: 1, cid: 2, name: "id" },
    ])
    // Completed migration must not try to reinsert any legacy row.
    db.run("CREATE TRIGGER reject_backfill BEFORE INSERT ON forge_fts_rows BEGIN SELECT RAISE(ABORT, 'backfill repeated'); END")
  } finally { db.close() }
  const reopened = new Database(filename)
  try {
    const queries: Query[] = []
    const api = connect(reopened, queries)
    await api.ready
    expect(await api.recover("/one")).toEqual(["local"])
    consistent(reopened)
    expect(rows(reopened)).toEqual([{ rowid: 91, workspace: "/two", id: document.id }])
    expect((await api.source("/one", document.id))?.status).toBe("unavailable")
    expect(await api.source("/two", document.id)).toEqual(document)
    const deletion = queries.find((query) => query.text.startsWith("DELETE FROM forge_search"))!
    const statement = reopened.prepare<{ detail: string }, (string | number | null)[]>(`EXPLAIN QUERY PLAN ${deletion.text}`)
    try {
      const plan = statement.all(...deletion.values ?? []).map((row) => row.detail)
      expect(plan.some((item) => item.includes("forge_fts_rows_source (workspace=? AND id=?)"))).toBe(true)
      expect(plan.some((item) => item.includes("forge_sources_collection"))).toBe(true)
      expect(plan.filter((item) => item.includes("VIRTUAL TABLE"))).toEqual(["SCAN forge_search VIRTUAL TABLE INDEX 0:="])
    } finally { statement.finalize() }
    reopened.run("DROP TRIGGER reject_backfill")
    await api.publish("/one", collection, [{ ...document, text: "updatedcanary" }])
    consistent(reopened)
    expect(await api.search("/one", "privatecanary", 10, { session: "private", provider: "provider" })).toEqual([])
    expect(await api.search("/one", "updatedcanary", 10, { session: "private", provider: "provider" })).toHaveLength(1)
    expect(await api.search("/two", "privatecanary", 10, { session: "private", provider: "provider" })).toHaveLength(1)
  } finally { reopened.close(); await rm(dir, { recursive: true, force: true }) }
})

test("empty migration marker is durable and later inserts remain projected", async () => {
  const db = new Database(":memory:")
  try {
    await connect(db).ready
    expect(db.query("SELECT workspace,id,body FROM forge_records WHERE kind = 'search-index'").all()).toEqual([{ workspace: "", id: "current", body: "1" }])
    const api = connect(db)
    await api.ready
    await api.publish("/one", collection, [document])
    consistent(db)
    db.run("CREATE TRIGGER reject_backfill BEFORE INSERT ON forge_fts_rows BEGIN SELECT RAISE(ABORT, 'backfill repeated'); END")
    db.run("CREATE TRIGGER reject_marker BEFORE INSERT ON forge_records WHEN NEW.kind = 'search-index' BEGIN SELECT RAISE(ABORT, 'marker repeated'); END")
    await connect(db).ready
    consistent(db)
  } finally { db.close() }
})

test("projection follows rowid reuse, replacement, forgetting, summaries, and cross-workspace purge", async () => {
  const db = new Database(":memory:")
  try {
    const api = connect(db)
    await api.publish("/one", collection, [document])
    const first = rows(db).at(0)!.rowid
    await api.publish("/one", { ...collection, state: "removed" }, [])
    consistent(db)
    expect(rows(db)).toEqual([])
    await api.publish("/two", collection, [document])
    expect(rows(db)).toEqual([{ rowid: first, workspace: "/two", id: document.id }])
    consistent(db)
    expect(await api.recover("/one")).toEqual([])
    expect(await api.source("/two", document.id)).toEqual(document)
    await api.publish("/one", collection, [document])
    const code = source("one.ts", "codecanary", "code")
    const summary = source("summary:one", "copiedcanary", "summary")
    for (const root of ["/one", "/two"]) await api.replace(snapshot(root, [code, summary]))
    consistent(db)
    const other = rows(db).filter((row) => row.workspace === "/two")
    await api.replace(snapshot("/one", [{ ...code, text: "updatedcanary" }, summary]))
    consistent(db)
    await api.replace(snapshot("/one", [{ ...code, status: "unavailable" }, summary]))
    consistent(db)
    expect(await api.search("/one", "updatedcanary")).toEqual([])
    await api.purge("/one", collection.id)
    consistent(db)
    expect(rows(db).filter((row) => row.workspace === "/one")).toEqual([])
    expect(rows(db)).toEqual(other)
    expect(await api.source("/one", summary.id)).toBeUndefined()
    expect(await api.source("/two", summary.id)).toEqual(summary)
    // Repeated no-op publication cannot recreate or change existing rowids.
    await api.replace(snapshot("/two", [code, summary]))
    consistent(db)
    expect(rows(db)).toEqual(other)
    await api.recover("/two")
    consistent(db)
    expect(rows(db).some((row) => row.id === document.id)).toBe(false)
  } finally { db.close() }
})

test("publication and recovery failures roll back FTS rows and the projection together", async () => {
  const db = new Database(":memory:")
  try {
    const api = connect(db)
    await api.publish("/one", collection, [document])
    const before = rows(db)
    db.run("CREATE TRIGGER reject_projection BEFORE INSERT ON forge_fts_rows BEGIN SELECT RAISE(ABORT, 'projection failed'); END")
    expect(await api.publish("/one", collection, [{ ...document, text: "mustrollback" }]).then(() => undefined, (err: unknown) => err)).toMatchObject({ message: "projection failed" })
    consistent(db)
    expect(rows(db)).toEqual(before)
    expect(await api.source("/one", document.id)).toEqual(document)
    db.run("DROP TRIGGER reject_projection")
    db.run("CREATE TRIGGER reject_recovery BEFORE UPDATE ON forge_records WHEN NEW.kind = 'collection' BEGIN SELECT RAISE(ABORT, 'recovery failed'); END")
    expect(await api.recover("/one").then(() => undefined, (err: unknown) => err)).toMatchObject({ message: "recovery failed" })
    consistent(db)
    expect(rows(db)).toEqual(before)
    expect(await api.source("/one", document.id)).toEqual(document)
    db.run("DROP TRIGGER reject_recovery")
    await api.recover("/one")
    consistent(db)
    expect(rows(db)).toEqual([])
    expect((await api.source("/one", document.id))?.status).toBe("unavailable")
  } finally { db.close() }
})

test("a purge on another connection fences a delayed FTS publication and its projection", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "forge-fts-fence-"))
  const filename = path.join(dir, "store.sqlite")
  const db = new Database(filename)
  db.run("PRAGMA journal_mode=WAL")
  const second = new Database(filename)
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  try {
    const api = connect(db)
    for (const root of ["/one", "/two"]) await api.publish(root, collection, [document])
    const other = rows(db).filter((row) => row.workspace === "/two")
    const delayed = store({
      all: async (query) => second.query<Record<string, unknown>, (string | number | null)[]>(query.text).all(...query.values ?? []),
      batch: async (queries) => {
        if (queries.some((query) => query.text.startsWith("INSERT INTO forge_fts_rows"))) {
          entered.resolve()
          await release.promise
        }
        second.transaction(() => {
          for (const query of queries) second.query(query.text).run(...query.values ?? [])
        })()
      },
    })
    await delayed.ready
    const pending = delayed.fenced("/one", () => delayed.publish("/one", collection, [{ ...document, text: "mustnotreturn" }]))
      .then(() => undefined, (err: unknown) => err)
    await entered.promise
    await api.purge("/one", collection.id)
    release.resolve()
    expect(await pending).toMatchObject({ message: "Forge knowledge was purged during this operation. Start a new request." })
    consistent(db)
    expect(rows(db)).toEqual(other)
    expect(await api.collection("/one", collection.id)).toBeUndefined()
    expect(await api.source("/one", document.id)).toBeUndefined()
    expect(await api.source("/two", document.id)).toEqual(document)
  } finally {
    release.resolve()
    second.close()
    db.close()
    await rm(dir, { recursive: true, force: true })
  }
})
