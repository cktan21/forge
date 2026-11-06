import { createEffect, createSignal, For, onCleanup, onMount, Show, untrack } from "solid-js"
import type { ScrollBoxRenderable } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { exportEmbeddings } from "@kilocode/forge/embedding-export"
import { notice } from "@kilocode/forge/updates"
import { useSDK } from "../../context/sdk"
import { useTheme } from "../../context/theme"
import { scrolling } from "./scroll"
import { navigation } from "./back"

export function ForgeEmbeddingUsage(props: {
  scope: { directory?: string; workspace?: string; session: string }
  target: { id: string; label: string }
  back(): void
}) {
  const sdk = useSDK()
  const { theme } = useTheme()
  const [value, setValue] = createSignal<Awaited<ReturnType<typeof exportEmbeddings>>>()
  const [busy, setBusy] = createSignal(false)
  const [details, setDetails] = createSignal(false)
  const [error, setError] = createSignal("")
  const [message, setMessage] = createSignal("")
  let controller: AbortController | undefined
  let scroll: ScrollBoxRenderable | undefined
  let disposed = false

  function clear(message: string) {
    controller?.abort()
    controller = undefined
    setValue(undefined)
    setBusy(false)
    setDetails(false)
    setError("")
    setMessage(message)
    scroll?.scrollTo(0)
  }
  createEffect(() => {
    props.scope.directory
    props.scope.workspace
    props.scope.session
    props.target.id
    untrack(() => clear(""))
  })
  onMount(() => {
    const off = sdk.event.on("event", (event) => {
      if (notice(event, props.scope, true)) clear("Knowledge changed. Inspect usage again.")
    })
    onCleanup(off)
  })
  onCleanup(() => {
    disposed = true
    controller?.abort()
  })

  async function inspect(after?: string) {
    if (disposed || busy()) return
    clear("")
    const pending = new AbortController()
    controller = pending
    const scope = { ...props.scope }
    setBusy(true)
    const timer = setTimeout(() => {
      if (!disposed && controller === pending) clear("Usage inspection timed out. No embedding job was cancelled.")
    }, 30_000)
    try {
      const result = await exportEmbeddings({
        session: scope.session,
        max: 100,
        after,
        signal: pending.signal,
        read: async (request, signal) => {
          const response = await sdk.client.forge.embeddingUsage(
            { ...scope, ...request, limit: String(request.limit) },
            { signal, throwOnError: true },
          )
          return response.data
        },
      })
      if (!disposed && !pending.signal.aborted && controller === pending) setValue(result)
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
  function toggle() {
    if (!value()) return
    setDetails(!details())
    scroll?.scrollTo(0)
  }
  scrolling(() => scroll)
  navigation(() => props.back())
  useKeyboard((event) => {
    if (event.ctrl || event.meta || event.option) return
    if (!["q", "r", "n", "c", "d"].includes(event.name)) return
    event.preventDefault()
    event.stopPropagation()
    if (event.name === "q") {
      props.back()
      return
    }
    if (event.name === "r") void inspect()
    if (event.name === "n" && value()?.next) void inspect(value()!.next)
    if (event.name === "c" && busy()) clear("Usage inspection cancelled. No embedding job was cancelled.")
    if (event.name === "d") toggle()
  })
  return (
    <box padding={1} gap={1}>
      <text fg={theme.primary}>Recorded embedding usage across this session</text>
      <text>
        Scope: {props.scope.session || "workspace (empty session)"}. Not limited to {props.target.label}.
      </text>
      <text>No automatic inspection. No model call, consent grant or indexing job is started.</text>
      <Show when={busy()}>
        <text>Reading recorded embedding usage...</text>
      </Show>
      <scrollbox
        ref={(value: ScrollBoxRenderable) => {
          scroll = value
        }}
        height={16}
        contentOptions={{ paddingRight: 1 }}
      >
        <Show when={error()}>
          <text fg={theme.error}>Usage unavailable: {error()}</text>
        </Show>
        <Show when={message()}>
          <text>{message()}</text>
        </Show>
        <Show when={value()}>
          {(result) => (
            <box>
              <text>{result().entries.length} observed attempts in this page. Subtotals apply only to this page.</text>
              <text>
                {result().next
                  ? "More recorded attempts are available."
                  : "End of observed pages; this does not prove complete historical usage."}
              </text>
              <text>
                Observation: {new Date(result().started).toISOString()} to {new Date(result().finished).toISOString()}.
              </text>
              <Show
                when={details()}
                fallback={
                  <For each={result().groups}>
                    {(group) => (
                      <box>
                        <text>
                          Purpose: {group.purpose}. Model: {group.target.model}. Dimensions: {group.target.dimensions}.
                          {"\n"}Routing fingerprint: {group.target.fingerprint}
                        </text>
                        <text>
                          Admitted attempts: {group.usage.attempts}; inputs: {group.usage.inputs}; request-body bytes:{" "}
                          {group.usage.bytes}.{"\n"}JSON responses: {group.usage.responses}; failed:{" "}
                          {group.usage.failed}; unresolved: {group.usage.pending}.{"\n"}Prompt tokens:{" "}
                          {group.usage.promptTokens}; reports: {group.usage.promptReports}; unknown attempts:{" "}
                          {group.unknown.prompt}.{"\n"}Total tokens: {group.usage.totalTokens}; reports:{" "}
                          {group.usage.totalReports}; unknown attempts: {group.unknown.total}.
                        </text>
                      </box>
                    )}
                  </For>
                }
              >
                <For each={result().entries}>
                  {(entry) => (
                    <text>
                      Attempt {entry.id}: {entry.purpose}; collections: {entry.collections.join(", ")}.{"\n"}Admitted
                      timestamp: {entry.started}; outcome timestamp: {entry.finished ?? "unresolved"}.{"\n"}Model:{" "}
                      {entry.target.model}; dimensions: {entry.target.dimensions}; routing fingerprint:{" "}
                      {entry.target.fingerprint}.{"\n"}Inputs: {entry.usage.inputs}; bytes: {entry.usage.bytes}; JSON
                      responses: {entry.usage.responses}; failed: {entry.usage.failed}; unresolved:{" "}
                      {entry.usage.pending}.{"\n"}
                    </text>
                  )}
                </For>
              </Show>
              <For each={result().warnings}>{(warning) => <text>{warning}</text>}</For>
            </box>
          )}
        </Show>
        <text>
          {"\n"}Up to 100 attempts per page across accessible collections in this exact session. Access is required for
          every collection in the page. Next page replaces this observation.
        </text>
        <text>
          Use kilo forge-usage or the browser to export JSON. Changes without a delivered event require reinspection.
        </text>
      </scrollbox>
      <text onMouseUp={() => void inspect()}>[r] Inspect latest usage</text>
      <Show when={value()?.next}>
        <text onMouseUp={() => void inspect(value()!.next)}>[n] Next usage page</text>
      </Show>
      <Show when={value()}>
        <text onMouseUp={toggle}>[d] {details() ? "Show page subtotals" : "Show observed attempt records"}</text>
      </Show>
      <Show when={busy()}>
        <text onMouseUp={() => clear("Usage inspection cancelled. No embedding job was cancelled.")}>
          [c] Cancel usage inspection
        </text>
      </Show>
      <text>Up/Down or Page Up/Page Down to scroll</text>
      <text onMouseUp={() => props.back()}>[q] Back to embeddings · Esc / Backspace; leave jobs running</text>
    </box>
  )
}
