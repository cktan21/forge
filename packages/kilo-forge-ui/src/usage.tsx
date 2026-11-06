import { createEffect, createSignal, For, onCleanup, Show, untrack } from "solid-js"
import { exportEmbeddings } from "@kilocode/forge/embedding-export"
import "./usage.css"

export function Usage(props: {
  id: string
  session: string
  generation: string
  disabled: boolean
  read(request: { session: string; limit: number; after?: string }, signal?: AbortSignal): Promise<unknown>
}) {
  const [value, setValue] = createSignal<Awaited<ReturnType<typeof exportEmbeddings>>>()
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal("")
  const [message, setMessage] = createSignal("")
  const [url, setUrl] = createSignal("")
  let controller: AbortController | undefined
  let disposed = false

  function clear(message: string) {
    controller?.abort()
    controller = undefined
    setBusy(false)
    setValue(undefined)
    setError("")
    setMessage(message)
    if (url()) URL.revokeObjectURL(url())
    setUrl("")
  }
  createEffect(() => {
    props.id
    props.session
    props.generation
    untrack(() => clear(value() || busy() ? "Knowledge or embedding state changed. Inspect usage again." : ""))
  })
  onCleanup(() => {
    disposed = true
    clear("")
  })

  async function inspect(after?: string) {
    if (props.disabled || busy()) return
    clear("")
    const pending = new AbortController()
    controller = pending
    setBusy(true)
    const timer = setTimeout(() => {
      if (!disposed && controller === pending) clear("Usage inspection timed out. No embedding job was cancelled.")
    }, 30_000)
    try {
      const result = await exportEmbeddings({
        session: props.session,
        max: 100,
        after,
        signal: pending.signal,
        read: (request, signal) => props.read(request, signal),
      })
      if (disposed || pending.signal.aborted || controller !== pending) return
      const blob = new Blob([JSON.stringify(result, null, 2) + "\n"], { type: "application/json" })
      setUrl(URL.createObjectURL(blob))
      setValue(result)
    } catch (err) {
      if (!disposed && !pending.signal.aborted && controller === pending)
        setError(err instanceof Error ? err.message : String(err))
    } finally {
      clearTimeout(timer)
      if (!disposed && controller === pending) {
        controller = undefined
        setBusy(false)
      }
    }
  }

  return (
    <section class="embedding-usage" aria-label="Session embedding usage">
      <h4>Recorded embedding usage across this session</h4>
      <p class="path">
        Scope: {props.session || "workspace (empty session)"}. Includes recorded attempts across collections in this exact
        scope, not only the selected collection. Access is required for every collection in the page.
      </p>
      <p>
        Inspect up to 100 recorded attempts per page, including queries, synchronous indexing and background jobs. This
        reads usage only; it sends no embedding text, grants no consent and starts no job. No automatic inspection.
      </p>
      <div class="actions">
        <button disabled={props.disabled || busy()} onClick={() => void inspect()}>
          Inspect latest usage
        </button>
        <Show when={busy()}>
          <button onClick={() => clear("Usage inspection cancelled. No embedding job was cancelled.")}>
            Cancel usage inspection
          </button>
        </Show>
      </div>
      <Show when={busy()}>
        <p role="status">Reading recorded embedding usage...</p>
      </Show>
      <Show when={message()}>
        <p role="status">{message()}</p>
      </Show>
      <Show when={error()}>
        <p role="alert">Usage unavailable: {error()}</p>
      </Show>
      <Show when={value()}>
        {(result) => (
          <>
            <p>
              Observation: {new Date(result().started).toISOString()} to {new Date(result().finished).toISOString()}.
            </p>
            <p>{result().entries.length} observed attempts in this page. Subtotals apply only to this page.</p>
            <p>
              {result().next
                ? "More recorded attempts are available."
                : "End of observed pages; this does not prove complete historical usage."}
            </p>
            <For each={result().groups}>
              {(group) => (
                <div aria-label="Usage subtotal">
                  <p class="path">
                    Purpose: {group.purpose}. Model: {group.target.model}. Dimensions: {group.target.dimensions}.
                    Routing fingerprint: {group.target.fingerprint}
                  </p>
                  <dl>
                    <dt>Admitted attempts / inputs</dt>
                    <dd>
                      {group.usage.attempts} / {group.usage.inputs}
                    </dd>
                    <dt>Request-body bytes</dt>
                    <dd>{group.usage.bytes}</dd>
                    <dt>JSON responses / failed / unresolved</dt>
                    <dd>
                      {group.usage.responses} / {group.usage.failed} / {group.usage.pending}
                    </dd>
                    <dt>Prompt tokens / reports / unknown attempts</dt>
                    <dd>
                      {group.usage.promptTokens} / {group.usage.promptReports} / {group.unknown.prompt}
                    </dd>
                    <dt>Total tokens / reports / unknown attempts</dt>
                    <dd>
                      {group.usage.totalTokens} / {group.usage.totalReports} / {group.unknown.total}
                    </dd>
                  </dl>
                </div>
              )}
            </For>
            <details>
              <summary>Observed attempt records ({result().entries.length})</summary>
              <For each={result().entries}>
                {(entry) => (
                  <p class="path">
                    {entry.id}: {entry.purpose}; collections: {entry.collections.join(", ")}. Admitted timestamp:{" "}
                    {entry.started}; outcome timestamp: {entry.finished ?? "unresolved"}. Model: {entry.target.model};
                    routing fingerprint: {entry.target.fingerprint}. Inputs: {entry.usage.inputs}; bytes:{" "}
                    {entry.usage.bytes}; JSON responses: {entry.usage.responses}; failed: {entry.usage.failed};
                    unresolved: {entry.usage.pending}.
                  </p>
                )}
              </For>
            </details>
            <For each={result().warnings}>{(warning) => <p class="muted">{warning}</p>}</For>
            <p class="muted">
              Download saves this observation, not a fresh read. Downloaded copies survive later permission changes and
              backend purge; protect or delete them separately.
            </p>
            <div class="actions">
              <Show when={!props.disabled && url()}>
                <a href={url()} download="forge-embedding-usage.json">
                  Download observed usage JSON
                </a>
              </Show>
              <Show when={result().next}>
                <button disabled={props.disabled || busy()} onClick={() => void inspect(result().next)}>
                  Next usage page
                </button>
              </Show>
            </div>
          </>
        )}
      </Show>
    </section>
  )
}
