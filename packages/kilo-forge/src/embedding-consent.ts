import { Schema } from "effect"
import type { Store } from "./store"
import { decode, EmbeddingTarget, type Collection } from "./schema"
import { hash } from "./util"
import { wait } from "./wait"

export const Target = EmbeddingTarget
export type Target = typeof Target.Type

export const Grant = Schema.Struct({
  version: Schema.Literal("forge-embedding-consent-v1"),
  revision: Schema.String,
  target: Schema.optional(Target),
})

export function identity(target: Target) {
  const value = decode(Target, target)
  return hash(JSON.stringify(["forge-collection-embedding-v1", value.fingerprint, value.model, value.dimensions]))
}

// Host methods must enforce session ownership and Kilo permissions. A persisted
// grant never overrides a live denial or authorizes a different transport.
export function embeddingConsent(opts: {
  root: string
  store: Store
  target(): Promise<Target>
  authorize(collection: Collection, session: string, target?: Target): Promise<void>
}) {
  async function inspect(key: string, session: string, signal?: AbortSignal) {
    const state = await wait(() => opts.store.embedding(opts.root, key, session), signal)
    await wait(() => opts.authorize(state.collection, session), signal)
    return state
  }

  const revision = (state: Awaited<ReturnType<Store["embedding"]>>, target: Target) =>
    hash(JSON.stringify([state.body, state.grant, identity(target)]))

  return {
    async review(key: string, session = "", signal?: AbortSignal) {
      const state = await inspect(key, session, signal)
      const target = decode(Target, await wait(() => opts.target(), signal))
      const grant = state.grant == null ? undefined : decode(Grant, JSON.parse(state.grant))
      return {
        target,
        revision: revision(state, target),
        approved: !!grant?.target && identity(grant.target) === identity(target) && state.collection.approved,
      }
    },
    async approve(key: string, expected: string, session = "", signal?: AbortSignal) {
      return opts.store.fenced(opts.root, async () => {
        const state = await inspect(key, session, signal)
        if (!state.collection.approved || state.collection.state !== "ready") {
          throw new Error("Approve and index the collection locally before embedding approval")
        }
        const target = Object.freeze({ ...decode(Target, await wait(() => opts.target(), signal)) })
        if (revision(state, target) !== expected) throw new Error("Embedding review changed. Reload before approving.")
        await wait(() => opts.authorize(state.collection, session, target), signal)
        if (identity(decode(Target, await wait(() => opts.target(), signal))) !== identity(target)) {
          throw new Error("Embedding destination changed during approval")
        }
        await wait(
          () =>
            opts.store.embeddingSave(opts.root, key, session, state, {
              version: "forge-embedding-consent-v1",
              revision: crypto.randomUUID(),
              target,
            }),
          signal,
          undefined,
          true,
        )
        signal?.throwIfAborted()
      })
    },
    async revoke(key: string, session = "", signal?: AbortSignal) {
      // No provider resolution is required to withdraw consent.
      const state = await inspect(key, session, signal)
      await wait(
        () =>
          opts.store.embeddingSave(opts.root, key, session, state, {
            version: "forge-embedding-consent-v1",
            revision: crypto.randomUUID(),
          }),
        signal,
        undefined,
        true,
      )
      signal?.throwIfAborted()
    },
    async authorize(input: { collection: Collection; session: string; target: Target }, signal?: AbortSignal) {
      const state = await inspect(input.collection.id, input.session, signal)
      const grant = state.grant == null ? undefined : decode(Grant, JSON.parse(state.grant))
      if (
        !state.collection.approved ||
        state.collection.state !== "ready" ||
        !grant?.target ||
        identity(grant.target) !== identity(input.target)
      ) {
        throw new Error("Embedding destination has not been approved")
      }
      await wait(() => opts.authorize(state.collection, input.session, input.target), signal)
      const current = decode(Target, await wait(() => opts.target(), signal))
      if (identity(current) !== identity(input.target)) throw new Error("Embedding destination changed")
      const latest = await wait(() => opts.store.embedding(opts.root, input.collection.id, input.session), signal)
      if (latest.body !== state.body || latest.grant !== state.grant) throw new Error("Embedding consent changed")
    },
  }
}
