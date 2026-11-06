import { createKiloClient } from "@kilocode/sdk/v2/client"
import { notice } from "./updates"

// Reuse the SDK parser and authenticated instance stream. Reconnects always
// request a fresh view because the server stream is not a replay log.
export async function stream(opts: {
  url: string
  directory?: string
  workspace?: string
  session: string
  headers?: HeadersInit
  signal: AbortSignal
  refresh: () => void
  connected: (value: boolean) => void
  error: (err: unknown) => void
}) {
  // Use the explicit handoff header, not browser cookies or Basic-auth prompts.
  const client = createKiloClient({ baseUrl: opts.url, headers: opts.headers, signal: opts.signal, credentials: "omit" })
  let attempt = 0
  while (!opts.signal.aborted) {
    const connection = new AbortController()
    const signal = AbortSignal.any([opts.signal, connection.signal])
    let timer = setTimeout(() => connection.abort(new Error("Event heartbeat timed out")), 25_000)
    try {
      const result = await client.event.subscribe({ directory: opts.directory, workspace: opts.workspace }, {
        signal,
        sseMaxRetryAttempts: 0,
        onSseError: (err) => { if (!opts.signal.aborted) opts.error(err) },
        onSseEvent: (event) => {
          if (opts.signal.aborted) return
          clearTimeout(timer)
          timer = setTimeout(() => connection.abort(new Error("Event heartbeat timed out")), 25_000)
          attempt = 0
          opts.connected(true)
          if (notice(event.data, opts)) opts.refresh()
        },
      })
      for await (const _ of result.stream) { if (opts.signal.aborted) break }
    } catch (err) { if (!opts.signal.aborted) opts.error(err) } finally { clearTimeout(timer); connection.abort() }
    opts.connected(false)
    if (opts.signal.aborted) return
    const wait = Promise.withResolvers<void>()
    const done = () => wait.resolve()
    timer = setTimeout(done, Math.min(30_000, 1000 * 2 ** attempt++))
    opts.signal.addEventListener("abort", done, { once: true })
    await wait.promise
    clearTimeout(timer)
    opts.signal.removeEventListener("abort", done)
  }
}
