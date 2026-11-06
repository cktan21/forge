import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { knowledge } from "../src/knowledge"
import { store, type Query } from "../src/store"

test("document lookups migrate on disk and preserve scoped originals through publication", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "forge-document-index-"))
  const file = path.join(root, "catalog.sqlite")
  let db = new Database(file)
  const queries: Query[] = []
  const sql = {
    all: async (query: Query) => {
      queries.push(query)
      return db.query<Record<string, unknown>, (string | number | null)[]>(query.text).all(...query.values ?? [])
    },
    batch: async (queries: readonly Query[]) => {
      db.transaction(() => { for (const query of queries) db.query(query.text).run(...query.values ?? []) })()
    },
  }
  const initial = store(sql)
  const library = knowledge(root, initial)
  try {
    const directory = path.join(root, "docs")
    for (let index = 0; index < 600; index++) {
      await Bun.write(path.join(directory, `${index}.md`), `# Procedure ${index}\nVerify checkpoint ${index} before restoring service.`)
    }
    const item = await library.register({ kind: "folder", label: "Procedures", location: directory, session: "private" })
    await library.approve(item.id, "private", ["approved"])
    const indexed = await library.index(item.id, "private")
    expect(indexed.state).toBe("ready")
    // Capture legacy enumeration before opening with the new partial index.
    db.run("DROP INDEX IF EXISTS forge_sources_document")
    const originals = await initial.knowledge(root, "private")
    expect(originals).toHaveLength(1200)
    const document = { collection: item.id, name: "42.md" }
    const expected = originals.filter((source) => source.detail.document === document.name)
    expect(expected).toHaveLength(2)
    // Exercise opening a populated database from before the document index.
    await library.dispose()
    db.close()
    db = new Database(file)
    const current = store(sql)
    await current.ready
    expect(await current.knowledge(root, "private")).toEqual(originals)
    expect(await current.knowledge(root, "private", "approved", document)).toEqual(expected)
    const query = queries.at(-1)!
    const plan = db.query<{ detail: string }, (string | number | null)[]>(`EXPLAIN QUERY PLAN ${query.text}`).all(...query.values ?? [])
    expect(plan.some((row) => row.detail.includes("forge_sources_document") &&
      row.detail.includes("workspace=? AND <expr>=? AND <expr>=?"))).toBe(true)
    expect(await current.knowledge(root, "other", "approved", document)).toEqual([])
    expect(await current.knowledge(root, "private", "denied", document)).toEqual([])
    expect(await current.knowledge("/other", "private", "approved", document)).toEqual([])
    expect(await current.knowledge(root, "private", undefined, { ...document, collection: "missing" })).toEqual([])
    expect(await current.knowledge(root, "private", undefined, { ...document, name: "missing.md" })).toEqual([])
    expect(await current.knowledge(root, "private", undefined, document)).toEqual(expected)

    const moved = originals.map((source) => source.detail.document === document.name
      ? { ...source, detail: { ...source.detail, document: "renamed.md" } }
      : source)
    db.run("CREATE TRIGGER reject_document BEFORE INSERT ON forge_sources WHEN json_extract(NEW.body, '$.detail.document') = 'renamed.md' BEGIN SELECT RAISE(ABORT, 'publication failure'); END")
    const error = await current.publish(root, indexed, moved).then(() => undefined, (error: unknown) => error)
    expect(error).toBeInstanceOf(Error)
    expect(String(error)).toContain("publication failure")
    expect(await current.knowledge(root, "private", undefined, document)).toEqual(expected)
    expect(await current.knowledge(root, "private", undefined, { ...document, name: "renamed.md" })).toEqual([])
    db.run("DROP TRIGGER reject_document")
    await current.publish(root, indexed, moved)
    expect(await current.knowledge(root, "private", undefined, document)).toEqual([])
    expect(await current.knowledge(root, "private", undefined, { ...document, name: "renamed.md" }))
      .toEqual(moved.filter((source) => source.detail.document === "renamed.md"))
    // Opening again retains the existing index and records without re-extraction.
    const reopened = store(sql)
    await reopened.ready
    expect((await reopened.knowledge(root, "private")).sort((a, b) => a.id.localeCompare(b.id)))
      .toEqual([...moved].sort((a, b) => a.id.localeCompare(b.id)))
    await reopened.purge(root, item.id)
    expect(await reopened.knowledge(root, "private")).toEqual([])
    expect(await reopened.knowledge(root, "private", undefined, { ...document, name: "renamed.md" })).toEqual([])
  } finally {
    await library.dispose()
    db.close()
    await rm(root, { recursive: true, force: true })
  }
})
