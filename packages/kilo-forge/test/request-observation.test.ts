import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { store } from "../src/store"
import { knowledge } from "../src/knowledge"
import { usage, type Manifest } from "../src/schema"

function open(file = ":memory:") {
  const db = new Database(file)
  const api = store({
    all: async (query) =>
      db.query<Record<string, unknown>, (string | number | null)[]>(query.text).all(...(query.values ?? [])),
    batch: async (queries) =>
      db.transaction(() => {
        for (const query of queries) db.query(query.text).run(...(query.values ?? []))
      })(),
  })
  return {
    db,
    api,
    [Symbol.dispose]() {
      db.close()
    },
  }
}
const item: Manifest = {
  id: "request",
  root: "/fixture",
  session: "chat",
  purpose: "coding",
  model: "local",
  observed: 1,
  generation: "fixture",
  entries: [],
  coverage: [],
  state: "assembled",
  usage: usage(),
  attempts: [],
  discarded: 0,
}

test("request observation counts admissions once and revisions include body outcomes", async () => {
  using f = open()
  const initial = await f.api.requestObservation(item.root)
  expect(initial).toMatchObject({ admitted: 0, deleted: false, before: "unknown" })
  await f.api.manifest(item)
  const first = await f.api.requestObservation(item.root)
  expect(first.admitted).toBe(1)
  expect(first.revision).not.toBe(initial.revision)
  await f.api.manifest({ ...item, state: "completed" })
  const finished = await f.api.requestObservation(item.root)
  expect(finished.admitted).toBe(1)
  expect(finished.revision).not.toBe(first.revision)
  f.db
    .query("INSERT OR REPLACE INTO forge_records(workspace,kind,id,body,updated) VALUES(?,?,?,?,?)")
    .run(item.root, "request", item.id, JSON.stringify({ ...item, state: "failed" }), 2)
  expect((await f.api.requestObservation(item.root)).admitted).toBe(1)
  const stable = await f.api.requestObservation(item.root)
  await f.api.requestObservation("/other")
  await f.api.manifest({ ...item, root: "/other" })
  expect(await f.api.requestObservation(item.root)).toEqual(stable)
})

test("request pruning cannot look like complete smaller history", async () => {
  using f = open()
  await f.api.requestObservation(item.root)
  for (let index = 0; index < 205; index++) await f.api.manifest({ ...item, id: `request-${index}` })
  const observation = await f.api.requestObservation(item.root)
  expect(observation).toMatchObject({ admitted: 205, deleted: true })
  expect(await f.api.manifests(item.root, { limit: 100 })).toHaveLength(100)
  expect(await f.api.manifests(item.root, { limit: 100, offset: 100 })).toHaveLength(100)
  expect(await f.api.manifests(item.root, { offset: 200 })).toHaveLength(0)
})

test("request history survives actual privacy purge without retaining content", async () => {
  using f = open()
  const library = knowledge(item.root, f.api)
  try {
    const collection = await library.register({
      kind: "text",
      label: "Purge",
      location: "",
      content: "Request observation purge canary",
    })
    await f.api.manifest(item)
    const before = await f.api.requestObservation(item.root)
    await library.purge(collection.id)
    const after = await f.api.requestObservation(item.root)
    expect(after).toMatchObject({ admitted: 1, deleted: true, since: before.since })
    expect(after.revision).not.toBe(before.revision)
    expect(await f.api.manifests(item.root)).toEqual([])
    expect(JSON.stringify(after)).not.toContain("canary")
    await f.api.manifest({ ...item, id: "new" })
    expect(await f.api.requestObservation(item.root)).toMatchObject({ admitted: 2, deleted: true })
  } finally {
    await library.dispose()
  }
})

test("other connections, rollback and restart preserve request observation", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "forge-request-history-"))
  const file = path.join(dir, "store.sqlite")
  try {
    using f = open(file)
    const before = await f.api.requestObservation(item.root)
    {
      using second = open(file)
      await second.api.manifest(item)
      const next = await f.api.requestObservation(item.root)
      expect(next).toMatchObject({ admitted: 1, deleted: false, since: before.since })
      expect(next.revision).not.toBe(before.revision)
      expect(await second.api.requestObservation(item.root)).toEqual(next)
      expect(() =>
        second.db.transaction(() => {
          second.db.query("DELETE FROM forge_records WHERE workspace=? AND kind='request'").run(item.root)
          throw new Error("rollback")
        })(),
      ).toThrow("rollback")
      expect(await f.api.requestObservation(item.root)).toEqual(next)
    }
    using reopened = open(file)
    expect(await reopened.api.requestObservation(item.root)).toEqual(await f.api.requestObservation(item.root))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("migration preserves legacy requests and marks only known earlier deletion", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "forge-request-migration-"))
  const file = path.join(dir, "store.sqlite")
  try {
    {
      using db = new Database(file)
      db.exec(
        "CREATE TABLE forge_records (workspace TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY(workspace,kind,id))",
      )
      const insert = db.query("INSERT INTO forge_records VALUES(?,?,?,?,?)")
      insert.run(item.root, "request", item.id, JSON.stringify(item), 1)
      insert.run("/purged", "purge-epoch", "current", JSON.stringify("known-purge"), 1)
    }
    using f = open(file)
    expect(await f.api.requestObservation(item.root)).toMatchObject({ admitted: 1, deleted: false, before: "unknown" })
    expect(await f.api.requestObservation("/purged")).toMatchObject({ admitted: 0, deleted: true, before: "unknown" })
    expect(await f.api.request(item.root, "chat", item.id)).toEqual(item)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
