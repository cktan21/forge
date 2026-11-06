import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { CodeIndexConfigManager } from "../../../src/indexing/config-manager"
import { CodeIndexStateManager } from "../../../src/indexing/state-manager"
import { CodeIndexSearchService } from "../../../src/indexing/search-service"
import { OpenAICompatibleEmbedder } from "../../../src/indexing/embedders/openai-compatible"
import { QdrantVectorStore } from "../../../src/indexing/vector-store/qdrant-client"

async function bounded<T>(work: Promise<T>) {
  const deadline = Promise.withResolvers<undefined>()
  const timer = setTimeout(() => deadline.resolve(undefined), 1000)
  try {
    return await Promise.race([work, deadline.promise])
  } finally {
    clearTimeout(timer)
  }
}

for (const scoped of [false, true]) {
  for (const stage of scoped ? ["candidates", "embedding", "ranking"] : ["embedding", "ranking"]) {
    test(`cancelling ${scoped ? "scoped" : "ordinary"} ${stage} releases the search without late stages`, async () => {
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const returned = Promise.withResolvers<void>()
      const row = {
        id: randomUUID(),
        score: 1,
        payload: { filePath: "file.ts", fileHash: "current", codeChunk: "original", startLine: 1, endLine: 1 },
      }
      const calls: string[] = []
      let held = false
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          const url = new URL(request.url)
          if (url.pathname === "/") return Response.json({ title: "Local Qdrant fixture", version: "1.17.0" })
          const current = url.pathname.endsWith("/points/scroll")
            ? "candidates"
            : url.pathname.endsWith("/points/query")
              ? "ranking"
              : "embedding"
          calls.push(current)
          if (current === stage && !held) {
            held = true
            entered.resolve()
            await release.promise
          }
          if (current === "candidates")
            return Response.json({ status: "ok", time: 0, result: { points: [row], next_page_offset: null } })
          if (current === "ranking") return Response.json({ status: "ok", time: 0, result: { points: [row] } })
          return Response.json({
            data: [{ index: 0, embedding: [1, 0] }],
            usage: { prompt_tokens: 1, total_tokens: 1 },
          })
        },
      })
      const state = new CodeIndexStateManager()
      state.setSystemState("Indexed")
      const cfg = new CodeIndexConfigManager({
        enabled: true,
        embedderProvider: "openai-compatible",
        openAiCompatibleBaseUrl: `${server.url}v1`,
        vectorStoreProvider: "qdrant",
        searchMinScore: 0,
        searchMaxResults: 1,
      })
      const embedder = new OpenAICompatibleEmbedder(`${server.url}v1`, "fixture", "fixture")
      const vector = new QdrantVectorStore("/cancellation/fixture", server.url.href, 2)
      // Observe completion of the actual held transport, without replacing it.
      if (stage === "embedding") {
        const original = embedder.createEmbeddings.bind(embedder)
        let first = true
        embedder.createEmbeddings = async (...args) => {
          const initial = first
          first = false
          try {
            return await original(...args)
          } finally {
            if (initial) returned.resolve()
          }
        }
      }
      if (stage === "candidates") {
        const original = vector.candidates.bind(vector)
        let first = true
        vector.candidates = async (...args) => {
          const initial = first
          first = false
          try {
            return await original(...args)
          } finally {
            if (initial) returned.resolve()
          }
        }
      }
      if (stage === "ranking") {
        const original = vector.search.bind(vector)
        let first = true
        vector.search = async (...args) => {
          const initial = first
          first = false
          try {
            return await original(...args)
          } finally {
            if (initial) returned.resolve()
          }
        }
      }
      const service = new CodeIndexSearchService(cfg, state, embedder, vector)
      const scope = scoped ? [{ paths: ["file.ts"], text: "original", fallback: true, passages: [] }] : undefined
      const controller = new AbortController()
      const reason = new Error("Caller cancelled semantic search")
      const result = service.searchIndex("held", undefined, scope, controller.signal).then(
        (value) => value,
        (err: unknown) => err,
      )
      try {
        expect(await bounded(entered.promise.then(() => true))).toBe(true)
        controller.abort(reason)
        expect(await bounded(result)).toBe(reason)
        expect(await service.searchIndex("fresh", undefined, scope)).toEqual([row])
        const count = calls.length
        release.resolve()
        expect(await bounded(returned.promise.then(() => true))).toBe(true)
        expect(await result).toBe(reason)
        expect(calls).toHaveLength(count)
      } finally {
        release.resolve()
        await result
        if (held) await returned.promise
        state.dispose()
        await server.stop(true)
      }
    })
  }
}

test.each([false, true])("already-cancelled search does not invoke adapters (scoped=%s)", async (scoped) => {
  let calls = 0
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      calls++
      return Response.json({ data: [{ embedding: [1, 0] }] })
    },
  })
  const state = new CodeIndexStateManager()
  state.setSystemState("Indexed")
  const cfg = new CodeIndexConfigManager({
    enabled: true,
    embedderProvider: "openai-compatible",
    openAiCompatibleBaseUrl: `${server.url}v1`,
    vectorStoreProvider: "lancedb",
  })
  const embedder = new OpenAICompatibleEmbedder(`${server.url}v1`, "fixture", "fixture")
  const vector = new QdrantVectorStore("/cancellation/fixture", server.url.href, 2)
  // Qdrant's constructor version probe is unrelated to a search.
  const original = vector.search.bind(vector)
  let queries = 0
  vector.search = async (...args) => {
    queries++
    return original(...args)
  }
  const service = new CodeIndexSearchService(cfg, state, embedder, vector)
  const reason = new Error("Already cancelled")
  try {
    const result = await service
      .searchIndex("never send", undefined, scoped ? [] : undefined, AbortSignal.abort(reason))
      .then(
        (value) => value,
        (err: unknown) => err,
      )
    expect(result).toBe(reason)
    expect(queries).toBe(0)
    expect(calls).toBeLessThanOrEqual(1)
  } finally {
    state.dispose()
    await server.stop(true)
  }
})
