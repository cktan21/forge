// Observations are memory-only. Never enqueue heartbeat writes behind the work
// being observed. Atomic operations retain their owner until commit/rollback.
export async function wait<A>(
  run: () => Promise<A>,
  signal?: AbortSignal,
  observe?: (message: string) => void,
  atomic = false,
): Promise<A> {
  signal?.throwIfAborted()
  const started = Date.now()
  const cancelled = Promise.withResolvers<never>()
  function report() {
    const seconds = Math.floor((Date.now() - started) / 1000)
    observe?.(signal?.aborted
      ? `${signal.reason?.name === "TimeoutError" ? "Deadline exceeded" : "Cancellation requested"}; ${atomic ? "cancellation pending: admitted write must finish commit/rollback" : "late results will be discarded"}.`
      : `${seconds >= 5 ? "Stalled: no completion observed" : "Waiting"} (${seconds}s); ${atomic ? "atomic write completion pending" : "no completion or ETA reported"}.`)
  }
  const abort = () => {
    report()
    if (!atomic) cancelled.reject(signal?.reason)
  }
  signal?.addEventListener("abort", abort, { once: true })
  const timer = observe ? setInterval(report, 1000) : undefined
  try {
    report()
    const pending = Promise.resolve().then(() => {
      signal?.throwIfAborted()
      return run()
    })
    const value = await (atomic ? pending : Promise.race([pending, cancelled.promise]))
    if (!atomic) signal?.throwIfAborted()
    return value
  } finally {
    clearInterval(timer)
    signal?.removeEventListener("abort", abort)
  }
}
