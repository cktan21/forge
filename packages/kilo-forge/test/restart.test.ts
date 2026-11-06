import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { store, type Query } from "../src/store"
import { source, relation } from "../src/parse"
import { engine } from "../src/engine"
import { knowledge } from "../src/knowledge"
import { extract } from "../src/extract"
import { usage, type Collection, type ImportRun } from "../src/schema"

function connect(db: Database) {
  return store({
    all: async (query) => db.query<Record<string, unknown>, (string | number | null)[]>(query.text).all(...query.values ?? []),
    batch: async (queries: readonly Query[]) => {
      db.transaction(() => { for (const query of queries) db.query(query.text).run(...query.values ?? []) })()
    },
  })
}

test("file-backed restart backfills missing projections without reevaluating completed migrations", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "forge-restart-migrations-"))
  const filename = path.join(dir, "knowledge.sqlite")
  const db = new Database(filename)
  try {
    db.run("CREATE TABLE forge_records (workspace TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY(workspace,kind,id))")
    const edge = relation("a", "b", "imports", [])
    const record = db.query("INSERT INTO forge_records VALUES(?,?,?,?,?)")
    for (const root of [dir, "/other"]) {
      record.run(root, "snapshot", "current", JSON.stringify({ relations: [edge] }), 1)
      record.run(root, "request", "coding", JSON.stringify({
        id: "coding", session: "private", purpose: "coding", model: "fixture", observed: 1,
        state: "completed", entries: [{ stage: "sent" }, { stage: "candidate" }], usage: usage("fixture"),
      }), 1)
    }
    const api = connect(db)
    await api.ready
    expect((await api.latest(dir, "private", "coding"))?.sent).toBe(1)
    expect(await api.latest(dir, "", "coding")).toBeUndefined()
    expect(db.query("SELECT body FROM forge_relations WHERE workspace = ?").all(dir)).toEqual([{ body: JSON.stringify(edge) }])
    // Completed projections must not even attempt reinsertion or parse the old payload.
    db.run("CREATE TRIGGER reject_projection BEFORE INSERT ON forge_records WHEN NEW.kind IN ('relation-index','request-info') BEGIN SELECT RAISE(ABORT, 'projection was reevaluated'); END")
    db.query("UPDATE forge_records SET body = 'not JSON' WHERE workspace = ? AND kind IN ('snapshot','request')").run(dir)
  } finally { db.close() }
  const reopened = new Database(filename)
  try {
    const api = connect(reopened)
    await api.ready
    expect((await api.latest(dir, "private", "coding"))?.entries).toBe(2)
    expect((await api.latest("/other", "private", "coding"))?.sent).toBe(1)
    expect(reopened.query("SELECT count(*) AS count FROM forge_relations").get()).toEqual({ count: 2 })
  } finally { reopened.close(); await rm(dir, { recursive: true, force: true }) }
})

test("restart recovery atomically removes only affected search rows and rolls back on failure", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "forge-restart-atomic-"))
  const db = new Database(path.join(dir, "knowledge.sqlite"))
  db.query("PRAGMA journal_mode=WAL").all()
  const api = connect(db)
  const base: Collection = {
    id: "local", kind: "folder", label: "Manual", location: "/manuals", origin: "interface",
    session: "", include: [], exclude: [], watch: false, approved: true, providers: ["provider"],
    state: "ready", observed: 1, generation: "saved", files: 1, chunks: 1, warnings: [],
  }
  const collections = [
    base,
    { ...base, id: "interrupted", session: "private", state: "indexing" as const },
    { ...base, id: "paused", state: "paused" as const },
    { ...base, id: "upload", kind: "upload" as const },
  ]
  const documents = collections.map((item) => source(`${item.id}.md`, `restartcanary ${item.id}`, "document", {
    detail: { collection: item.id, session: item.session, providers: '["provider"]' },
  }))
  const run: ImportRun = {
    id: "run", collection: "interrupted", session: "private", started: 1, updated: 1,
    state: "running", stage: "extract", count: 0, withheld: 0, documents: [],
  }
  try {
    await api.ready
    for (const root of [dir, "/other"]) {
      for (const [index, item] of collections.entries()) await api.publish(root, item, [documents.at(index)!])
      await api.import(root, run)
    }
    const rows = () => db.query<{ workspace: string; id: string }, []>("SELECT workspace,id FROM forge_search ORDER BY workspace,id").all()
    const before = rows()
    db.run("CREATE TRIGGER reject_recovery BEFORE UPDATE ON forge_records WHEN NEW.kind = 'collection' AND json_extract(NEW.body, '$.state') = 'registered' BEGIN SELECT RAISE(ABORT, 'recovery failed'); END")
    expect(await api.recover(dir).then(() => undefined, (err: unknown) => err)).toMatchObject({ message: "recovery failed" })
    expect(rows()).toEqual(before)
    expect(await api.knowledge(dir, "private")).toEqual(expect.arrayContaining(documents))
    expect((await api.imports(dir, "interrupted", { session: "private" })).selected?.state).toBe("running")
    db.run("DROP TRIGGER reject_recovery")
    expect(await api.recover(dir)).toEqual(["local"])
    expect(rows()).toEqual(before.filter((row) => row.workspace !== dir || documents.slice(2).some((item) => item.id === row.id)))
    expect(await api.collection(dir, "local")).toMatchObject({ state: "registered", approved: true, providers: ["provider"] })
    expect(await api.collection(dir, "interrupted")).toMatchObject({ state: "failed", approved: false, providers: [], grants: {} })
    expect((await api.imports(dir, "interrupted", { session: "private" })).selected?.state).toBe("interrupted")
    expect((await api.knowledge(dir)).some((item) => item.detail.session === "private")).toBe(false)
    expect((await api.search(dir, "restartcanary", 20, { session: "private", provider: "provider" })).map((item) => item.source.id).sort())
      .toEqual(documents.slice(2).map((item) => item.id).sort())
    expect(await api.collection("/other", "interrupted")).toEqual(collections.at(1))
    await api.purge(dir, "local")
    expect(await api.source(dir, documents.at(0)!.id)).toBeUndefined()
    expect(await api.source("/other", documents.at(0)!.id)).toEqual(documents.at(0))
    // An orphaned running history record has no eligible source set to delete.
    await api.import(dir, { ...run, id: "orphan", collection: "absent" })
    const retained = rows()
    expect(await api.recover(dir)).toEqual([])
    expect(rows()).toEqual(retained)
    expect((await api.imports(dir, "absent", { session: "private" })).selected?.state).toBe("interrupted")
  } finally { db.close(); await rm(dir, { recursive: true, force: true }) }
})

test("persisted inventory status never implicitly scans repository files on reopen", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "forge-restart-status-"))
  const filename = path.join(dir, "knowledge.sqlite")
  const db = new Database(filename)
  try {
    const api = connect(db)
    await api.replace({
      root: dir, generation: "saved", revision: "revision", observed: 1, files: 1,
      partial: true, warnings: ["Saved partial coverage"], relations: [],
      sources: [source("old.ts", "saved file evidence", "code", { status: "unavailable" })],
    })
    await Bun.write(path.join(dir, "new.ts"), "export const neverScanned = true")
  } finally { db.close() }
  const reopened = new Database(filename)
  const api = engine({ root: dir, store: connect(reopened), complete: async () => { throw new Error("Unexpected inference") } })
  try {
    for (let index = 0; index < 3; index++) {
      const status = await api.status("private")
      expect(status.job.state).toBe("idle")
      expect(status.inventory).toMatchObject({
        generation: "saved", revision: "revision", files: 1, indexed: true,
        partial: true, counts: { code: 1 }, warnings: ["Saved partial coverage"],
      })
      const view = await api.view({ session: "private" })
      expect(view.sources.map((item) => item.uri)).toEqual(["old.ts"])
      expect(view.sources.at(0)?.status).toBe("unavailable")
    }
  } finally { await api.dispose(); reopened.close(); await rm(dir, { recursive: true, force: true }) }
})

for (const method of ["status", "view", "collections", "registry"] as const) {
  for (const kind of ["file", "folder"] as const) {
    test.each([false, true])(`first ${method} with a ${kind} collection invalidates saved evidence without scanning, watch=%s`, async (watch) => {
      const dir = await mkdtemp(path.join(os.tmpdir(), "forge-restart-reads-"))
      const filename = path.join(dir, "knowledge.sqlite")
      const location = path.join(dir, "docs", "notes.md")
      await Bun.write(location, "# Original\noldcanary")
      const db = new Database(filename)
      const initial = connect(db)
      const library = knowledge(dir, initial)
      const saved = await (async () => {
        try {
          const item = await library.register({ kind, label: "Private", location: kind === "file" ? location : path.dirname(location), session: "private", watch })
          await library.approve(item.id, "private", ["provider"])
          const collection = await library.index(item.id, "private")
          await initial.replace({
            root: dir, generation: "saved", revision: "revision", observed: 1, files: 1,
            partial: true, warnings: ["Saved partial coverage"], relations: [],
            sources: [source("persisted.ts", "saved repository evidence", "code")],
          })
          return { collection, history: await initial.imports(dir, item.id, { session: "private" }) }
        } finally { await library.dispose(); db.close() }
      })()
      await Bun.write(location, "# Changed\nnewcanary")
      await Bun.write(path.join(dir, "unscanned.ts"), "export const neverScanned = true")
      const reopened = new Database(filename)
      const storage = connect(reopened)
      const calls: string[] = []
      const api = engine({
        root: dir, store: storage,
        authorize: async () => { calls.push("authorize") },
        extract: async (...args) => { calls.push("extract"); return extract(...args) },
        complete: async () => { throw new Error("Unexpected inference") },
      })
      const read = (session: string) => {
        if (method === "status" || method === "collections") return api[method](session)
        return api[method]({ session })
      }
      try {
        const key = saved.collection.id
        await read("other")
        expect(await storage.collection(dir, key)).toMatchObject({ state: "registered", generation: saved.collection.generation, approved: true })
        expect((await storage.knowledge(dir, "private")).every((item) => item.status === "unavailable")).toBe(true)
        expect(await storage.search(dir, "oldcanary", 20, { session: "private", provider: "provider" })).toEqual([])
        for (let index = 0; index < 3; index++) await read("private")
        // Drain detached discovery before proving that inspection created no import run.
        await api.dispose()
        expect(calls).toEqual([])
        expect(await storage.imports(dir, key, { session: "private" })).toEqual(saved.history)
        expect((await storage.collection(dir, key))?.state).toBe("registered")
        const status = await storage.inventory(dir, "private")
        expect(status).toMatchObject({ indexed: true, files: 1, partial: true, counts: { document: 2, code: 1 } })
        expect(status.warnings.join(" ")).toContain("awaiting refresh")
        expect((await storage.inventory(dir, "other")).counts.document).toBeUndefined()
        expect((await storage.snapshot(dir))?.generation).toBe("saved")
        expect((await storage.view(dir, { session: "private" })).sources.some((item) => item.uri === "unscanned.ts")).toBe(false)
        const controls = knowledge(dir, storage)
        try {
          const current = await controls.index(key, "private")
          expect(current.generation).not.toBe(saved.collection.generation)
          expect((await storage.search(dir, "newcanary", 20, { session: "private", provider: "provider" })).length).toBeGreaterThan(0)
          expect(await storage.search(dir, "oldcanary", 20, { session: "private", provider: "provider" })).toEqual([])
          expect(await storage.search(dir, "newcanary", 20, { session: "other", provider: "provider" })).toEqual([])
          expect(await storage.search(dir, "newcanary", 20, { session: "private", provider: "denied" })).toEqual([])
          await controls.purge(key, "private")
          expect(await storage.knowledge(dir, "private")).toEqual([])
        } finally { await controls.dispose() }
      } finally { await api.dispose(); reopened.close(); await rm(dir, { recursive: true, force: true }) }
    })
  }
}
