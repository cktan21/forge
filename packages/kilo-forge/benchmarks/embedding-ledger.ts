import { Database } from "bun:sqlite"
import { strict as assert } from "node:assert"
import { mkdtemp, rm } from "node:fs/promises"
import { cpus, tmpdir } from "node:os"
import path from "node:path"
import { embeddings } from "../src/embeddings"
import { exportEmbeddings } from "../src/embedding-export"
import { account } from "../src/embedding-usage"
import { knowledge } from "../src/knowledge"
import { store } from "../src/store"

const sizes = [1000, 10_000, 100_000]
const root = await mkdtemp(path.join(tmpdir(), "forge-ledger-size-"))
const rows: unknown[] = []
try {
  for (const size of sizes) {
    const file = path.join(root, `${size}.sqlite`)
    const db = new Database(file)
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL")
    const storage = store({
      all: async (query) =>
        db.query<Record<string, unknown>, (string | number | null)[]>(query.text).all(...(query.values ?? [])),
      batch: async (queries) => {
        db.transaction(() => {
          for (const query of queries) db.query(query.text).run(...(query.values ?? []))
        })()
      },
    })
    const library = knowledge(root, storage)
    const api = embeddings({
      root,
      store: storage,
      library,
      configuration: async () => {
        throw new Error("Usage inspection must not configure a provider")
      },
      authorize: async () => {},
    })
    try {
      const collection = await library.register({
        kind: "text",
        label: "Synthetic usage workload",
        location: "",
        content: "A ledger performance fixture, not provider billing evidence.",
      })
      const usage = account(undefined, { state: "attempt", inputs: 1, bytes: 128 })
      const started = performance.now()
      // Use real admission writes; interleave sessions to exercise scoped paging.
      for (let index = 0; index < size; index++) {
        await storage.embeddingAttemptSave(root, {
          id: `attempt-${index}`,
          session: index % 2 ? "other" : "chat",
          collections: [collection.id],
          purpose: "query",
          target: { fingerprint: "fixture", model: "never-called", dimensions: 2 },
          started: index + 1,
          usage,
        })
      }
      const admission = performance.now() - started
      const count = size / 2
      const first = await api.usage({ session: "chat", limit: 100 })
      assert.equal(first.entries.length, 100)
      assert.equal(first.entries.at(0)?.id, `attempt-${size - 2}`)
      const tail = db
        .query<
          { cursor: number },
          [string]
        >("SELECT rowid AS cursor FROM forge_records WHERE workspace = ? AND kind = 'embedding-attempt' AND json_extract(body,'$.session') = 'chat' ORDER BY rowid ASC LIMIT 1 OFFSET 100")
        .get(root)
      assert(tail)
      const samples: { head: number; tail: number }[] = []
      for (let index = 0; index < 30; index++) {
        const head = performance.now()
        const page = await api.usage({ session: "chat", limit: 100 })
        const elapsed = performance.now() - head
        assert.equal(page.entries.length, 100)
        assert(page.entries.every((entry) => entry.session === "chat"))
        const began = performance.now()
        const end = await api.usage({ session: "chat", limit: 100, after: String(tail.cursor) })
        const duration = performance.now() - began
        assert.equal(end.entries.length, 100)
        assert.equal(end.entries.at(-1)?.id, "attempt-0")
        assert.equal(end.next, undefined)
        samples.push({ head: elapsed, tail: duration })
      }
      const began = performance.now()
      const result = await exportEmbeddings({
        session: "chat",
        max: 10_000,
        read: (request, signal) => api.usage(request, signal),
      })
      const exported = performance.now() - began
      assert.equal(result.entries.length, Math.min(count, 10_000))
      assert.equal(new Set(result.entries.map((entry) => entry.id)).size, result.entries.length)
      assert.equal(result.traversal, count > 10_000 ? "limited" : "exhausted")
      assert.equal(result.consistency, "revision-checked")
      assert.equal(result.observation?.revision, first.observation?.revision)
      assert.equal(result.observation?.before, "unknown")
      assert.equal(result.observation?.deleted, false)
      assert.equal(result.groups.at(0)?.usage.pending, result.entries.length)
      assert.equal(result.groups.at(0)?.unknown.prompt, result.entries.length)
      const policy = { session: "chat", before: size + 1, keep: 100 }
      const pending = performance.now()
      assert.equal((await api.retention(policy)).selected, 0)
      const scanning = performance.now() - pending
      const page = await storage.embeddingLedger(root, "chat", undefined, 100)
      assert(page.next)
      const entries = [...page.entries, ...(await storage.embeddingLedger(root, "chat", page.next, 100)).entries]
      assert.equal(entries.length, 200)
      for (const entry of entries)
        await storage.embeddingAttemptSave(
          root,
          {
            ...entry,
            finished: size,
            usage: account(entry.usage, { state: "response", total: 7 }),
          },
          entry,
        )
      const reviewed = performance.now()
      const preview = await api.retention(policy)
      const inspection = performance.now() - reviewed
      assert.equal(preview.selected, 100)
      const pruning = performance.now()
      assert.deepEqual(await api.prune({ ...policy, revision: preview.revision, confirmation: "DELETE" }), {
        deleted: 100,
        more: false,
      })
      const deletion = performance.now() - pruning
      assert.equal((await api.retention(policy)).selected, 0)
      assert.equal((await api.usage({ session: "chat" })).observation?.deleted, true)
      const remaining = db.query<{ count: number }, [string, string]>(
        "SELECT count(*) AS count FROM forge_records WHERE workspace = ? AND kind = 'embedding-attempt' AND json_extract(body,'$.session') = ?",
      )
      assert.equal(remaining.get(root, "chat")?.count, count - 100)
      assert.equal(remaining.get(root, "other")?.count, count)
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
      rows.push({
        attempts: size,
        sessionAttempts: count,
        admission,
        bytes: Bun.file(file).size,
        samples,
        p95: Object.fromEntries(
          ["head", "tail"].map((name) => [
            name,
            samples
              .map((sample) => (name === "head" ? sample.head : sample.tail))
              .sort((a, b) => a - b)
              .at(28),
          ]),
        ),
        export: { elapsed: exported, entries: result.entries.length, traversal: result.traversal },
        retention: { scanning, inspection, deletion, deleted: 100, retained: 100 },
      })
    } finally {
      await api.dispose()
      await library.dispose()
      db.close()
    }
  }
  console.log(
    JSON.stringify(
      {
        runtime: Bun.version,
        cpu: cpus().at(0)?.model,
        rows,
        limits: [
          "Synthetic admitted records, zero network or model requests; counters are workload fixtures, not billing.",
          "Local file-backed WAL with NORMAL synchronization, one process, warm reads and two interleaved sessions.",
          "Actual store, permission-path orchestration and export collector; not HTTP, native, multi-process or remote-filesystem timings.",
          "No hard latency SLA inferred from 30 dependent samples per size; exports remain bounded live observations.",
        ],
      },
      null,
      2,
    ),
  )
} finally {
  await rm(root, { recursive: true, force: true })
}
