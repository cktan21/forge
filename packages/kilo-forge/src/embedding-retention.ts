import type { Collection } from "./schema"
import type { Store } from "./store"
import type { knowledge } from "./knowledge"
import { hash } from "./util"
import { wait } from "./wait"

type Policy = { session?: string; before: number; keep: number }

export function retention(opts: {
  root: string
  store: Store
  library: ReturnType<typeof knowledge>
  authorize(collection: Collection, session: string): Promise<void>
}) {
  async function review(request: Policy, signal?: AbortSignal) {
    signal?.throwIfAborted()
    const page = await wait(
      () => opts.store.embeddingRetention(opts.root, request.session ?? "", request.before, request.keep),
      signal,
    )
    for (const key of new Set(page.entries.flatMap((entry) => entry.collections))) {
      const item = await wait(() => opts.library.get(key, page.session), signal)
      await wait(() => opts.authorize(item, page.session), signal)
    }
    const stamp = await wait(() => opts.store.embeddingObservation(opts.root), signal)
    if (stamp.revision !== page.observation.revision) throw new Error("Ledger changed during retention review")
    const { entries, ...metadata } = page
    return {
      entries,
      value: {
        ...metadata,
        selected: entries.length,
        revision: hash(JSON.stringify([opts.root, metadata, entries.map((entry) => entry.id)])),
      },
    }
  }
  return {
    retention: (request: Policy, signal?: AbortSignal) =>
      wait(() => opts.store.fenced(opts.root, async () => (await review(request, signal)).value), signal),
    prune: (request: Policy & { revision: string; confirmation: string }, signal?: AbortSignal) =>
      wait(
        () =>
          opts.store.fenced(opts.root, async () => {
            if (request.confirmation !== "DELETE") throw new Error("Retention requires explicit DELETE confirmation")
            const page = await review(request, signal)
            if (page.value.revision !== request.revision) throw new Error("Retention preview changed. Review again.")
            signal?.throwIfAborted()
            await opts.store.embeddingPrune(
              opts.root,
              page.value.session,
              page.value.observation.revision,
              page.entries.map((entry) => entry.id),
            )
            return { deleted: page.value.selected, more: page.value.more }
          }),
        signal,
      ),
  }
}
