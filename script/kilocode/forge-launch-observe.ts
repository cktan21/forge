// Keep failed probe reads bounded and preserve nested transport diagnostics.
export async function observe<A>(read: () => Promise<A>, failed: (error: string) => void) {
  try {
    return await read()
  } catch (err) {
    const causes: unknown[] = []
    let cause: unknown = err
    while (cause != null && !causes.includes(cause) && causes.length < 8) {
      causes.push(cause)
      cause = cause instanceof Error ? cause.cause : undefined
    }
    failed(causes.map((cause) => String(cause)).join(" <- "))
    // A restarted watcher has lost this listener; retrying it cannot measure the same launch.
    if (causes.some((cause) => cause instanceof Error && "code" in cause && cause.code === "ECONNREFUSED")) throw err
    await Bun.sleep(100)
    return undefined
  }
}
