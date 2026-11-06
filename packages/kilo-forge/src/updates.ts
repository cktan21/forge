type Scope = { directory?: string; workspace?: string; session: string }

function record(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object"
}

export function notice(value: unknown, scope: Scope, global = false) {
  if (!record(value)) return false
  const event = global ? value.payload : value
  if (!record(event)) return false
  if (event.type === "server.connected") return true
  if (global && (value.directory !== scope.directory || value.workspace !== scope.workspace)) return false
  if (event.type === "indexing.status") return true
  if (event.type !== "forge.changed" || !record(event.properties)) return false
  return event.properties.session === "" || event.properties.session === scope.session
}

// Coalesce bursts without overlapping reads or losing a change arriving during a read.
export function updates(opts: { signal: AbortSignal; load: () => Promise<void>; error: (err: unknown) => void; delay?: number }) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let running = false
  let dirty = false
  async function drain() {
    timer = undefined
    if (opts.signal.aborted) return
    running = true
    dirty = false
    try { await opts.load() } catch (err) { if (!opts.signal.aborted) opts.error(err) } finally {
      running = false
      if (dirty) refresh()
    }
  }
  function refresh() {
    if (opts.signal.aborted) return
    dirty = true
    if (!running && !timer) timer = setTimeout(() => void drain(), opts.delay ?? 50)
  }
  opts.signal.addEventListener("abort", () => { clearTimeout(timer); dirty = false }, { once: true })
  return refresh
}
