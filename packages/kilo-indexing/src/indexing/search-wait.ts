// Cancel a caller's read without cancelling shared initialization or claiming
// transport abortion. Always observe late results, but never resume the caller.
export async function wait<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted()
  if (!signal) return work()
  const pending = Promise.withResolvers<T>()
  const abort = () => pending.reject(signal.reason)
  signal.addEventListener("abort", abort, { once: true })
  try {
    Promise.resolve()
      .then(() => {
        signal.throwIfAborted()
        return work()
      })
      .then(pending.resolve, pending.reject)
    const result = await pending.promise
    signal.throwIfAborted()
    return result
  } finally {
    signal.removeEventListener("abort", abort)
  }
}
