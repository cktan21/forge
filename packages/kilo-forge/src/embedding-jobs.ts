import { randomUUID } from "node:crypto"
import { identity, type Target } from "./embedding-consent"
import type { EmbeddingJob, EmbeddingProgress, EmbeddingResult } from "./schema"
import type { Store } from "./store"
import { wait } from "./wait"
import { account, type Observer } from "./embedding-usage"

type Active = {
  controller: AbortController
  promise: Promise<void>
  value: EmbeddingJob
}
type Runtime = {
  owners: Set<symbol>
  active: Map<string, Active>
  queue: Promise<void>
  recovery?: Promise<void>
}
const runtimes = new WeakMap<Store, Map<string, Runtime>>()

export function embeddingJobs(opts: {
  root: string
  store: Store
  authorize(key: string, session: string, signal?: AbortSignal): Promise<void>
  prepare(key: string, session: string, signal?: AbortSignal): Promise<Target>
  index(
    key: string,
    session: string,
    target: Target,
    signal: AbortSignal,
    progress: (value: EmbeddingProgress) => Promise<void>,
    observe: Observer,
  ): Promise<typeof EmbeddingResult.Type>
  timeout?: number
}) {
  const timeout = opts.timeout ?? 600_000
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 3_600_000)
    throw new Error("Embedding job deadline must be 1-3600000 ms")
  const roots = runtimes.get(opts.store) ?? new Map<string, Runtime>()
  runtimes.set(opts.store, roots)
  const runtime = roots.get(opts.root) ?? {
    owners: new Set<symbol>(),
    active: new Map<string, Active>(),
    queue: Promise.resolve(),
  }
  roots.set(opts.root, runtime)
  const owner = Symbol("embedding-jobs")
  runtime.owners.add(owner)
  let closed = false
  const key = (collection: string, session: string) => JSON.stringify([collection, session])
  const ready = () => (runtime.recovery ??= opts.store.recoverEmbeddings(opts.root))
  function check() {
    if (closed) throw new Error("Embedding jobs are closed")
  }

  async function lock<A>(fn: () => Promise<A>) {
    const previous = runtime.queue
    const done = Promise.withResolvers<void>()
    runtime.queue = done.promise
    await previous
    try {
      check()
      return await fn()
    } finally {
      done.resolve()
    }
  }
  function execute(active: Active) {
    const signal = AbortSignal.any([active.controller.signal, AbortSignal.timeout(timeout)])
    let writing = Promise.resolve()
    let failed = false
    let heartbeat = false
    const record = (patch: Partial<EmbeddingJob> | ((value: EmbeddingJob) => Partial<EmbeddingJob>)) => {
      const pending = writing.then(async () => {
        if (active.value.finished != null) return
        const value = {
          ...active.value,
          ...(typeof patch === "function" ? patch(active.value) : patch),
          revision: randomUUID(),
          updated: Date.now(),
        }
        await opts.store.embeddingJobSave(opts.root, value, active.value.revision)
        active.value = value
      })
      writing = pending.catch(() => {
        failed = true
        active.controller.abort(new Error("Embedding checkpoint failed"))
      })
      return pending
    }
    // Heartbeats preserve the last material-progress timestamp. They do not
    // turn a stalled provider call into fabricated completed work.
    const timer = setInterval(() => {
      if (heartbeat) return
      heartbeat = true
      void record({})
        .catch(() => console.warn("Forge embedding job heartbeat could not be saved"))
        .finally(() => {
          heartbeat = false
        })
    }, 1000)
    const pending = (async () => {
      try {
        await record({ state: "running" })
        const result = await wait(
          () =>
            opts.index(
              active.value.collection,
              active.value.session,
              active.value.target,
              signal,
              (progress) => {
                signal.throwIfAborted()
                return record({ progress, progressed: Date.now() })
              },
              (event) => record((value) => ({ usage: account(value.usage, event) })),
            ),
          signal,
        )
        signal.throwIfAborted()
        await record({ state: "completed", result, finished: Date.now() })
      } catch {
        await record({
          state: failed ? "failed" : signal.aborted ? "cancelled" : "failed",
          finished: Date.now(),
          error: failed
            ? "Embedding progress could not be saved. Review and retry."
            : signal.aborted
              ? "Embedding job cancelled or deadline exceeded. An admitted publication may have completed."
              : "Embedding job failed. Review destination, consent, permissions and source freshness before retrying.",
        }).catch(() => console.warn("Forge embedding job final state could not be saved"))
      } finally {
        clearInterval(timer)
        await writing
        const id = key(active.value.collection, active.value.session)
        if (runtime.active.get(id) === active) runtime.active.delete(id)
      }
    })()
    return pending
  }
  return {
    async start(collection: string, session = "", signal?: AbortSignal) {
      check()
      await wait(ready, signal)
      const target = await wait(() => opts.prepare(collection, session, signal), signal)
      return lock(() =>
        opts.store.fenced(opts.root, async () => {
          signal?.throwIfAborted()
          const id = key(collection, session)
          const current = runtime.active.get(id)
          if (current) {
            if (identity(current.value.target) !== identity(target))
              throw new Error("Cancel the previous destination's embedding job before starting another")
            return structuredClone(current.value)
          }
          if (runtime.active.size >= 2)
            throw new Error("Two embedding jobs are already active; wait or cancel before starting another")
          const now = Date.now()
          const value: EmbeddingJob = {
            id: randomUUID(),
            collection,
            session,
            revision: randomUUID(),
            target,
            state: "queued",
            started: now,
            updated: now,
            progressed: now,
            progress: { phase: "queued", processed: 0, embedded: 0, reused: 0 },
          }
          // Once this write is admitted the job belongs to the engine, not the
          // caller's connection. A lost start response is recovered by observation.
          await opts.store.embeddingJobSave(opts.root, value)
          const active: Active = { value, controller: new AbortController(), promise: Promise.resolve() }
          runtime.active.set(id, active)
          active.promise = execute(active)
          return structuredClone(value)
        }),
      )
    },
    async list(collection: string, session = "", signal?: AbortSignal) {
      check()
      await wait(ready, signal)
      await wait(() => opts.authorize(collection, session, signal), signal)
      return wait(() => opts.store.embeddingJobs(opts.root, collection, session), signal)
    },
    async cancel(collection: string, id: string, session = "", signal?: AbortSignal) {
      check()
      await wait(ready, signal)
      await wait(() => opts.authorize(collection, session, signal), signal)
      const active = runtime.active.get(key(collection, session))
      if (!active || active.value.id !== id) return
      active.controller.abort(new Error("Embedding job cancelled by user"))
      await wait(() => active.promise, signal)
    },
    async dispose() {
      if (closed) return
      closed = true
      runtime.owners.delete(owner)
      await runtime.queue
      if (runtime.owners.size) return
      for (const active of runtime.active.values()) active.controller.abort(new Error("Embedding host closed"))
      await Promise.all([...runtime.active.values()].map((active) => active.promise))
      if (roots.get(opts.root) === runtime && !runtime.owners.size) roots.delete(opts.root)
    },
  }
}
