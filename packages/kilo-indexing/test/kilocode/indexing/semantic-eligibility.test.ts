import { expect, test } from "bun:test"
import { createHash, randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { CodeIndexConfigManager } from "../../../src/indexing/config-manager"
import { CodeIndexStateManager } from "../../../src/indexing/state-manager"
import { CodeIndexSearchService } from "../../../src/indexing/search-service"
import { MASK_LIMIT, type SearchScope } from "../../../src/indexing/search-scope"
import { LanceDBVectorStore } from "../../../src/indexing/vector-store/lancedb-vector-store"
import { WorktreeOverlay } from "../../../src/indexing/worktree-overlay"
import type { IEmbedder } from "../../../src/indexing/interfaces/embedder"

function point(filePath: string, codeChunk: string, offset = 0) {
  return { id: randomUUID(), vector: [1, offset], payload: { filePath, codeChunk, fileHash: "fixture", startLine: 1, endLine: 1 } }
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "semantic-mask-"))
  const store = new LanceDBVectorStore(path.join(root, "workspace"), 2, root)
  await store.initialize()
  const state = new CodeIndexStateManager()
  state.setSystemState("Indexed")
  const cfg = new CodeIndexConfigManager({ enabled: true, embedderProvider: "ollama", vectorStoreProvider: "lancedb", searchMaxResults: 1, searchMinScore: 0 })
  const calls: string[] = []
  const embedder = {
    async createEmbeddings(texts) { calls.push(...texts); return { embeddings: texts.map(() => [1, 0]) } },
    async validateConfiguration() { return { valid: true } },
    embedderInfo: { name: "ollama" },
  } satisfies IEmbedder
  const search = new CodeIndexSearchService(cfg, state, embedder, store)
  return { root, cfg, state, embedder, store, search, calls, async [Symbol.asyncDispose]() { state.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) } }
}

test("native LanceDB masks paths and stale text before top-one, beyond bounded overfetch", async () => {
  await using f = await fixture()
  const file = "src/quo'te_%..ts"
  const scope: SearchScope = [{ paths: [file], text: "original eligible passage", fallback: true, passages: [] }]
  await f.store.upsertPoints([
    ...Array.from({ length: 200 }, () => point(file, "stale passage")),
    point("foreign.ts", "original eligible passage"),
    point("src/quoXte_A..ts", "original eligible passage"),
    point(file, "original eligible passage", 0.8),
  ])
  expect((await f.search.searchIndex("local")).at(0)?.payload?.codeChunk).toBe("stale passage")
  const result = await f.search.searchIndex("local", undefined, scope)
  expect(result).toHaveLength(1)
  expect(result.at(0)?.payload).toMatchObject({ filePath: file, codeChunk: "original eligible passage" })
  expect(await f.search.searchIndex("local", undefined, [])).toEqual([])
  expect(f.calls).toHaveLength(2)
})

test("native LanceDB exact-text and window policy does not turn source exclusions into file bans", async () => {
  await using f = await fixture()
  const scope: SearchScope = [{
    paths: ["file.ts"], text: "excluded first\nallowed second", fallback: false,
    passages: [
      { text: "excluded first\nallowed second", start: 1, end: 2, window: false, allowed: false },
      { text: "excluded first", start: 1, end: 1, window: true, allowed: false },
      { text: "allowed second", start: 2, end: 2, window: true, allowed: true },
    ],
  }]
  const allowed = point("file.ts", "allowed second", 0.8)
  allowed.payload.startLine = 2
  allowed.payload.endLine = 2
  await f.store.upsertPoints([
    point("file.ts", scope.at(0)!.text),
    point("file.ts", "excluded first"),
    allowed,
  ])
  expect((await f.search.searchIndex("local", undefined, scope)).map((row) => row.id)).toEqual([allowed.id])
})

test("native LanceDB rejects a truncated eligibility mask before embedding or ranking", async () => {
  await using f = await fixture()
  await f.store.upsertPoints(Array.from({ length: MASK_LIMIT + 1 }, () => point("file.ts", "original")))
  await expect(f.search.searchIndex("local", undefined, [{ paths: ["file.ts"], text: "original", fallback: true, passages: [] }]))
    .rejects.toThrow("safe mask cap")
  expect(f.calls).toEqual([])
}, 30_000)

test("native worktree baseline and delta apply overlay eligibility before their vector limits", async () => {
  await using current = await fixture()
  await using baseline = await fixture()
  const text = "original"
  const hash = createHash("sha256").update(text).digest("hex")
  await Bun.write(path.join(current.root, "allowed.ts"), text)
  const overlay = new WorktreeOverlay(current.root, baseline.root, new Map([["allowed.ts", hash], ["shadow.ts", hash]]))
  overlay.ready = true
  overlay.shadows.add("shadow.ts")
  overlay.blocked.add("blocked.ts")
  const allowed = point("allowed.ts", text, 0.5)
  allowed.payload.fileHash = hash
  await baseline.store.upsertPoints([point("allowed.ts", text), point("shadow.ts", text), allowed])
  await current.store.upsertPoints([point("blocked.ts", text), point("new.ts", text, 0.8)])
  const scope: SearchScope = ["allowed.ts", "shadow.ts", "blocked.ts", "new.ts"].map((file) => ({ paths: [file], text, fallback: true, passages: [] }))
  const search = new CodeIndexSearchService(current.cfg, current.state, current.embedder, current.store, { store: baseline.store, overlay })
  expect((await search.searchIndex("local", undefined, scope)).map((row) => row.id)).toEqual([allowed.id])
  overlay.blocked.add("allowed.ts")
  expect((await search.searchIndex("local", undefined, scope)).map((row) => row.payload?.filePath)).toEqual(["new.ts"])
})

test("native row replacement during embedding fails closed rather than silently losing a slot", async () => {
  await using f = await fixture()
  const row = point("file.ts", "original")
  await f.store.upsertPoints([row])
  const search = new CodeIndexSearchService(f.cfg, f.state, {
    ...f.embedder,
    async createEmbeddings() {
      await f.store.upsertPoints([{ ...row, payload: { ...row.payload, codeChunk: "stale replacement" } }])
      return { embeddings: [[1, 0]] }
    },
  }, f.store)
  await expect(search.searchIndex("local", undefined, [{ paths: ["file.ts"], text: "original", fallback: true, passages: [] }]))
    .rejects.toThrow("eligibility changed")
})
