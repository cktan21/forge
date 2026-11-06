import { createEffect, createSignal, createUniqueId, For, onCleanup, Show } from "solid-js"
import type { ImportHistory } from "@kilocode/forge/schema"
import { history } from "@kilocode/forge/imports"

export function Imports(props: { load: (opts: { run?: string; offset: number; signal: AbortSignal }) => Promise<ImportHistory>; revision?: string; close: () => void }) {
  const id = createUniqueId()
  const [value, setValue] = createSignal<ImportHistory>()
  const [run, setRun] = createSignal<string>()
  const [offset, setOffset] = createSignal(0)
  const [revision, setRevision] = createSignal(0)
  const [error, setError] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const controller = new AbortController()
  let sequence = 0
  createEffect(() => {
    props.revision
    revision()
    const opts = { run: run(), offset: offset(), signal: controller.signal }
    const attempt = ++sequence
    setBusy(true)
    setError("")
    setValue(undefined)
    void props.load(opts).then((value) => {
      if (attempt === sequence && !controller.signal.aborted) setValue(value)
    }, (err) => {
      if (attempt === sequence && !controller.signal.aborted) setError(String(err))
    }).finally(() => { if (attempt === sequence) setBusy(false) })
  })
  onCleanup(() => controller.abort())
  return <article aria-label="Import history">
    <h3>Import history</h3>
    <button onClick={props.close}>Close import history</button>
    <button disabled={busy()} onClick={() => setRevision((value) => value + 1)}>Reload import history</button>
    <Show when={error()}><p role="alert">{error()}</p></Show>
    <Show when={busy()}><p role="status">Loading import history...</p></Show>
    <Show when={value()}>{(value) => <>
      <label for={id}>Import run</label>
      <select id={id} value={run() ?? ""} onChange={(event) => { setRun(event.currentTarget.value || undefined); setOffset(0) }}>
        <option value="">Latest retained run</option>
        <For each={value().runs}>{(item) => <option value={item.id}>{new Date(item.started).toISOString()} · {item.state}</option>}</For>
      </select>
      <For each={history(value())}>{(line) => <p class="muted">{line}</p>}</For>
      <button disabled={!value().page.offset} onClick={() => setOffset(Math.max(0, value().page.offset - value().page.limit))}>Previous import files</button>
      <button disabled={value().page.next == null} onClick={() => setOffset(value().page.next!)}>Next import files</button>
    </>}</Show>
  </article>
}
