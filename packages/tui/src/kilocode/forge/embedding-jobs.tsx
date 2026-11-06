import { createEffect, createSignal, onCleanup, onMount, Show, untrack } from "solid-js"
import type { ScrollBoxRenderable } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { decode, EmbeddingJobs, type EmbeddingJob } from "@kilocode/forge/schema"
import { notice } from "@kilocode/forge/updates"
import { wait } from "@kilocode/forge/wait"
import { summary } from "@kilocode/forge/embedding-usage"
import { useSDK } from "../../context/sdk"
import { useTheme } from "../../context/theme"
import { scrolling } from "./scroll"
import { navigation } from "./back"

export function ForgeEmbeddingJobs(props: {
  scope: { directory?: string; workspace?: string; session: string }
  target: { id: string; label: string }
  back(): void
}) {
  const sdk = useSDK()
  const { theme } = useTheme()
  const [rows, setRows] = createSignal<readonly EmbeddingJob[]>([])
  const [selected, setSelected] = createSignal<string>()
  const [loading, setLoading] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal("")
  const [message, setMessage] = createSignal("")
  const [observed, setObserved] = createSignal<number>()
  const current = () => rows().find((row) => row.id === selected())
  let observation: AbortController | undefined
  let mutation: AbortController | undefined
  let scroll: ScrollBoxRenderable | undefined
  let disposed = false

  async function load() {
    observation?.abort()
    const pending = new AbortController()
    observation = pending
    const scope = { ...props.scope, id: props.target.id }
    setLoading(true)
    setError("")
    try {
      const response = await wait(
        () =>
          sdk.client.forge.embeddingJobs(scope, {
            signal: pending.signal,
            throwOnError: true,
          }),
        pending.signal,
      )
      if (disposed || observation !== pending || pending.signal.aborted) return
      const values = decode(EmbeddingJobs, response.data)
      if (values.length > 16 || values.some((row) => row.collection !== scope.id || row.session !== scope.session)) {
        throw new Error("Embedding job history does not match the active collection and session")
      }
      if (
        new Set(values.map((row) => row.id)).size !== values.length ||
        values.some((row) =>
          [row.started, row.updated, row.progressed, ...(row.finished == null ? [] : [row.finished])].some(
            (time) => !Number.isFinite(new Date(time).getTime()),
          ),
        )
      ) {
        throw new Error("Embedding job history contains invalid identifiers or timestamps")
      }
      setRows(values)
      if (!values.some((row) => row.id === selected())) {
        setSelected(values.at(0)?.id)
        scroll?.scrollTo(0)
      }
      setObserved(Date.now())
    } catch (err) {
      if (disposed || observation !== pending || pending.signal.aborted) return
      setRows([])
      setSelected(undefined)
      setObserved(undefined)
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (!disposed && observation === pending) setLoading(false)
    }
  }
  async function cancel() {
    const value = current()
    if (disposed || busy() || !value || !["queued", "running"].includes(value.state)) return
    const pending = new AbortController()
    mutation = pending
    setBusy(true)
    setMessage("")
    setError("")
    try {
      const response = await wait(
        () =>
          sdk.client.forge.embeddingCancel(
            {
              ...props.scope,
              id: props.target.id,
              job: value.id,
            },
            { signal: pending.signal, throwOnError: true },
          ),
        pending.signal,
      )
      if (disposed || mutation !== pending || pending.signal.aborted) return
      const data: unknown = response.data
      if (!data || typeof data !== "object" || !("requested" in data) || data.requested !== true) {
        throw new Error("Embedding job cancellation was not acknowledged")
      }
      setMessage("Cancellation requested. An admitted publication may have completed.")
      await load()
    } catch (err) {
      if (disposed || mutation !== pending || pending.signal.aborted) return
      await load()
      if (!disposed && mutation === pending && !pending.signal.aborted)
        setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (!disposed && mutation === pending) {
        mutation = undefined
        setBusy(false)
      }
    }
  }
  createEffect(() => {
    props.scope.directory
    props.scope.workspace
    props.scope.session
    props.target.id
    untrack(() => {
      mutation?.abort()
      mutation = undefined
      setBusy(false)
      setRows([])
      setSelected(undefined)
      setObserved(undefined)
      setMessage("")
      void load()
    })
  })
  onMount(() => {
    const off = sdk.event.on("event", (event) => {
      if (notice(event, props.scope, true)) void load()
    })
    onCleanup(off)
  })
  onCleanup(() => {
    disposed = true
    observation?.abort()
    mutation?.abort()
  })
  function move(direction: number) {
    const index = rows().findIndex((row) => row.id === selected())
    const value = index + direction >= 0 ? rows().at(index + direction) : undefined
    if (!value) return
    setSelected(value.id)
    scroll?.scrollTo(0)
  }
  scrolling(() => scroll)
  navigation(() => props.back())
  useKeyboard((event) => {
    if (event.ctrl || event.meta || event.option) return
    if (!["q", "r", "c", "o", "u"].includes(event.name)) return
    event.preventDefault()
    event.stopPropagation()
    if (event.name === "q") {
      props.back()
      return
    }
    if (event.name === "r") void load()
    if (event.name === "c") void cancel()
    if (event.name === "o") move(1)
    if (event.name === "u") move(-1)
  })
  return (
    <box padding={1} gap={1}>
      <text fg={theme.primary}>Embedding job history: {props.target.label}</text>
      <text>Latest 16 jobs in this session. Closing does not cancel admitted jobs.</text>
      <Show when={loading()}>
        <text>Refreshing embedding jobs...</text>
      </Show>
      <Show when={busy()}>
        <text>Requesting job cancellation...</text>
      </Show>
      <Show when={error()}>
        <text fg={theme.error}>{error()}</text>
      </Show>
      <Show when={message()}>
        <text>{message()}</text>
      </Show>
      <Show when={observed()}>
        <text>Last observation: {new Date(observed()!).toISOString()}. Refresh if updates stop.</text>
      </Show>
      <scrollbox
        ref={(value: ScrollBoxRenderable) => {
          scroll = value
        }}
        height={15}
      >
        <Show when={!loading() && !error() && !rows().length}>
          <text>No retained embedding jobs in this session.</text>
        </Show>
        <Show when={current()}>
          {(job) => (
            <box>
              <text>
                Job {rows().findIndex((row) => row.id === job().id) + 1} of {rows().length}: {job().id}
              </text>
              <text>
                State: {job().state}. Phase: {job().progress.phase}
              </text>
              <Show when={job().state === "completed" && job().result}>
                {(result) => (
                  <text>
                    Index published: {result().sections} sections, {result().embedded} newly embedded, {result().reused}{" "}
                    reused.
                  </text>
                )}
              </Show>
              <text>
                Processed {job().progress.processed} of {job().progress.sections ?? "unknown"} sections;{" "}
                {job().progress.embedded} newly embedded, {job().progress.reused} reused.
              </text>
              <text>Counts describe this operation, not a guarantee of current coverage or provider billing.</text>
              <text>
                Started: {new Date(job().started).toISOString()}
                {"\n"}Last checkpoint: {new Date(job().updated).toISOString()}
                {"\n"}Last material progress: {new Date(job().progressed).toISOString()}
              </text>
              <Show when={job().finished != null}>
                <text>Finished: {new Date(job().finished!).toISOString()}</text>
              </Show>
              <text>
                Model: {job().target.model}. Dimensions: {job().target.dimensions}
                {"\n"}Routing fingerprint: {job().target.fingerprint}
              </text>
              <Show when={job().error}>
                <text>{job().error}</text>
              </Show>
              <text>{summary(job().usage)}</text>
              <text>
                Heartbeats do not prove material progress. A stalled call may wait for its deadline. Cancellation cannot
                retract bytes or undo an admitted publication.
              </text>
            </box>
          )}
        </Show>
      </scrollbox>
      <Show when={current() && ["queued", "running"].includes(current()!.state)}>
        <text onMouseUp={() => void cancel()}>[c] Cancel selected embedding job</text>
      </Show>
      <text onMouseUp={() => move(1)}>[o] Older job</text>
      <text onMouseUp={() => move(-1)}>[u] Newer job</text>
      <text onMouseUp={() => void load()}>[r] Refresh jobs; Up/Down or Page Up/Page Down to scroll</text>
      <text onMouseUp={() => props.back()}>[q] Back to embeddings · Esc / Backspace; leave jobs running</text>
    </box>
  )
}
