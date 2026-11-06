import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { store, type Query } from "../src/store"
import { source } from "../src/parse"
import type { Collection } from "../src/schema"

test("collection indexing bounds recovery reads while preserving workspace and session isolation", async () => {
  const db = new Database(":memory:")
  const queries: Query[] = []
  const sql = {
    all: async (query: Query) => {
      queries.push(query)
      return db.query<Record<string, unknown>, (string | number | null)[]>(query.text).all(...query.values ?? [])
    },
    batch: async (batch: readonly Query[]) => {
      queries.push(...batch)
      db.transaction(() => {
        for (const query of batch) db.query(query.text).run(...query.values ?? [])
      })()
    },
  }
  try {
    // Seed a legacy source table before the new index exists.
    db.run("CREATE TABLE forge_sources (workspace TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(workspace, id))")
    const legacy = source("legacy.md", "legacy document", "document", { detail: { collection: "legacy" } })
    db.query("INSERT INTO forge_sources VALUES(?,?,?)").run("/legacy", legacy.id, JSON.stringify(legacy))
    const api = store(sql)
    expect(await api.knowledge("/legacy")).toEqual([legacy])
    const root = "/recovery"
    const repository = Array.from({ length: 1000 }, (_, index) => source(`${index}.ts`, `repositorycanary ${index}`, "code"))
    await api.replace({
      root, generation: "repository", revision: "", observed: 1, files: repository.length,
      partial: false, warnings: [], sources: repository, relations: [],
    })
    const ready: Collection = {
      id: "ready", kind: "folder", label: "Ready", location: "/documents", origin: "interface",
      session: "", include: [], exclude: [], watch: true, approved: true, providers: ["provider"],
      state: "ready", observed: 1, generation: "first", files: 1, chunks: 1, warnings: [],
    }
    const interrupted = { ...ready, id: "interrupted", session: "private", state: "indexing" as const }
    const paused = { ...ready, id: "paused", state: "paused" as const }
    const uploaded = { ...ready, id: "uploaded", kind: "upload" as const }
    const collections = [ready, interrupted, paused, uploaded]
    const documents = collections.map((item) => source(`${item.id}.md`, `documentcanary ${item.id}`, "document", {
      detail: { collection: item.id, session: item.session, providers: '["provider"]' },
    }))
    for (const workspace of [root, "/other"]) {
      for (const [index, collection] of collections.entries()) {
        await api.publish(workspace, collection, [documents.at(index)!])
      }
    }
    queries.length = 0
    expect(await api.recover(root)).toEqual(["ready"])
    expect(await api.collection(root, ready.id)).toMatchObject({ state: "registered", approved: true, providers: ["provider"] })
    expect(await api.collection(root, interrupted.id)).toMatchObject({ state: "failed", approved: false, providers: [] })
    expect(await api.source(root, documents.at(0)!.id)).toMatchObject({ status: "unavailable" })
    expect(await api.source(root, documents.at(1)!.id)).toMatchObject({ status: "unavailable", detail: { providers: "[]" } })
    expect(await api.source(root, repository.at(0)!.id)).toEqual(repository.at(0))
    expect(await api.collection(root, paused.id)).toEqual(paused)
    expect(await api.collection(root, uploaded.id)).toEqual(uploaded)
    expect(await api.source("/other", documents.at(0)!.id)).toEqual(documents.at(0))
    expect(await api.collection("/other", interrupted.id)).toEqual(interrupted)
    expect((await api.knowledge(root)).map((item) => item.id).sort()).toEqual(documents.filter((item) => !item.detail.session).map((item) => item.id).sort())
    expect((await api.knowledge(root, "private")).length).toBe(4)
    expect((await api.knowledge(root, "", "different")).length).toBe(0)
    expect((await api.search(root, "documentcanary", 20, { session: "private", provider: "provider" })).map((item) => item.source.id).sort())
      .toEqual(documents.slice(2).map((item) => item.id).sort())
    const updates = queries.filter((query) => query.text.startsWith("UPDATE forge_sources"))
    const reads = queries.filter((query) => query.text.startsWith("SELECT body FROM forge_sources") && query.text.includes("IS NOT NULL"))
    expect(updates).toHaveLength(2)
    expect(reads.length).toBeGreaterThan(0)
    for (const query of [...updates, ...reads]) {
      const statement = db.prepare<{ detail: string }, (string | number | null)[]>(`EXPLAIN QUERY PLAN ${query.text}`)
      try {
        const plan = statement.all(...query.values ?? [])
        expect(plan.some((row) => row.detail.includes("forge_sources_collection"))).toBe(true)
      } finally {
        statement.finalize()
      }
    }
    const reopened = store(sql)
    await reopened.ready
    expect((await reopened.knowledge(root, "private")).length).toBe(4)
    expect(await reopened.knowledge("/legacy")).toEqual([legacy])
    expect(await reopened.source(root, repository.at(0)!.id)).toEqual(repository.at(0))
  } finally {
    db.close()
  }
})
