import { createEffect, createSignal, onCleanup, onMount, Show, untrack } from "solid-js"
import type { ScrollBoxRenderable } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { decode, EmbeddingCoverage } from "@kilocode/forge/schema"
import { notice } from "@kilocode/forge/updates"
import { wait } from "@kilocode/forge/wait"
import { useSDK } from "../../context/sdk"
import { useTheme } from "../../context/theme"
import { scrolling } from "./scroll"
import { navigation } from "./back"

export function ForgeEmbeddingCoverage(props: {
  scope: { directory?: string; workspace?: string; session: string }
  target: { id: string; label: string }
  back(): void
}) {
  const sdk = useSDK()
  const { theme } = useTheme()
  const [value, setValue] = createSignal<EmbeddingCoverage>()
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal("")
  const [message, setMessage] = createSignal("")
  let controller: AbortController | undefined
  let scroll: ScrollBoxRenderable | undefined
  let disposed = false

  function cancel(message: string) {
    controller?.abort()
    controller = undefined
    setValue(undefined)
    setBusy(false)
    setError("")
    setMessage(message)
    scroll?.scrollTo(0)
  }
  createEffect(() => {
    props.scope.directory
    props.scope.workspace
    props.scope.session
    props.target.id
    untrack(() => cancel(""))
  })
  onMount(() => {
    const off = sdk.event.on("event", (event) => {
      if (!notice(event, props.scope, true)) return
      cancel("Knowledge changed. Check coverage again.")
    })
    onCleanup(off)
  })
  onCleanup(() => {
    disposed = true
    controller?.abort()
  })

  async function inspect() {
    if (disposed || busy()) return
    cancel("")
    const pending = new AbortController()
    controller = pending
    const scope = { ...props.scope, id: props.target.id }
    setBusy(true)
    try {
      const response = await wait(
        () => sdk.client.forge.embeddingCoverage(scope, { signal: pending.signal, throwOnError: true }),
        pending.signal,
      )
      if (disposed || pending.signal.aborted || controller !== pending) return
      const result = decode(EmbeddingCoverage, response.data)
      if (result.collection !== scope.id || result.session !== scope.session)
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
  scrolling(() => scroll)
  navigation(() => props.back())
  useKeyboard((event) => {
    if (event.ctrl || event.meta || event.option) return
    if (!["q", "r", "c"].includes(event.name)) return
    event.preventDefault()
    event.stopPropagation()
    if (event.name === "q") {
      props.back()
      return
    }
    if (event.name === "r") void inspect()
    if (event.name === "c" && busy()) cancel("Coverage check cancelled. No embedding job was cancelled.")
  })
  return (
    <box padding={1} gap={1}>
      <text fg={theme.primary}>Embedding coverage: {props.target.label}</text>
      <text>Explicit inspection only. No embedding text is sent; no indexing job is started.</text>
      <Show when={busy()}>
        <text>Checking originals and embedding coverage...</text>
      </Show>
      <scrollbox
        ref={(value: ScrollBoxRenderable) => {
          scroll = value
        }}
        height={16}
      >
        <Show when={error()}>
          <text fg={theme.error}>Coverage unavailable: {error()}</text>
        </Show>
        <Show when={message()}>
          <text>{message()}</text>
        </Show>
        <Show when={value()}>
          {(result) => (
            <box>
              <text>
                Stored nonblank sections: {result().sections}
                {"\n"}Reusable vectors: {result().reusable}
                {"\n"}Missing vectors: {result().missing}
                {"\n"}Outdated vectors: {result().outdated}
                {"\n"}Stale or unavailable originals: {result().stale}
                {"\n"}Excluded sections: {result().excluded}
              </text>
              <text>
                Observation started: {new Date(result().started).toISOString()}
                {"\n"}Observation finished: {new Date(result().finished).toISOString()}
              </text>
              <text>
                Model: {result().target.model}. Dimensions: {result().target.dimensions}
                {"\n"}Routing fingerprint: {result().target.fingerprint}
              </text>
            </box>
          )}
        </Show>
        <text>
          {"\n"}Requires a configured, approved destination and current permission. Reads local originals and cached
          vectors only. Coverage is not refreshed by job heartbeats.
        </text>
        <text>
          Counts cover stored nonblank sections, not undiscovered or unimported files. Excluded sections are not
          freshness-checked. Stale includes changed, unavailable, denied or invalid originals.
        </text>
        <text>
          This is an observation, not a guarantee of future freshness, provider usage or billing. Refresh local
          documents before re-embedding changed originals; indexing remains a separate explicit action.
        </text>
      </scrollbox>
      <text onMouseUp={() => void inspect()}>[r] Check embedding coverage</text>
      <Show when={busy()}>
        <text onMouseUp={() => cancel("Coverage check cancelled. No embedding job was cancelled.")}>
          [c] Cancel coverage check
        </text>
      </Show>
      <text>Up/Down or Page Up/Page Down to scroll</text>
      <text onMouseUp={() => props.back()}>[q] Back to embeddings · Esc / Backspace; leave jobs running</text>
    </box>
  )
}
