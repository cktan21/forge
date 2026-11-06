import { collectionSemantic, type CollectionQuery } from "./collection-semantic"
import { embeddingConsent, identity } from "./embedding-consent"
import { embeddingHttp } from "./embedding-http"
import type { Collection, EmbeddingAttempt } from "./schema"
import type { Store } from "./store"
import type { knowledge } from "./knowledge"
import { wait } from "./wait"
import { embeddingJobs } from "./embedding-jobs"
import { account, type Observer } from "./embedding-usage"
import { randomUUID } from "node:crypto"
import { retention } from "./embedding-retention"

export type EmbeddingHost = {
  configuration(): Promise<Parameters<typeof embeddingHttp>[0] | undefined>
  authorize(collection: Collection, session: string, endpoint?: string): Promise<void>
}

export function embeddings(
  opts: EmbeddingHost & {
    root: string
    store: Store
    library: ReturnType<typeof knowledge>
  },
) {
  async function configured() {
    const configuration = await opts.configuration()
    return configuration ? embeddingHttp(configuration) : undefined
  }
  async function required() {
    const transport = await configured()
    if (!transport) throw new Error("Collection embeddings are not configured in this host")
    return transport
  }
  const consent = embeddingConsent({
    root: opts.root,
    store: opts.store,
    target: async () => (await required()).target,
    authorize: async (collection, session, target) => {
      if (!target) return opts.authorize(collection, session)
      const transport = await required()
      if (identity(transport.target) !== identity(target)) throw new Error("Embedding destination changed")
      await opts.authorize(collection, session, transport.endpoint)
    },
  })
  function adapter(
    transport: ReturnType<typeof embeddingHttp>,
    purpose: EmbeddingAttempt["purpose"],
    session: string,
    observe?: Observer,
  ) {
    return collectionSemantic({
      root: opts.root,
      store: opts.store,
      library: opts.library,
      target: transport.target,
      authorize: (input, signal) => consent.authorize(input, signal),
      embed: (texts, signal, collections, check) =>
        opts.store.fenced(opts.root, async () => {
          // Re-read immediately before every batch, including credentials. A
          // configured endpoint/model change cannot reuse a reviewed transport.
          const current = await wait(required, signal)
          if (identity(current.target) !== identity(transport.target)) throw new Error("Embedding destination changed")
          let attempt: EmbeddingAttempt | undefined
          return current.embed(texts, signal, async (event) => {
            if (event.state === "ready") throw new Error("Unexpected transport usage initialization")
            if (event.state === "attempt") {
              if (attempt) throw new Error("Embedding attempt already admitted")
              const value: EmbeddingAttempt = {
                id: randomUUID(),
                session,
                collections: [...collections],
                target: transport.target,
                purpose,
                started: Date.now(),
                usage: account(undefined, event),
              }
              await opts.store.embeddingAttemptSave(opts.root, value)
              attempt = value
            }
            if (event.state === "response" || event.state === "failed") {
              if (!attempt || attempt.finished != null) throw new Error("Embedding attempt is not pending")
              const value = { ...attempt, finished: Date.now(), usage: account(attempt.usage, event) }
              await opts.store.embeddingAttemptSave(opts.root, value, attempt)
              attempt = value
            }
            await observe?.(event)
            // Persistence can wait; do not let a revoked or changed collection
            // cross the newly introduced admission wait before socket creation.
            if (event.state === "attempt") await check()
          })
        }),
    })
  }
  const jobs = embeddingJobs({
    root: opts.root,
    store: opts.store,
    authorize: async (key, session, signal) => {
      const item = await wait(() => opts.library.get(key, session), signal)
      await wait(() => opts.authorize(item, session), signal)
    },
    prepare: async (key, session, signal) => {
      const transport = await wait(required, signal)
      const item = await wait(() => opts.library.get(key, session), signal)
      await consent.authorize({ collection: item, session, target: transport.target }, signal)
      return transport.target
    },
    index: async (key, session, target, signal, progress, observe) => {
      const transport = await wait(required, signal)
      if (identity(transport.target) !== identity(target)) throw new Error("Embedding destination changed")
      await observe({ state: "ready" })
      return adapter(transport, "job", session, observe).index(key, { session, signal, progress })
    },
  })
  return {
    ...retention(opts),
    jobs,
    dispose: () => jobs.dispose(),
    async usage(request: { session?: string; after?: string; limit?: number } = {}, signal?: AbortSignal) {
      return wait(
        () =>
          opts.store.fenced(opts.root, async () => {
            const session = request.session ?? ""
            const page = await opts.store.embeddingLedger(opts.root, session, request.after, request.limit)
            const collections = [...new Set(page.entries.flatMap((entry) => entry.collections))]
            const before = await opts.store.consent(opts.root, session, collections)
            for (const key of collections) {
              const item = await wait(() => opts.library.get(key, session), signal)
              await wait(() => opts.authorize(item, session), signal)
            }
            if (before !== (await opts.store.consent(opts.root, session, collections)))
              throw new Error("Collection or policy changed during embedding usage inspection")
            if (page.observation?.revision !== (await opts.store.embeddingObservation(opts.root)).revision)
              throw new Error("Ledger changed during embedding usage inspection")
            signal?.throwIfAborted()
            return page
          }),
        signal,
      )
    },
    async review(key: string, session = "", signal?: AbortSignal) {
      const transport = await wait(required, signal)
      const review = await consent.review(key, session, signal)
      if (identity(review.target) !== identity(transport.target)) throw new Error("Embedding destination changed")
      return { ...review, endpoint: transport.endpoint }
    },
    approve: (key: string, revision: string, session = "", signal?: AbortSignal) =>
      consent.approve(key, revision, session, signal),
    revoke: (key: string, session = "", signal?: AbortSignal) => consent.revoke(key, session, signal),
    async coverage(key: string, session = "", signal?: AbortSignal) {
      const transport = await wait(required, signal)
      return adapter(transport, "index", session).coverage(key, { session, signal })
    },
    async index(key: string, session = "", signal?: AbortSignal) {
      const transport = await wait(required, signal)
      return adapter(transport, "index", session).index(key, { session, signal })
    },
    async retrieve(input: CollectionQuery) {
      const transport = await wait(configured, input.signal)
      if (!transport) return []
      return adapter(transport, "query", input.session).retrieve(input)
    },
  }
}
