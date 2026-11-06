import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { CodeIndexConfigManager } from "../../../../src/indexing/config-manager"
import { CodeIndexStateManager } from "../../../../src/indexing/state-manager"
import { CodeIndexSearchService } from "../../../../src/indexing/search-service"
import { QdrantVectorStore } from "../../../../src/indexing/vector-store/qdrant-client"

test.each(["filePath", "fileHash", "codeChunk", "startLine", "endLine", "null", "mixed"] as const)(
  "masked Qdrant rejects ranked payload missing %s and permits a valid retry",
  async (field) => {
    const row = {
      id: randomUUID(), score: 1,
      payload: { filePath: "file.ts", fileHash: "current", codeChunk: "current original", startLine: 1, endLine: 1 },
    }
    const payload = field === "null" ? null : Object.fromEntries(
      Object.entries(row.payload).filter(([key]) => key !== (field === "mixed" ? "codeChunk" : field)),
    )
    let valid = false
    let queries = 0
    let scrolls = 0
    let embeddings = 0
    const server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      async fetch(request) {
        const url = new URL(request.url)
        if (url.pathname === "/") return Response.json({ title: "Qdrant response fixture", version: "1.17.0" })
        if (url.pathname.endsWith("/points/scroll")) {
          scrolls++
          return Response.json({ status: "ok", time: 0, result: { points: [row], next_page_offset: null } })
        }
        if (url.pathname.endsWith("/points/query")) {
          queries++
          const body: unknown = await request.json()
          expect(body).toMatchObject({ limit: 1, score_threshold: 0 })
          if (queries <= 2) {
            expect(body).toMatchObject({ filter: { must: [
              { key: "filePath", match: { any: ["file.ts"] } },
              { has_id: [row.id] },
            ] } })
          }
          const points = valid ? [row] : [{ ...row, payload }]
          if (!valid && field === "mixed") points.push(row)
          return Response.json({ status: "ok", time: 0, result: { points } })
        }
        return new Response("Unexpected fixture request", { status: 500 })
      },
    })
    const state = new CodeIndexStateManager()
    state.setSystemState("Indexed")
    const cfg = new CodeIndexConfigManager({
      enabled: true, embedderProvider: "ollama", vectorStoreProvider: "qdrant",
      searchMaxResults: 1, searchMinScore: 0,
    })
    const vector = new QdrantVectorStore("/ranked-payload/fixture", server.url.href, 2)
    const search = new CodeIndexSearchService(cfg, state, {
      async createEmbeddings() { embeddings++; return { embeddings: [[1, 0]] } },
      async validateConfiguration() { return { valid: true } },
      embedderInfo: { name: "ollama" },
    }, vector)
    const scope = [{ paths: ["file.ts"], text: row.payload.codeChunk, fallback: true, passages: [] }]
    try {
      await expect(search.searchIndex("current", undefined, scope)).rejects.toThrow("eligibility")
      expect(queries).toBe(1)
      valid = true
      expect(await search.searchIndex("current", undefined, scope)).toEqual([row])
      expect(scrolls).toBe(2)
      expect(embeddings).toBe(2)
      valid = false
      expect(await vector.search([1, 0], undefined, 0, 1)).toEqual(field === "mixed" ? [row] : [])
      expect(queries).toBe(3)
    } finally {
      state.dispose()
      await server.stop(true)
    }
  },
)
