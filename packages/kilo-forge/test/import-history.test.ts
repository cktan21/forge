import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { store } from "../src/store"
import { knowledge } from "../src/knowledge"
import { extract } from "../src/extract"
import type { ImportRun } from "../src/schema"

function open(filename: string) {
  const db = new Database(filename)
  const storage = store({
    all: async (query) => db.query<Record<string, unknown>, (string | number | null)[]>(query.text).all(...query.values ?? []),
    batch: async (queries) => { db.transaction(() => { for (const query of queries) db.query(query.text).run(...query.values ?? []) })() },
  })
  return { db, storage }
}

test("import history retains paged original file outcomes without excerpts or denied names", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "forge-import-history-")))
  const { db, storage } = open(":memory:")
  const library = knowledge(root, storage, { authorize: async (item) => { if (item.location.endsWith("withheld.md")) throw new Error("Denied") } })
  try {
    await mkdir(path.join(root, "docs"))
    await Bun.write(path.join(root, "docs/guide.md"), "# Rules\nPRIVATE_BODY_CANARY")
    await Bun.write(path.join(root, "docs/empty.txt"), " ")
    await Bun.write(path.join(root, "docs/broken.pdf"), "not a PDF")
    await Bun.write(path.join(root, "docs/withheld.md"), "PRIVATE_DENIED_CANARY")
    const item = await library.register({ kind: "folder", label: "Reference", location: "./docs", session: "private" })
    await library.approve(item.id, "private")
    await library.index(item.id, "private")
    const first = await storage.imports(root, item.id, { session: "private", limit: 1 })
    expect(first.runs).toHaveLength(1)
    expect(first.selected?.state).toBe("published")
    expect(first.selected?.count).toBe(3)
    expect(first.selected?.withheld).toBe(1)
    expect(first.page.next).toBe(1)
    expect(first.documents).toHaveLength(1)
    const all = await storage.imports(root, item.id, { session: "private", limit: 100 })
    expect(all.documents.find((item) => item.name === "guide.md")?.state).toBe("extracted")
    expect(all.documents.find((item) => item.name === "empty.txt")?.state).toBe("empty")
    expect(all.documents.find((item) => item.name === "broken.pdf")?.state).toBe("failed")
    expect(JSON.stringify(all)).not.toContain("PRIVATE_")
    expect(JSON.stringify(all)).not.toContain("withheld.md")
    expect("documents" in all.runs.at(0)!).toBe(false)
    expect((await storage.imports(root, item.id, { session: "other" })).runs).toEqual([])
    await library.index(item.id, "private")
    const second = await storage.imports(root, item.id, { session: "private" })
    expect(second.runs).toHaveLength(2)
    expect(second.documents.find((item) => item.name === "guide.md")?.state).toBe("reused")
    expect((await storage.imports(root, item.id, { session: "private", run: first.selected!.id })).documents.find((item) => item.name === "guide.md")?.state).toBe("extracted")
  } finally { await library.dispose(); db.close(); await rm(root, { recursive: true, force: true }) }
})

test("import retention, interrupted recovery, and purge survive a file-backed reopen", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "forge-import-reopen-")))
  const filename = path.join(root, "history.sqlite")
  const first = open(filename)
  const library = knowledge(root, first.storage)
  let key = ""
  try {
    const item = await library.register({ kind: "text", label: "Reference", location: "", content: "Body", session: "private" })
    key = item.id
    for (let index = 0; index < 18; index++) {
      const run: ImportRun = { id: `run-${index}`, collection: key, session: "private", started: index, updated: index, state: index === 17 ? "running" : "published", stage: "extract", count: 2, withheld: 0, documents: [{ name: "first.md", state: "extracted", bytes: 20, chunks: 2 }, { name: "next.md", state: "processing", bytes: 0, chunks: 0 }] }
      await first.storage.import(root, run)
    }
  } finally { await library.dispose(); first.db.close() }
  const second = open(filename)
  const resumed = knowledge(root, second.storage)
  try {
    await resumed.ready()
    const history = await second.storage.imports(root, key, { session: "private", offset: 1, limit: 1 })
    expect(history.runs).toHaveLength(16)
    expect(history.runs.some((run) => run.id === "run-0")).toBe(false)
    expect(history.selected?.state).toBe("interrupted")
    expect(history.selected?.finished).toBeGreaterThan(17)
    expect(history.documents).toEqual([{ name: "next.md", state: "processing", bytes: 0, chunks: 0 }])
    expect((await second.storage.imports("/other", key, { session: "private" })).runs).toEqual([])
    const guard = await second.storage.guard(root)
    await second.storage.purge(root, key)
    expect((await second.storage.imports(root, key, { session: "private" })).runs).toEqual([])
    const failure = await guard.run(() => second.storage.import(root, { ...history.selected!, documents: history.documents })).then(() => undefined, (err) => err)
    expect(failure).toBeInstanceOf(Error)
    expect((await second.storage.imports(root, key, { session: "private" })).runs).toEqual([])
  } finally { await resumed.dispose(); second.db.close(); await rm(root, { recursive: true, force: true }) }
})

test("cancelled extraction retains its attempted file without publishing new evidence", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "forge-import-cancel-")))
  const { db, storage } = open(":memory:")
  const entered = Promise.withResolvers<void>()
  const cancelled = Promise.withResolvers<void>()
  const gate = Promise.withResolvers<void>()
  const library = knowledge(root, storage, { extract: async (...args) => { args[2].addEventListener("abort", () => cancelled.resolve(), { once: true }); entered.resolve(); await gate.promise; return extract(...args) } })
  try {
    const item = await library.register({ kind: "text", label: "Reference", location: "", content: "Body" })
    await library.approve(item.id)
    const pending = library.index(item.id).then(() => undefined, (err) => err)
    const timeout = setTimeout(() => entered.reject(new Error("Extraction did not start")), 5000)
    try {
      await entered.promise
      const stopped = library.stop(item.id)
      await cancelled.promise
      gate.resolve()
      expect(await pending).toBeInstanceOf(Error)
      await stopped
      const history = await storage.imports(root, item.id)
      expect(history.selected?.state).toBe("cancelled")
      expect(history.documents.at(0)?.state).toBe("cancelled")
      expect(await storage.knowledge(root)).toEqual([])
    } finally { clearTimeout(timeout); gate.resolve(); await pending }
  } finally { await library.dispose(); db.close(); await rm(root, { recursive: true, force: true }) }
})

test("history write failures roll back collection progress and evidence publication", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "forge-import-atomic-")))
  const { db, storage } = open(":memory:")
  const library = knowledge(root, storage)
  try {
    const item = await library.register({ kind: "text", label: "Reference", location: "", content: "# Manual\nAtomic publication evidence" })
    await library.approve(item.id, "", ["local"])
    const collection = await library.index(item.id)
    const sources = await storage.knowledge(root)
    const matches = await storage.search(root, "Atomic", 10, { provider: "local" })
    expect(matches.length).toBeGreaterThan(0)
    const history = await storage.imports(root, item.id)
    const run: ImportRun = { ...history.selected!, id: "rejected", state: "failed", documents: history.documents }
    const events: unknown[] = []
    const unsubscribe = storage.subscribe(root, (event) => events.push(event))
    // Abort the final history insert after preceding collection/source statements execute.
    db.run("CREATE TRIGGER reject_import BEFORE INSERT ON forge_records WHEN NEW.kind = 'import' AND NEW.id = 'rejected' BEGIN SELECT RAISE(ABORT, 'history write failed'); END")
    try {
      expect(await storage.save(root, { ...collection, state: "indexing" }, run).then(() => undefined, (err: unknown) => err)).toMatchObject({ message: "history write failed" })
      expect(await storage.collection(root, item.id)).toEqual(collection)
      expect(await storage.publish(root, { ...collection, state: "failed" }, [], run).then(() => undefined, (err: unknown) => err)).toMatchObject({ message: "history write failed" })
      expect(await storage.collection(root, item.id)).toEqual(collection)
      expect(await storage.knowledge(root)).toEqual(sources)
      expect(await storage.imports(root, item.id)).toEqual(history)
      expect(await storage.search(root, "Atomic", 10, { provider: "local" })).toEqual(matches)
      expect(events).toEqual([])
    } finally { unsubscribe() }
  } finally { await library.dispose(); db.close(); await rm(root, { recursive: true, force: true }) }
})
