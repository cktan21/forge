// A non-cooperative adapter may continue running, but cannot keep its caller
// waiting or have its eventual result accepted after this scope ends.
export async function deadline<A>(run: (signal: AbortSignal) => Promise<A>, signal?: AbortSignal, milliseconds = 30_000, reason: Error | (() => Error) = new Error("Retrieval channel deadline exceeded (30 seconds by default)")): Promise<A> {
  const controller = new AbortController()
  const aborted = Promise.withResolvers<never>()
  const cancel = () => controller.abort(signal?.reason)
  const reject = () => aborted.reject(controller.signal.reason)
  controller.signal.addEventListener("abort", reject, { once: true })
  signal?.addEventListener("abort", cancel, { once: true })
  if (signal?.aborted) cancel()
  const timer = setTimeout(() => controller.abort(typeof reason === "function" ? reason() : reason), milliseconds)
  try {
    const result = await Promise.race([
      aborted.promise,
      Promise.resolve().then(() => {
        controller.signal.throwIfAborted()
        return run(controller.signal)
      }),
    ])
    controller.signal.throwIfAborted()
    return result
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", cancel)
    controller.signal.removeEventListener("abort", reject)
    controller.abort(new Error("Retrieval channel scope closed"))
  }
}
