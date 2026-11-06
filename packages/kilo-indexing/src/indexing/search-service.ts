import path from "path"
import type { VectorStoreSearchResult } from "./interfaces"
import type { IEmbedder } from "./interfaces/embedder"
import type { IVectorStore } from "./interfaces/vector-store"
import type { CodeIndexConfigManager } from "./config-manager"
import type { CodeIndexStateManager } from "./state-manager"
import { Log } from "../util/log"
import type { WorktreeOverlay } from "./worktree-overlay"
import { MASK_LIMIT, permitted, type SearchScope } from "./search-scope"
import { wait } from "./search-wait"

interface BaselineSearch {
  store: IVectorStore
  overlay: WorktreeOverlay
}

const log = Log.create({ service: "indexing-search" })

export class CodeIndexSearchService {
  constructor(
    private readonly configManager: CodeIndexConfigManager,
    private readonly stateManager: CodeIndexStateManager,
    private readonly embedder: IEmbedder,
    private readonly vectorStore: IVectorStore,
    private readonly baseline?: BaselineSearch,
  ) {}

  private allowed(result: VectorStoreSearchResult, extensions: ReadonlySet<string>): boolean {
    const file = result.payload?.filePath
    if (typeof file !== "string") return false
    return extensions.has(path.extname(file).toLowerCase())
  }

  public async searchIndex(
    query: string,
    directoryPrefix?: string,
    scope?: SearchScope,
    signal?: AbortSignal,
  ): Promise<VectorStoreSearchResult[]> {
    signal?.throwIfAborted()
    if (!this.configManager.isFeatureEnabled || !this.configManager.isFeatureConfigured) {
      throw new Error("Code index feature is disabled or not configured.")
    }

    const minScore = this.configManager.currentSearchMinScore
    const maxResults = this.configManager.currentSearchMaxResults

    const currentState = this.stateManager.getCurrentStatus().systemStatus
    if (currentState !== "Indexed" && currentState !== "Indexing") {
      throw new Error(`Code index is not ready for search. Current state: ${currentState}`)
    }

    try {
      // Never use bounded vector overfetch as an eligibility mask. First enumerate
      // unranked rows, then rank only accepted identities. Overflow fails closed.
      if (scope) {
        if (!scope.length) return []
        if (scope.length > MASK_LIMIT || Buffer.byteLength(JSON.stringify(scope), "utf8") > 8 * 1024 * 1024) {
          throw new Error("Semantic eligibility policy exceeds the safe mask cap")
        }
        if (this.baseline && !this.baseline.overlay.ready)
          throw new Error("Worktree index reconciliation is not complete.")
        const extensions = new Set(this.configManager.getConfig().fileExtensions)
        const paths = [...new Set(scope.flatMap((file) => file.paths))].filter((file) =>
          extensions.has(path.extname(file).toLowerCase()),
        )
        if (!paths.length) return []
        const stores = this.baseline ? [this.vectorStore, this.baseline.store] : [this.vectorStore]
        const masks = await Promise.all(
          stores.map(async (store, index) => {
            if (!store.candidates) throw new Error("Vector store does not support strict semantic eligibility")
            const rows = await wait(() => store.candidates!(paths, MASK_LIMIT + 1), signal)
            if (rows.length > MASK_LIMIT) throw new Error("Semantic eligibility rows exceed the safe mask cap")
            const checks = new Map<string, Promise<boolean>>()
            const accepted = await wait(
              () =>
                Promise.all(
                  rows.map(async (row) => {
                    if (!this.allowed(row, extensions) || !permitted(row.payload, scope)) return false
                    if (!this.baseline) return true
                    return index === 0
                      ? this.baseline.overlay.deltaResult(row)
                      : this.baseline.overlay.baselineResult(row, checks)
                  }),
                ),
              signal,
            )
            return { store, filter: { paths, ids: rows.filter((_, index) => accepted.at(index)).map((row) => row.id) } }
          }),
        )
        if (masks.every((mask) => !mask.filter.ids.length)) return []
        const response = await wait(() => this.embedder.createEmbeddings([query]), signal)
        const vector = response.embeddings.at(0)
        if (!vector) throw new Error("Failed to generate embedding for query.")
        const results = await Promise.all(
          masks.map(async (mask, index) => {
            const rows = await wait(
              () => mask.store.search(vector, directoryPrefix, minScore, maxResults, mask.filter),
              signal,
            )
            const ids = new Set(mask.filter.ids)
            const checks = new Map<string, Promise<boolean>>()
            for (const row of rows) {
              if (!ids.has(row.id) || !permitted(row.payload, scope))
                throw new Error("Semantic eligibility changed during search")
              if (
                this.baseline &&
                (!this.baseline.overlay.ready ||
                  !(index === 0
                    ? this.baseline.overlay.deltaResult(row)
                    : await wait(() => this.baseline!.overlay.baselineResult(row, checks), signal)))
              ) {
                throw new Error("Worktree eligibility changed during search")
              }
            }
            return rows
          }),
        )
        const merged = new Map<string, VectorStoreSearchResult>()
        for (const row of results.flat().sort((a, b) => b.score - a.score)) {
          const key = JSON.stringify([
            row.payload?.filePath,
            row.payload?.startLine,
            row.payload?.endLine,
            row.payload?.codeChunk,
          ])
          if (!merged.has(key)) merged.set(key, row)
        }
        return [...merged.values()].slice(0, maxResults)
      }
      const embeddingResponse = await wait(() => this.embedder.createEmbeddings([query]), signal)
      const vector = embeddingResponse?.embeddings[0]
      if (!vector) {
        throw new Error("Failed to generate embedding for query.")
      }

      const normalizedPrefix = directoryPrefix ? path.normalize(directoryPrefix) : undefined
      const extensions = new Set(this.configManager.getConfig().fileExtensions)
      if (!this.baseline) {
        const results = await wait(
          () => this.vectorStore.search(vector, normalizedPrefix, minScore, maxResults),
          signal,
        )
        return results.filter((result) => this.allowed(result, extensions))
      }
      if (!this.baseline.overlay.ready) throw new Error("Worktree index reconciliation is not complete.")

      const ceiling = Math.max(maxResults, Math.min(maxResults * 16, 1000))
      const delta = (async () => {
        const search = async (limit: number): Promise<VectorStoreSearchResult[]> => {
          const results = await wait(() => this.vectorStore.search(vector, normalizedPrefix, minScore, limit), signal)
          const filtered = results.filter((result) => this.baseline!.overlay.deltaResult(result))
          if (filtered.length >= maxResults || results.length < limit || limit >= ceiling) return filtered
          return search(Math.min(limit * 2, ceiling))
        }
        return search(maxResults)
      })()
      const base = (async () => {
        const checks = new Map<string, Promise<boolean>>()
        const search = async (limit: number): Promise<VectorStoreSearchResult[]> => {
          const results = await wait(
            () => this.baseline!.store.search(vector, normalizedPrefix, minScore, limit),
            signal,
          )
          const accepted = await wait(
            () => Promise.all(results.map((result) => this.baseline!.overlay.baselineResult(result, checks))),
            signal,
          )
          const filtered = results.filter((_, index) => accepted[index])
          if (filtered.length >= maxResults || results.length < limit || limit >= ceiling) return filtered
          return search(Math.min(limit * 2, ceiling))
        }
        return search(maxResults)
      })()
      const [baseline, current] = await Promise.all([base, delta])
      const merged = new Map<string, VectorStoreSearchResult>()
      const key = (result: VectorStoreSearchResult) =>
        [result.payload?.filePath, result.payload?.startLine, result.payload?.endLine, result.payload?.codeChunk].join(
          "\0",
        )

      for (const result of baseline) {
        if (this.allowed(result, extensions)) merged.set(key(result), result)
      }
      for (const result of current) {
        if (this.allowed(result, extensions) && this.baseline.overlay.deltaResult(result))
          merged.set(key(result), result)
      }
      return [...merged.values()].sort((left, right) => right.score - left.score).slice(0, maxResults)
    } catch (err) {
      signal?.throwIfAborted()
      log.error("search failed", { err })
      throw err
    }
  }
}
