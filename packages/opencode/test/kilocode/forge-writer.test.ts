import { expect, test } from "bun:test"
import { Database as Native } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import { setTimeout as delay } from "node:timers/promises"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { writer } from "@/kilocode/forge/writer"
import { storage } from "@/kilocode/forge/storage"
import { embeddingConsent } from "@kilocode/forge/embedding-consent"
import type { Collection } from "@kilocode/forge/schema"
import { rejects } from "node:assert/strict"

test("worker transactions roll back failures and shutdown waits for an admitted batch", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "forge-writer-"))
  const file = path.join(dir, "test.db")
  const db = new Native(file)
  db.run("PRAGMA journal_mode=WAL; CREATE TABLE evidence (id TEXT PRIMARY KEY, body TEXT NOT NULL)")
  const worker = await writer(file)
  try {
    await worker.batch([{ text: "INSERT INTO evidence VALUES(?,?)", values: ["source", "original"] }])
    const failure = await worker.batch([
      ...Array.from({ length: 40 }, (_, index) => ({ text: "UPDATE evidence SET body = ?", values: [`uncommitted-${index}`] })),
      { text: "INSERT INTO missing_table VALUES(?)", values: ["fail"] },
    ]).then(() => undefined, (err: unknown) => err)
    expect(failure).toBeInstanceOf(Error)
    expect(db.query("SELECT body FROM evidence").get()).toEqual({ body: "original" })
    db.run("BEGIN IMMEDIATE")
    const pending = worker.batch(Array.from({ length: 40 }, () => ({ text: "UPDATE evidence SET body = ?", values: ["first"] })))
    const later = worker.batch(Array.from({ length: 40 }, () => ({ text: "UPDATE evidence SET body = ?", values: ["committed"] })))
    const closing = worker.close()
    // A busy writer must not block the main loop that releases the competing lock.
    await delay(30)
    expect(db.query("SELECT body FROM evidence").get()).toEqual({ body: "original" })
    db.run("COMMIT")
    await pending
    await later
    await closing
    expect(db.query("SELECT body FROM evidence").get()).toEqual({ body: "committed" })
    expect(await worker.batch([]).then(() => undefined, (err: unknown) => String(err))).toContain("closed")
  } finally {
    await worker.close()
    db.close()
    await rm(dir, { recursive: true, force: true })
  }
}, 10_000)

test("file-backed worker keeps the host write lease while independent reads remain available", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "forge-writer-lease-"))
  const file = path.join(dir, "test.db")
  try {
    await Effect.runPromise(Effect.gen(function* () {
      const { db } = yield* Database.Service
      const api = yield* storage
      yield* Effect.promise(() => api.ready)
      const root = "/lease"
      yield* Effect.promise(() => api.content(root, "source", "original"))
      const external = new Native(file, { create: false, readwrite: true })
      try {
        external.run("BEGIN IMMEDIATE")
        const pending = api.content(root, "source", "forge")
        // Let publication acquire the shared host connection before the core write.
        yield* Effect.promise(() => delay(30))
        const run = Effect.runPromiseWith(yield* Effect.context())
        let finished = false
        const core = run(db.run(sql`UPDATE forge_records SET body = ${JSON.stringify("core")} WHERE workspace = ${root} AND kind = 'content' AND id = 'source'`))
          .then(() => { finished = true })
        yield* Effect.promise(() => delay(30))
        expect(finished).toBe(false)
        expect(yield* Effect.promise(() => api.contents(root, "source"))).toBe("original")
        external.run("COMMIT")
        yield* Effect.promise(() => pending)
        yield* Effect.promise(() => core)
        expect(yield* Effect.promise(() => api.contents(root, "source"))).toBe("core")
      } finally {
        external.close()
      }
    }).pipe(Effect.provide(Database.layerFromPath(file)), Effect.scoped))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}, 15_000)

test("host storage atomically confirms embedding grants and rejects stale approvals", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "forge-writer-grants-"))
  const file = path.join(dir, "test.db")
  try {
    await Effect.runPromise(Effect.gen(function* () {
      const api = yield* storage
      const root = "/embedding-grants"
      const collection: Collection = {
        id: "operations", label: "Operations", kind: "text", location: "", session: "chat",
        origin: "interface", include: [], exclude: [], watch: false, approved: true,
        providers: ["coding"], state: "ready", observed: 1, generation: "original",
        files: 1, chunks: 1, warnings: [],
      }
      yield* Effect.promise(() => api.save(root, collection))
      const target = { fingerprint: "loopback-fixture", model: "fixture", dimensions: 2 }
      const consent = embeddingConsent({
        root, store: api, target: async () => target, authorize: async () => {},
      })
      yield* Effect.promise(async () => {
        const review = await consent.review(collection.id, "chat")
        const initial = await api.access(root, "chat", [collection.id])
        await consent.approve(collection.id, review.revision, "chat")
        expect((await consent.review(collection.id, "chat")).approved).toBe(true)
        expect(await api.access(root, "chat", [collection.id])).not.toEqual(initial)
        const captured = await api.embedding(root, collection.id, "chat")
        await consent.revoke(collection.id, "chat")
        const revoked = await api.embedding(root, collection.id, "chat")
        await rejects(api.embeddingSave(root, collection.id, "chat", captured, {
          version: "forge-embedding-consent-v1", revision: "stale-write", target,
        }))
        expect(await api.embedding(root, collection.id, "chat")).toEqual(revoked)
        await rejects(consent.authorize({ collection, session: "chat", target }), /has not been approved/)
        expect((await api.collection(root, collection.id))?.providers).toEqual(["coding"])
      })
    }).pipe(Effect.provide(Database.layerFromPath(file)), Effect.scoped))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}, 15_000)
