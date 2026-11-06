import { createEffect, createSignal, onCleanup, Show, untrack } from "solid-js"
import { decode, EmbeddingCoverage } from "@kilocode/forge/schema"
import "./coverage.css"

export function Coverage(props: {
  id: string
  session: string
  generation: string
  disabled: boolean
  inspect(signal: AbortSignal): Promise<unknown>
}) {
  const [value, setValue] = createSignal<EmbeddingCoverage>()
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal("")
  const [message, setMessage] = createSignal("")
  let controller: AbortController | undefined
  let disposed = false

  function cancel(message: string) {
    controller?.abort()
    controller = undefined
    setValue(undefined)
    setBusy(false)
    setError("")
    setMessage(message)
  }
  createEffect(() => {
    props.id
    props.session
    props.generation
    untrack(() => cancel(value() || busy() ? "Knowledge or embedding state changed. Check coverage again." : ""))
  })
  onCleanup(() => {
    disposed = true
    controller?.abort()
  })

  async function inspect() {
    if (props.disabled || busy()) return
    const id = props.id
    const session = props.session
    cancel("")
    const pending = new AbortController()
    controller = pending
    setBusy(true)
    try {
      const response = await props.inspect(pending.signal)
      if (disposed || pending.signal.aborted || controller !== pending) return
      const result = decode(EmbeddingCoverage, response)
      if (result.collection !== id || result.session !== session)
        throw new Error("Coverage does not match the active collection and session")
      if (
        result.sections > 10_000 ||
        result.sections !== result.reusable + result.missing + result.outdated + result.stale + result.excluded ||
        result.finished < result.started ||
        [result.started, result.finished].some((time) => !Number.isFinite(new Date(time).getTime()))
      ) {
        throw new Error("Coverage contains invalid counts or timestamps")
      }
      setValue(result)
    } catch (err) {
      if (disposed || pending.signal.aborted || controller !== pending) return
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (!disposed && controller === pending) {
        controller = undefined
        setBusy(false)
      }
    }
  }

  return (
    <section class="embedding-coverage" aria-label="Embedding coverage">
      <h4>Stored-section embedding coverage</h4>
      <p>
        Check current originals and cached vectors for the configured, approved destination. This reads local originals
        but sends no embedding text and starts no job. Coverage is checked only on request, not on job heartbeats.
      </p>
      <button disabled={props.disabled || busy()} onClick={() => void inspect()}>
        Check embedding coverage
      </button>
      <Show when={busy()}>
        <p role="status">Checking originals and embedding coverage...</p>
        <button onClick={() => cancel("Coverage check cancelled. No embedding job was cancelled.")}>
          Cancel coverage check
        </button>
      </Show>
      <Show when={message()}>
        <p role="status">{message()}</p>
      </Show>
      <Show when={error()}>
        <p role="alert">Coverage unavailable: {error()}</p>
      </Show>
      <Show when={value()}>
        {(result) => (
          <>
            <p>
              Observation: {new Date(result().started).toISOString()} to {new Date(result().finished).toISOString()}.
            </p>
            <p class="path">
              Model: {result().target.model}. Dimensions: {result().target.dimensions}. Routing fingerprint:{" "}
              {result().target.fingerprint}
            </p>
            <dl>
              <dt>Stored nonblank sections</dt>
              <dd>{result().sections}</dd>
              <dt>Reusable vectors</dt>
              <dd>{result().reusable}</dd>
              <dt>Missing vectors</dt>
              <dd>{result().missing}</dd>
              <dt>Outdated vectors</dt>
              <dd>{result().outdated}</dd>
              <dt>Stale or unavailable originals</dt>
              <dd>{result().stale}</dd>
              <dt>Excluded sections</dt>
              <dd>{result().excluded}</dd>
            </dl>
          </>
        )}
      </Show>
      <p class="muted">
        Counts cover stored nonblank sections, not undiscovered or unimported files. Excluded sections are not
        freshness-checked. Stale includes changed, unavailable, denied or invalid originals. This is an observation, not
        a guarantee of future freshness, provider usage or billing. Refresh local documents before re-embedding changed
        originals; indexing remains a separate explicit action.
      </p>
    </section>
  )
}
