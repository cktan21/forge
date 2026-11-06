import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { rejects } from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { embeddings } from "../src/embeddings"
import { account } from "../src/embedding-usage"
import { knowledge } from "../src/knowledge"
import { store, type Query } from "../src/store"
import { decode, EmbeddingAttempt } from "../src/schema"

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "forge-retention-"))
  const db = new Database(path.join(root, "state.sqlite"))
  const state = { denied: false, writes: undefined as ((queries: readonly Query[]) => Promise<void>) | undefined }
  const storage = store({
    all: async (query) =>
      db.query<Record<string, unknown>, (string | number | null)[]>(query.text).all(...(query.values ?? [])),
    batch: async (queries) => {
      await state.writes?.(queries)
      db.transaction(() => {
        for (const query of queries) db.query(query.text).run(...(query.values ?? []))
      })()
    },
  })
  const library = knowledge(root, storage)
  const collection = await library.register({ kind: "text", label: "Reference", location: "", content: "Original" })
  const api = embeddings({
    root,
    store: storage,
    library,
    configuration: async () => {
      throw new Error("Retention must not configure a provider")
    },
    authorize: async () => {
      if (state.denied) throw new Error("Local permission denied")
    },
  })
  async function admit(id: string, started: number, session = "chat", pending = false) {
    const entry = decode(EmbeddingAttempt, {
      id,
      session,
      started,
      purpose: "query" as const,
      collections: [collection.id],
      target: { fingerprint: "fixture", model: "unused", dimensions: 2 },
      usage: account(undefined, { state: "attempt", inputs: 1, bytes: 40 }),
    })
    await storage.embeddingAttemptSave(root, entry)
    if (!pending)
      await storage.embeddingAttemptSave(
        root,
        {
          ...entry,
          finished: started + 1,
          usage: account(entry.usage, { state: "response", total: 7 }),
        },
        entry,
      )
    return entry
  }
  return {
    root,
    db,
    storage,
    library,
    collection,
    api,
    state,
    admit,
    async [Symbol.asyncDispose]() {
      await api.dispose()
      await library.dispose()
      db.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}

const policy = { session: "chat", before: 100, keep: 1 }

test("retention preview is read-only and confirmed pruning preserves pending, recent and foreign attempts", async () => {
  await using fixture = await setup()
  await fixture.admit("expired", 1)
  await fixture.admit("pending", 2, "chat", true)
  await fixture.admit("foreign", 3, "other")
  await fixture.admit("young", 200)
  await fixture.admit("newest", 4)
  const before = await fixture.api.usage({ session: "chat" })
  const preview = await fixture.api.retention(policy)
  expect(preview).toMatchObject({ ...policy, selected: 1, more: false, limit: 100 })
  expect(await fixture.api.usage({ session: "chat" })).toEqual(before)
  await rejects(fixture.api.prune({ ...policy, revision: preview.revision, confirmation: "wrong" }), /confirmation/)
  expect((await fixture.api.usage({ session: "chat" })).entries).toHaveLength(4)
  expect(await fixture.api.prune({ ...policy, revision: preview.revision, confirmation: "DELETE" })).toEqual({
    deleted: 1,
    more: false,
  })
  const after = await fixture.api.usage({ session: "chat" })
  expect(after.entries.map((entry) => entry.id)).toEqual(["newest", "young", "pending"])
  expect(after.observation!.deleted).toBe(true)
  expect((await fixture.api.usage({ session: "other" })).entries.map((entry) => entry.id)).toEqual(["foreign"])
  expect(await fixture.storage.collection(fixture.root, fixture.collection.id)).toBeDefined()
  await rejects(fixture.api.prune({ ...policy, revision: preview.revision, confirmation: "DELETE" }), /changed/)
})

test("retention is bounded to 100 oldest eligible attempts and needs a fresh preview for each batch", async () => {
  await using fixture = await setup()
  for (let index = 0; index < 205; index++) await fixture.admit(`entry-${index}`, 1)
  const request = { ...policy, keep: 0 }
  for (const count of [100, 100, 5]) {
    const preview = await fixture.api.retention(request)
    expect(preview.selected).toBe(count)
    expect(preview.more).toBe(count === 100)
    const result = await fixture.api.prune({ ...request, revision: preview.revision, confirmation: "DELETE" })
    expect(result.deleted).toBe(count)
  }
  expect((await fixture.api.usage({ session: "chat" })).entries).toEqual([])
})

test("retention rejects denied, cancelled, changed and malformed requests without deletion", async () => {
  await using fixture = await setup()
  await fixture.admit("one", 1)
  const request = { ...policy, keep: 0 }
  const preview = await fixture.api.retention(request)
  fixture.state.denied = true
  await rejects(fixture.api.retention(request), /Local permission denied/)
  await rejects(
    fixture.api.prune({ ...request, revision: preview.revision, confirmation: "DELETE" }),
    /Local permission denied/,
  )
  fixture.state.denied = false
  const controller = new AbortController()
  controller.abort(new Error("Cancelled retention"))
  await rejects(
    fixture.api.prune({ ...request, revision: preview.revision, confirmation: "DELETE" }, controller.signal),
    /Cancelled retention/,
  )
  await rejects(
    fixture.api.prune({ ...request, keep: 1, revision: preview.revision, confirmation: "DELETE" }),
    /changed/,
  )
  for (const keep of [-1, 1.5, 1_000_001]) await rejects(fixture.api.retention({ ...request, keep }), /keep/)
  for (const before of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1])
    await rejects(fixture.api.retention({ ...request, before }), /cutoff/)
  await fixture.admit("two", 2)
  await rejects(fixture.api.prune({ ...request, revision: preview.revision, confirmation: "DELETE" }), /changed/)
  expect((await fixture.api.usage({ session: "chat" })).entries).toHaveLength(2)
})

for (const change of ["admission", "policy", "purge"] as const)
  test(`retention transaction rejects ${change} after its final authorization check`, async () => {
    await using fixture = await setup()
    await fixture.admit("one", 1)
    const request = { ...policy, keep: 0 }
    const preview = await fixture.api.retention(request)
    const entered = Promise.withResolvers<void>()
    const released = Promise.withResolvers<void>()
    fixture.state.writes = async (queries) => {
      if (!queries.some((query) => query.text.includes("kind = 'embedding-attempt' AND id IN"))) return
      entered.resolve()
      await released.promise
    }
    const pending = fixture.api.prune({ ...request, revision: preview.revision, confirmation: "DELETE" })
    const rejected = rejects(pending)
    try {
      await entered.promise
      if (change === "admission") await fixture.admit("two", 2)
      if (change === "policy")
        await fixture.storage.policySave(fixture.root, { version: "changed", session: "chat", pin: [], exclude: [] })
      if (change === "purge") await fixture.storage.purge(fixture.root, fixture.collection.id)
      released.resolve()
      await rejected
      expect((await fixture.api.usage({ session: "chat" })).entries).toHaveLength(
        change === "purge" ? 0 : change === "admission" ? 2 : 1,
      )
    } finally {
      released.resolve()
    }
  })

test("retention uses completion age and admission order rather than start timestamps", async () => {
  await using fixture = await setup()
  const entry = await fixture.admit("just-finished", 1, "chat", true)
  await fixture.storage.embeddingAttemptSave(
    fixture.root,
    {
      ...entry,
      finished: 100,
      usage: account(entry.usage, { state: "response" }),
    },
    entry,
  )
  await fixture.admit("old-finish", 1)
  await fixture.admit("latest-admission", 0)
  const preview = await fixture.api.retention(policy)
  expect(preview.selected).toBe(1)
  await fixture.api.prune({ ...policy, revision: preview.revision, confirmation: "DELETE" })
  expect((await fixture.api.usage({ session: "chat" })).entries.map((entry) => entry.id)).toEqual([
    "latest-admission",
    "just-finished",
  ])
})

test("duplicate confirmations delete once and late outcomes never restore pruned history", async () => {
  await using fixture = await setup()
  const entry = await fixture.admit("one", 1)
  const request = { ...policy, keep: 0 }
  const preview = await fixture.api.retention(request)
  const results = await Promise.allSettled(
    Array.from({ length: 2 }, () =>
      fixture.api.prune({ ...request, revision: preview.revision, confirmation: "DELETE" }),
    ),
  )
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
  await fixture.storage.embeddingAttemptSave(
    fixture.root,
    { ...entry, finished: 2, usage: account(entry.usage, { state: "response", total: 7 }) },
    entry,
  )
  const before = await fixture.api.usage({ session: "chat" })
  expect(before.entries).toEqual([])
  const empty = await fixture.api.retention(request)
  expect(empty.selected).toBe(0)
  expect(await fixture.api.prune({ ...request, revision: empty.revision, confirmation: "DELETE" })).toEqual({
    deleted: 0,
    more: false,
  })
  expect(await fixture.api.usage({ session: "chat" })).toEqual(before)
})
