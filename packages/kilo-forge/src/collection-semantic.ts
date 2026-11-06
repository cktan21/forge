import { Schema } from "effect"
import { isDeepStrictEqual } from "node:util"
import type { knowledge } from "./knowledge"
import {
  decode,
  type Collection,
  type Source,
  type Match,
  type EmbeddingProgress,
  type EmbeddingCoverage,
} from "./schema"
import type { Store } from "./store"
import { hash } from "./util"
import { order } from "./order"
import { wait } from "./wait"
import { Grant, identity as identify, type Target } from "./embedding-consent"

type Options = {
  root: string
  store: Store
  library: ReturnType<typeof knowledge>
  target: Target
  // A separate embedding grant, never the collection's coding-provider grant.
  authorize(
    input: { collection: Collection; session: string; target: Readonly<Target> },
    signal?: AbortSignal,
  ): Promise<void>
  // The host must bind this transport to target, including redirects/routing.
  embed(
    texts: string[],
    signal: AbortSignal | undefined,
    collections: readonly string[],
    check: () => Promise<void>,
  ): Promise<number[][]>
}
type Request = {
  session?: string
  exclude?: readonly string[]
  signal?: AbortSignal
  sources?: readonly Source[]
  progress?: (value: EmbeddingProgress) => Promise<void>
}

export type CollectionQuery = {
  query: string
  session: string
  sources: readonly Source[]
  limit: number
  signal?: AbortSignal
}

const Vector = Schema.Array(Schema.Finite)
const Cache = Schema.Struct({
  version: Schema.Literal("forge-collection-vectors-v1"),
  rows: Schema.Array(Schema.Struct({ id: Schema.String, revision: Schema.String, vector: Vector })),
})

function revision(source: Source) {
  return hash(
    JSON.stringify([
      source.id,
      source.hash,
      source.text,
      source.uri,
      source.start,
      source.end,
      source.method,
      source.detail.collection,
      source.detail.session,
      source.detail.document,
      source.detail.fileHash,
      source.detail.extractor,
      source.detail.extraction,
    ]),
  )
}

function normalize(vector: readonly number[], dimensions: number) {
  if (vector.length !== dimensions || vector.some((value) => !Number.isFinite(value))) {
    throw new Error("Collection embedding has an invalid dimension or non-finite component")
  }
  const scale = vector.reduce((largest, value) => Math.max(largest, Math.abs(value)), 0)
  if (!scale) throw new Error("Collection embedding has zero magnitude")
  const scaled = vector.map((value) => value / scale)
  const norm = Math.sqrt(scaled.reduce((sum, value) => sum + value * value, 0))
  return scaled.map((value) => value / norm)
}

// Opt-in core adapter. Construction, inspection and local document indexing do
// not invoke it. CLI/UI wiring requires an embedding-specific approval surface.
export function collectionSemantic(opts: Options) {
  const target = Object.freeze({ ...opts.target })
  if (
    !target.fingerprint ||
    !target.model ||
    !Number.isInteger(target.dimensions) ||
    target.dimensions < 1 ||
    target.dimensions > 4096
  ) {
    throw new Error("A bound embedding destination, model and 1-4096 dimensions are required")
  }
  const identity = identify(target)
  const key = (collection: string) => `collection-vectors:${identity}:${collection}`

  async function scope(collection: string, request: Request) {
    const session = request.session ?? ""
    const item = await wait(() => opts.library.get(collection, session), request.signal)
    if (!item.approved || item.state !== "ready") throw new Error("Collection is not ready for semantic search")
    const access = await wait(() => opts.store.access(opts.root, session, [collection]), request.signal)
    const policies = await wait(
      () => Promise.all([opts.store.policy(opts.root), opts.store.policy(opts.root, session)]),
      request.signal,
    )
    const excluded = new Set([...policies.flatMap((policy) => policy.exclude), ...(request.exclude ?? [])])
    const admitted = request.sources && new Map(request.sources.map((source) => [source.id, revision(source)]))
    const records = await wait(
      () => opts.store.knowledge(opts.root, session, undefined, { collection }),
      request.signal,
    )
    const sources = records.filter(
      (source) =>
        source.method === "collection-section" &&
        source.status === "current" &&
        source.text.trim() &&
        !excluded.has(source.id) &&
        (!admitted || admitted.get(source.id) === revision(source)),
    )
    if (
      sources.length > 10_000 ||
      sources.reduce((size, source) => size + Buffer.byteLength(source.text), 0) > 20 * 1024 * 1024
    ) {
      throw new Error("Collection semantic scope exceeds 10000 sections or 20 MiB")
    }
    async function unchanged() {
      const current = await wait(() => opts.store.access(opts.root, session, [collection]), request.signal)
      if (JSON.stringify(current) !== JSON.stringify(access)) {
        throw new Error("Collection or context policy changed during semantic search")
      }
      request.signal?.throwIfAborted()
    }
    async function check(originals: readonly Source[]) {
      request.signal?.throwIfAborted()
      await wait(() => opts.authorize({ collection: item, session, target }, request.signal), request.signal)
      const checked = new Set<string>()
      for (const source of originals) {
        // fresh validates the entire stored extraction. Reuse that proof only
        // within this check, never across asynchronous embedding operations.
        const document = JSON.stringify([source.detail.document, source.detail.fileHash, source.detail.extraction])
        if (checked.has(document)) continue
        if (!(await wait(() => opts.library.fresh(source, session, undefined, request.signal), request.signal))) {
          throw new Error("Collection original changed or is unavailable")
        }
        checked.add(document)
      }
      await unchanged()
    }
    return { collection, access, sources, records, excluded, check, unchanged }
  }

  async function cached(collection: string, signal?: AbortSignal) {
    const value = await wait(() => opts.store.cached(opts.root, key(collection)), signal)
    if (value == null) return new Map<string, (typeof Cache.Type.rows)[number]>()
    const cache = decode(Cache, value)
    if (cache.rows.length > 10_000 || new Set(cache.rows.map((row) => row.id)).size !== cache.rows.length) {
      throw new Error("Invalid collection semantic cache")
    }
    return new Map(cache.rows.map((row) => [row.id, { ...row, vector: normalize(row.vector, target.dimensions) }]))
  }

  const api = {
    identity,
    target,
    async coverage(collection: string, request: Pick<Request, "session" | "signal"> = {}): Promise<EmbeddingCoverage> {
      const started = Date.now()
      const session = request.session ?? ""
      const state = await scope(collection, request)
      await state.check([])
      const sections = state.records.filter((source) => source.method === "collection-section" && source.text.trim())
      if (
        sections.length > 10_000 ||
        sections.reduce((size, source) => size + Buffer.byteLength(source.text), 0) > 20 * 1024 * 1024
      ) {
        throw new Error("Collection coverage scope exceeds 10000 sections or 20 MiB")
      }
      const rows = await cached(collection, request.signal)
      async function classify() {
        const counts = { reusable: 0, missing: 0, outdated: 0, stale: 0, excluded: 0 }
        const checked = new Map<string, boolean>()
        for (const source of sections) {
          request.signal?.throwIfAborted()
          if (state.excluded.has(source.id)) {
            counts.excluded++
            continue
          }
          const document = JSON.stringify([source.detail.document, source.detail.fileHash, source.detail.extraction])
          if (source.status === "current" && !checked.has(document)) {
            checked.set(
              document,
              await wait(() => opts.library.fresh(source, session, undefined, request.signal), request.signal),
            )
          }
          if (source.status !== "current" || !checked.get(document)) {
            counts.stale++
            continue
          }
          const row = rows.get(source.id)
          counts[!row ? "missing" : row.revision !== revision(source) ? "outdated" : "reusable"]++
        }
        return { counts, checked }
      }
      const result = await classify()
      await state.check([])
      // Revalidate after asynchronous permissions. This is an observation
      // interval, not a lease on files or permission to send future requests.
      if (!isDeepStrictEqual(result, await classify())) throw new Error("Collection freshness changed during coverage")
      const records = await wait(
        () => opts.store.knowledge(opts.root, session, undefined, { collection }),
        request.signal,
      )
      if (
        !isDeepStrictEqual(records, state.records) ||
        !isDeepStrictEqual(rows, await cached(collection, request.signal))
      ) {
        throw new Error("Collection originals or vectors changed during coverage")
      }
      await state.unchanged()
      return { collection, session, target, started, finished: Date.now(), sections: sections.length, ...result.counts }
    },
    async index(collection: string, request: Request = {}) {
      return opts.store.fenced(opts.root, async () => {
        await request.progress?.({ phase: "checking", processed: 0, embedded: 0, reused: 0 })
        const state = await scope(collection, request)
        await state.check(state.sources)
        const previous = await cached(collection, request.signal)
        const rows: Array<(typeof Cache.Type.rows)[number]> = []
        let embedded = 0
        const report = (phase: EmbeddingProgress["phase"]) =>
          request.progress?.({
            phase,
            sections: state.sources.length,
            processed: rows.length,
            embedded,
            reused: rows.length - embedded,
          })
        for (let offset = 0; offset < state.sources.length; offset += 16) {
          const batch = state.sources.slice(offset, offset + 16)
          const missing = batch.filter((source) => previous.get(source.id)?.revision !== revision(source))
          await report("checking")
          await state.check(batch)
          if (missing.length) await report("embedding")
          const vectors = missing.length
            ? await wait(
                () =>
                  opts.embed(
                    missing.map((source) => source.text),
                    request.signal,
                    [collection],
                    () => state.check(batch),
                  ),
                request.signal,
              )
            : []
          if (vectors.length !== missing.length)
            throw new Error("Collection embedding response count does not match input")
          const indexed = new Map(
            missing.map((source, index) => [
              source.id,
              {
                id: source.id,
                revision: revision(source),
                vector: normalize(vectors.at(index)!, target.dimensions),
              },
            ]),
          )
          await state.check(batch)
          for (const source of batch) rows.push(indexed.get(source.id) ?? previous.get(source.id)!)
          embedded += missing.length
          await report("checking")
        }
        await state.check(state.sources)
        await report("publishing")
        // One publication leaves the previous generation intact on batch failure.
        await wait(
          () =>
            opts.store.cache(opts.root, key(collection), {
              version: "forge-collection-vectors-v1",
              rows,
            } satisfies typeof Cache.Type),
          request.signal,
          undefined,
          true,
        )
        request.signal?.throwIfAborted()
        await report("validating")
        await state.check(state.sources)
        return { sections: rows.length, embedded, reused: rows.length - embedded }
      })
    },
    async search(
      query: string,
      collections: readonly string[],
      request: Request & { limit?: number } = {},
    ): Promise<Match[]> {
      const limit = request.limit ?? 100
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("Semantic result limit must be 1-1000")
      request.signal?.throwIfAborted()
      if (!query.trim() || !collections.length) return []
      if (query.length > 100_000 || collections.length > 100)
        throw new Error("Collection semantic query scope is too large")
      const states: Array<
        Awaited<ReturnType<typeof scope>> & { candidates: Array<{ source: Source; vector: readonly number[] }> }
      > = []
      let count = 0
      let bytes = 0
      for (const collection of new Set(collections)) {
        const state = await scope(collection, request)
        count += state.sources.length
        bytes += state.sources.reduce((size, source) => size + Buffer.byteLength(source.text), 0)
        if (count > 10_000 || bytes > 20 * 1024 * 1024)
          throw new Error("Combined collection semantic scope is too large")
        await state.check(state.sources)
        const rows = await cached(collection, request.signal)
        const candidates = state.sources.flatMap((source) => {
          const row = rows.get(source.id)
          return row?.revision === revision(source) ? [{ source, vector: row.vector }] : []
        })
        states.push({ ...state, candidates })
      }
      if (!states.some((state) => state.candidates.length)) return []
      async function check() {
        for (const state of states) await state.check(state.candidates.map((item) => item.source))
        // One read closes cross-collection races between sequential callbacks.
        const current = await wait(
          () =>
            opts.store.access(
              opts.root,
              request.session ?? "",
              states.map((state) => state.collection),
            ),
          request.signal,
        )
        if (
          states.some(
            (state) =>
              current.policy !== state.access.policy ||
              current.collections[state.collection] !== state.access.collections[state.collection],
          )
        ) {
          throw new Error("Collection or context policy changed during semantic search")
        }
      }
      // Recheck every participating collection immediately before query egress.
      await check()
      const vectors = await wait(
        () =>
          opts.embed(
            [query],
            request.signal,
            states.map((state) => state.collection),
            check,
          ),
        request.signal,
      )
      if (vectors.length !== 1) throw new Error("Collection query embedding response count does not match input")
      const vector = normalize(vectors.at(0)!, target.dimensions)
      await check()
      return states
        .flatMap((state) =>
          state.candidates.map(({ source, vector: candidate }) => ({
            source,
            score: candidate.reduce((sum, value, index) => sum + value * vector.at(index)!, 0),
            reason: "Collection semantic index",
          })),
        )
        .sort((a, b) => b.score - a.score || order(a.source, b.source))
        .slice(0, limit)
    },
    async retrieve(input: CollectionQuery): Promise<Match[]> {
      input.signal?.throwIfAborted()
      const collections: string[] = []
      for (const key of new Set(
        input.sources.flatMap((source) => (source.detail.collection ? [source.detail.collection] : [])),
      )) {
        const state = await wait(() => opts.store.embedding(opts.root, key, input.session), input.signal)
        const grant = state.grant == null ? undefined : decode(Grant, JSON.parse(state.grant))
        // No grant means no embedding request, not an implicit approval prompt.
        if (
          !state.collection.approved ||
          state.collection.state !== "ready" ||
          !grant?.target ||
          identify(grant.target) !== identity
        )
          continue
        collections.push(key)
      }
      return api.search(input.query, collections, input)
    },
  }
  return api
}
