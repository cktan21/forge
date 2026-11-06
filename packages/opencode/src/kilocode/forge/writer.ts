import type { Query } from "@kilocode/forge"

declare global {
  const KILO_FORGE_STORAGE_WORKER_PATH: string
}

export async function writer(file: string) {
  const path = typeof KILO_FORGE_STORAGE_WORKER_PATH !== "undefined"
    ? KILO_FORGE_STORAGE_WORKER_PATH
    : new URL("./storage-worker.ts", import.meta.url)
  const worker = new Worker(path)
  const pending = new Map<number, ReturnType<typeof Promise.withResolvers<void>>>()
  let sequence = 0
  let closed = false
  let failure: Error | undefined
  let queue = Promise.resolve()

  function fail(err: Error) {
    failure = err
    for (const result of pending.values()) result.reject(err)
    pending.clear()
  }
  worker.onmessage = (event: MessageEvent<{ id: number; error?: string }>) => {
    const result = pending.get(event.data.id)
    if (!result) return
    pending.delete(event.data.id)
    if (event.data.error != null) { result.reject(new Error(event.data.error)); return }
    result.resolve()
  }
  worker.onerror = (event) => fail(new Error(event.message || "Forge writer failed"))
  worker.addEventListener("close", () => fail(new Error("Forge writer closed")))

  async function send(message: { file?: string; queries?: readonly Query[]; start?: boolean; finish?: boolean; rollback?: boolean; close?: boolean }) {
    if (failure) throw failure
    const id = ++sequence
    const result = Promise.withResolvers<void>()
    pending.set(id, result)
    try {
      worker.postMessage({ ...message, id })
      await result.promise
    } finally {
      pending.delete(id)
    }
  }

  try {
    await send({ file })
  } catch (err) {
    worker.terminate()
    throw err
  }
  return {
    async batch(queries: readonly Query[]) {
      if (closed) throw new Error("Forge writer is closed")
      const previous = queue
      const done = Promise.withResolvers<void>()
      queue = done.promise
      await previous
      try {
        await send({ start: true })
        // Bound IPC copies without releasing either the SQLite transaction or
        // the host lease. Individual values (notably snapshots) remain intact.
        for (let offset = 0; offset < queries.length; offset += 16) {
          await send({ queries: queries.slice(offset, offset + 16) })
        }
        await send({ finish: true })
      } catch (err) {
        await send({ rollback: true }).catch((rollback: unknown) => {
          throw new AggregateError([err, rollback], "Forge writer failed before rollback could be confirmed", { cause: rollback })
        })
        throw err
      } finally {
        done.resolve()
      }
    },
    async close() {
      if (closed) return
      closed = true
      // Do not terminate an admitted transaction: settle its commit/rollback first.
      await queue
      try { await send({ close: true }) } finally { worker.terminate() }
    },
  }
}
