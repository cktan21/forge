import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { rejects } from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { exportEmbeddings } from "../src/embedding-export"
import { account } from "../src/embedding-usage"
import { knowledge } from "../src/knowledge"
import { store } from "../src/store"
import type { EmbeddingAttempt } from "../src/schema"

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "forge-ledger-observation-"))
  const databases: Database[] = []
  function connect() {
    const db = new Database(path.join(root, "state.sqlite"))
    databases.push(db)
    db.run("PRAGMA journal_mode=WAL")
    const storage = store({
      all: async (query) =>
        db.query<Record<string, unknown>, (string | number | null)[]>(query.text).all(...(query.values ?? [])),
      batch: async (queries) =>
        db.transaction(() => {
          for (const query of queries) db.query(query.text).run(...(query.values ?? []))
        })(),
    })
    return { db, storage }
  }
  const first = connect()
  const library = knowledge(root, first.storage)
  const collection = await library.register({
    kind: "text",
    label: "Reference",
    location: "",
    content: "Private original",
  })
  const entry = (id: string): EmbeddingAttempt => ({
    id,
    session: "chat",
    collections: [collection.id],
    target: { fingerprint: "fixture", model: "never-called", dimensions: 2 },
    purpose: "query",
    started: Date.now(),
    usage: account(undefined, { state: "attempt", inputs: 1, bytes: 40 }),
  })
  return {
    root,
    ...first,
    library,
    collection,
    connect,
    entry,
    async [Symbol.asyncDispose]() {
      await library.dispose()
      for (const db of databases) db.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}

test("ledger observations persist through reopen without inventing earlier completeness", async () => {
  await using fixture = await setup()
  const first = await fixture.storage.embeddingLedger(fixture.root, "chat")
  expect(first.observation).toMatchObject({ before: "unknown", deleted: false })
  expect(first.observation!.revision).toMatch(/^[0-9a-f]{32}$/)
  expect(first.observation!.since).toBeGreaterThan(0)
  expect((await fixture.connect().storage.embeddingLedger(fixture.root, "chat")).observation).toEqual(first.observation)
  await fixture.storage.embeddingAttemptSave(fixture.root, fixture.entry("one"))
  const second = await fixture.storage.embeddingLedger(fixture.root, "chat")
  expect(second.observation!.revision).not.toBe(first.observation!.revision)
  expect(second.observation!.since).toBe(first.observation!.since)
  const value = await exportEmbeddings({
    session: "chat",
    read: (request) => fixture.storage.embeddingLedger(fixture.root, request.session, request.after, 1),
  })
  expect(value).toMatchObject({
    consistency: "revision-checked",
    snapshot: false,
    observation: second.observation,
    history: "recorded-admissions-only",
  })
})

for (const change of ["admission", "outcome", "policy", "collection", "purge", "deletion"] as const) {
  test(`export rejects ${change} from another connection between pages`, async () => {
    await using fixture = await setup()
    const first = fixture.entry("one")
    await fixture.storage.embeddingAttemptSave(fixture.root, first)
    await fixture.storage.embeddingAttemptSave(fixture.root, fixture.entry("two"))
    const other = fixture.connect()
    await other.storage.ready
    await rejects(
      exportEmbeddings({
        session: "chat",
        read: async (request) => {
          const page = await fixture.storage.embeddingLedger(fixture.root, request.session, request.after, 1)
          if (request.after != null) return page
          if (change === "admission") await other.storage.embeddingAttemptSave(fixture.root, fixture.entry("three"))
          if (change === "outcome")
            await other.storage.embeddingAttemptSave(
              fixture.root,
              { ...first, finished: Date.now(), usage: account(first.usage, { state: "response", total: 7 }) },
              first,
            )
          if (change === "policy")
            await other.storage.policySave(fixture.root, { version: "changed", session: "chat", pin: [], exclude: [] })
          if (change === "collection")
            await other.storage.publish(fixture.root, { ...fixture.collection, approved: true }, [])
          if (change === "purge") await other.storage.purge(fixture.root, fixture.collection.id)
          if (change === "deletion")
            other.db
              .query("DELETE FROM forge_records WHERE workspace = ? AND kind = 'embedding-attempt' AND id = ?")
              .run(fixture.root, first.id)
          return page
        },
      }),
      /changed during embedding usage export/,
    )
  })
}

test("purge retains only non-content history limits and never resurrects an outcome", async () => {
  await using fixture = await setup()
  const entry = fixture.entry("one")
  await fixture.storage.embeddingAttemptSave(fixture.root, entry)
  const before = await fixture.storage.embeddingLedger(fixture.root, "chat")
  await fixture.storage.purge(fixture.root, fixture.collection.id)
  await fixture.storage.embeddingAttemptSave(
    fixture.root,
    { ...entry, finished: Date.now(), usage: account(entry.usage, { state: "response" }) },
    entry,
  )
  const after = await fixture.connect().storage.embeddingLedger(fixture.root, "chat")
  expect(after.entries).toEqual([])
  expect(after.observation).toMatchObject({ before: "unknown", deleted: true, since: before.observation!.since })
  expect(after.observation!.revision).not.toBe(before.observation!.revision)
  expect(JSON.stringify(after.observation)).not.toMatch(/Private original|Reference|never-called|chat|fixture/)
})

test("failed writes leave the observation unchanged and other workspaces stay isolated", async () => {
  await using fixture = await setup()
  const entry = fixture.entry("one")
  await fixture.storage.embeddingAttemptSave(fixture.root, entry)
  const before = await fixture.storage.embeddingLedger(fixture.root, "chat")
  await rejects(fixture.storage.embeddingAttemptSave(fixture.root, entry))
  await fixture.storage.policySave(fixture.root + "-other", { version: "other", session: "chat", pin: [], exclude: [] })
  expect(await fixture.storage.embeddingLedger(fixture.root, "chat")).toEqual(before)
})

test("migration preserves legacy attempts and known purge without claiming earlier coverage", async () => {
  await using fixture = await setup()
  const entry = { ...fixture.entry("legacy"), started: 1 }
  await fixture.storage.embeddingAttemptSave(fixture.root, entry)
  fixture.db.exec(`
    DROP TRIGGER forge_embedding_history_insert;
    DROP TRIGGER forge_embedding_history_update;
    DROP TRIGGER forge_embedding_history_delete;
    DROP TABLE forge_embedding_history;
    DELETE FROM forge_records WHERE kind = 'embedding-history-index';
  `)
  fixture.db
    .query("INSERT INTO forge_records(workspace,kind,id,body,updated) VALUES(?,'purge-epoch','current',?,1)")
    .run(fixture.root, JSON.stringify("legacy-purge"))
  const page = await fixture.connect().storage.embeddingLedger(fixture.root, "chat")
  expect(page.entries).toEqual([entry])
  expect(page.observation).toMatchObject({ before: "unknown", deleted: true })
  expect(page.observation!.since).toBeGreaterThan(entry.started)
  expect((await fixture.connect().storage.embeddingLedger(fixture.root, "chat")).observation).toEqual(page.observation)
})
