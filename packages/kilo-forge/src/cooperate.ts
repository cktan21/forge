import { setImmediate as immediate } from "node:timers/promises"

export function checkpoint(signal?: AbortSignal) {
  let next = performance.now() + 8
  return async () => {
    signal?.throwIfAborted()
    if (performance.now() < next) return
    await immediate()
    signal?.throwIfAborted()
    next = performance.now() + 8
  }
}
