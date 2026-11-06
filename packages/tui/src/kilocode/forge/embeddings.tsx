import { createEffect, createSignal, onCleanup, onMount, Show, untrack } from "solid-js"
import type { ScrollBoxRenderable } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { decode, EmbeddingReview, EmbeddingJob, EmbeddingApproval, EmbeddingRevocation } from "@kilocode/forge/schema"
import { notice } from "@kilocode/forge/updates"
import { wait } from "@kilocode/forge/wait"
import { useSDK } from "../../context/sdk"
import { useTheme } from "../../context/theme"
import { useDialog } from "../../ui/dialog"
import { DialogPrompt } from "../../ui/dialog-prompt"
import { ForgeEmbeddingJobs } from "./embedding-jobs"
import { ForgeEmbeddingCoverage } from "./embedding-coverage"
import { ForgeEmbeddingUsage } from "./embedding-usage"
import { scrolling } from "./scroll"
import { navigation } from "./back"

export function ForgeEmbeddings(props: {
  scope: { directory?: string; workspace?: string; session: string }
  target: { id: string; label: string }
  back(): void
}) {
  const sdk = useSDK()
  const dialog = useDialog()
  const { theme } = useTheme()
  const [review, setReview] = createSignal<typeof EmbeddingReview.Type>()
  const [confirming, setConfirming] = createSignal(false)
  const [busy, setBusy] = createSignal("")
  const [message, setMessage] = createSignal("")
  const [error, setError] = createSignal("")
  const [page, setPage] = createSignal<"consent" | "jobs" | "coverage" | "usage">("consent")
  let controller: AbortController | undefined
  let scroll: ScrollBoxRenderable | undefined
  let disposed = false

  function clear() {
    setReview(undefined)
    if (confirming()) dialog.setSize("large")
    setConfirming(false)
  }
  function cancel(
    message = "Request cancelled. An admitted job may still be running; press j to inspect history before retrying.",
  ) {
    controller?.abort()
    controller = undefined
    setBusy("")
    clear()
    setMessage(message)
  }
  createEffect(() => {
    props.target.id
    props.scope.directory
    props.scope.workspace
    props.scope.session
    untrack(() => {
      cancel("")
      setError("")
      setPage("consent")
    })
  })
  onMount(() => {
    const off = sdk.event.on("event", (event) => {
      if (!notice(event, props.scope, true)) return
      // Mutations emit their own events. Invalidate observations, not those writes.
      if (busy() === "review" || review()) cancel("Knowledge changed. Review the embedding destination again.")
      clear()
    })
    onCleanup(off)
  })
  onCleanup(() => {
    disposed = true
    controller?.abort()
  })

  async function run(action: "review" | "approve" | "revoke" | "index") {
    if (busy() || disposed) return
    const previous = review()
    if (action === "approve" && (!previous || previous.approved || !confirming())) return
    if (action === "index" && !previous?.approved) return
    const pending = new AbortController()
    controller = pending
    const scope = { ...props.scope, id: props.target.id }
    const options = { signal: pending.signal, throwOnError: true as const }
    setBusy(action)
    setMessage("")
    setError("")
    clear()
    try {
      const result = await wait<{ data: unknown }>(() => {
        if (action === "review") return sdk.client.forge.embeddingReview(scope, options)
        if (action === "approve")
          return sdk.client.forge.embeddingApprove({ ...scope, revision: previous!.revision }, options)
        if (action === "revoke") return sdk.client.forge.embeddingRevoke(scope, options)
        return sdk.client.forge.embeddingStart(scope, options)
      }, pending.signal)
      if (disposed || controller !== pending || pending.signal.aborted) return
      if (action === "review") setReview(decode(EmbeddingReview, result.data))
      if (action === "approve") {
        decode(EmbeddingApproval, result.data)
        setMessage("Embedding destination approved. No indexing was started. Review again before explicit indexing.")
      }
      if (action === "revoke") {
        decode(EmbeddingRevocation, result.data)
        setMessage("Embedding consent revoked. Sent text cannot be retracted; cached vectors are not deleted.")
      }
      if (action === "index") {
        const value = decode(EmbeddingJob, result.data)
        if (value.collection !== scope.id || value.session !== scope.session)
          throw new Error("Embedding job does not match this scope")
        setMessage(
          `Embedding job admitted: ${value.id}. Press j to inspect progress. Closing leaves admitted jobs running.`,
        )
      }
    } catch (err) {
      if (disposed || controller !== pending) return
      clear()
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (!disposed && controller === pending) {
        controller = undefined
        setBusy("")
      }
    }
  }
  function approve() {
    if (!busy() && review() && !review()?.approved) setConfirming(true)
  }
  function back() {
    cancel("")
    props.back()
  }
  function jobs() {
    cancel("")
    setPage("jobs")
  }
  function coverage() {
    cancel("")
    setPage("coverage")
  }
  function usage() {
    cancel("")
    setPage("usage")
  }
  navigation(() => {
    if (confirming()) { setConfirming(false); dialog.setSize("large"); return }
    back()
  }, () => page() === "consent")
  scrolling(
    () => scroll,
    () => page() === "consent",
    () => !confirming(),
  )
  useKeyboard((event) => {
    if (page() !== "consent") return
    if (event.ctrl || event.meta || event.option) return
    if (confirming()) return
    if (!["q", "c", "r", "a", "i", "v", "j", "s", "u"].includes(event.name)) return
    event.preventDefault()
    event.stopPropagation()
    if (event.name === "q") {
      back()
      return
    }
    if (event.name === "c" && busy()) {
      cancel()
      return
    }
    if (event.name === "a") approve()
    if (event.name === "r") void run("review")
    if (event.name === "i") void run("index")
    if (event.name === "v") void run("revoke")
    if (event.name === "j") jobs()
    if (event.name === "s") coverage()
    if (event.name === "u") usage()
  })
  return (
    <box><Show
      when={page() === "consent"}
      fallback={
        <Show
          when={page() === "jobs"}
          fallback={
            <Show
              when={page() === "coverage"}
              fallback={
                <ForgeEmbeddingUsage scope={props.scope} target={props.target} back={() => setPage("consent")} />
              }
            >
              <ForgeEmbeddingCoverage scope={props.scope} target={props.target} back={() => setPage("consent")} />
            </Show>
          }
        >
          <ForgeEmbeddingJobs scope={props.scope} target={props.target} back={() => setPage("consent")} />
        </Show>
      }
    >
      <Show
        when={!confirming()}
        fallback={
          <DialogPrompt
            title="Approve collection embeddings? Type ALLOW"
            description={() => (
              <box>
                <scrollbox
                  ref={(value: ScrollBoxRenderable) => {
                    scroll = value
                  }}
                  height={10}
                >
                  <text>
                    {props.target.label}
                    {"\n"}Exact endpoint: {review()?.endpoint}
                    {"\n"}Model: {review()?.target.model}
                    {"\n"}Dimensions: {review()?.target.dimensions}
                    {"\n"}Routing fingerprint: {review()?.target.fingerprint}
                  </text>
                  <text>
                    Allow original sections and semantic queries to this destination. Coding-provider sharing is
                    separate. Approval does not start indexing.
                  </text>
                </scrollbox>
                <text>Page Up/Page Down to inspect destination; Esc returns without approval.</text>
                <Show when={error()}>
                  <text fg={theme.error}>{error()}</text>
                </Show>
              </box>
            )}
            onConfirm={(value) => {
              if (value !== "ALLOW") {
                setError("Type ALLOW to approve the reviewed embedding destination.")
                return
              }
              void run("approve")
            }}
            onCancel={() => { setConfirming(false); dialog.setSize("large") }}
          />
        }
      >
        <box padding={1} gap={1}>
          <text fg={theme.primary}>Collection embeddings: {props.target.label}</text>
          <scrollbox
            ref={(value: ScrollBoxRenderable) => {
              scroll = value
            }}
            height={16}
          >
            <text>
              Opening and reviewing send no embedding text. Local extraction, coding-provider sharing and embedding
              approval are separate.
            </text>
            <text>
              Backend configuration: KILO_FORGE_EMBEDDING_ENDPOINT, KILO_FORGE_EMBEDDING_MODEL,
              KILO_FORGE_EMBEDDING_DIMENSIONS. Credentials belong in KILO_FORGE_EMBEDDING_KEY, never in a document.
            </text>
            <Show when={review()}>
              {(value) => (
                <text>
                  {"\n"}Exact endpoint: {value().endpoint}
                  {"\n"}Model: {value().target.model}
                  {"\n"}Dimensions: {value().target.dimensions}
                  {"\n"}Routing fingerprint: {value().target.fingerprint}
                  {"\n"}Observed approval:{" "}
                  {value().approved ? "Approved for this destination" : "Not approved for this destination"}
                </text>
              )}
            </Show>
            <Show when={busy()}>
              <text>
                {busy() === "index"
                  ? "Starting embedding job; waiting for admission."
                  : `Waiting for embedding ${busy()}...`}
              </text>
            </Show>
            <Show when={message()}>
              <text>{message()}</text>
            </Show>
            <Show when={error()}>
              <text fg={theme.error}>{error()}</text>
            </Show>
            <text>
              {"\n"}Review is not a readiness guarantee. Live permissions and freshness are enforced. Cancellation
              cannot retract bytes or roll back an admitted write.
            </text>
          </scrollbox>
          <text onMouseUp={() => void run("review")}>[r] Review embedding destination</text>
          <Show when={review() && !review()?.approved && !busy()}>
            <text onMouseUp={approve}>[a] Approve embedding destination</text>
          </Show>
          <Show when={review()?.approved && !busy()}>
            <text onMouseUp={() => void run("index")}>[i] Index embeddings</text>
          </Show>
          <text onMouseUp={() => void run("revoke")}>[v] Revoke embedding consent (no review required)</text>
          <text onMouseUp={jobs}>[j] Embedding job history and explicit cancellation</text>
          <text onMouseUp={coverage}>[s] Inspect stored-section embedding coverage</text>
          <text onMouseUp={usage}>[u] Inspect recorded embedding usage across this session</text>
          <Show when={busy()}>
            <text onMouseUp={() => cancel()}>[c] Cancel embedding request</text>
          </Show>
          <text onMouseUp={back}>Page Up/Page Down to scroll; [q] Back to library · Esc / Backspace; leave admitted jobs running</text>
        </box>
      </Show>
    </Show></box>
  )
}
