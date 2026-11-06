import { createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { useBindings } from "../../keymap"
import { useSDK } from "../../context/sdk"
import { useTheme } from "../../context/theme"
import { useDialog } from "../../ui/dialog"
import { ForgePreview } from "./preview"
import type { PromptInfo } from "../../prompt/history"
import { attachments } from "./attachment"
import { navigation } from "./back"

export function ForgeAttachments(props: {
  parts: PromptInfo["parts"]
  scope: { directory?: string; workspace?: string; session?: string }
  valid: () => boolean
  proceed: () => void
  library: () => void
  back?: () => void
}) {
  const sdk = useSDK()
  const dialog = useDialog()
  const { theme } = useTheme()
  const items = attachments(props.parts)
  const [cursor, setCursor] = createSignal(0)
  const [confirming, setConfirming] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal("")
  const [message, setMessage] = createSignal("")
  const current = createMemo(() => items.at(cursor()))
  const controller = new AbortController()
  onCleanup(() => controller.abort())

  function close() { setConfirming(false); dialog.setSize("large") }
  async function enroll(value: string) {
    const item = current()?.registration
    if (busy() || !item) return
    if (value !== "ADD") { setError("Type ADD to register this document in workspace knowledge."); return }
    if (!props.valid()) { setError("The draft or workspace changed. Close and reopen Forge before enrolling attachments."); return }
    setBusy(true)
    setError("")
    try {
      const result = await sdk.client.forge.register({ ...props.scope, ...item, session: "" }, { signal: controller.signal, throwOnError: true })
      if (controller.signal.aborted) return
      setMessage(`Registered ${result.data.label}. Open the library to review local indexing and provider sharing. Existing registrations keep their current approval.`)
      close()
    } catch (err) { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err)) } finally { setBusy(false) }
  }
  function proceed() {
    if (!props.valid()) { setError("The draft or workspace changed. Close and reopen Forge."); return }
    props.proceed()
  }
  navigation(() => (props.back ?? (() => dialog.clear()))(), () => !confirming())
  useBindings(() => ({
    enabled: !confirming() && !busy(),
    priority: 1,
    bindings: [
      { key: "t", desc: "Use attachments for this task", group: "Forge", cmd: proceed },
      { key: "w", desc: "Enroll selected document", group: "Forge", cmd: () => { if (current()?.registration) setConfirming(true) } },
      { key: "k", desc: "Manage knowledge approvals", group: "Forge", cmd: props.library },
      { key: "r", desc: "Close attachment choices", group: "Forge", cmd: () => dialog.clear() },
      { key: "n", desc: "Next attachment", group: "Forge", cmd: () => setCursor((value) => Math.min(items.length - 1, value + 1)) },
      { key: "b", desc: "Previous attachment", group: "Forge", cmd: () => setCursor((value) => Math.max(0, value - 1)) },
    ],
  }))

  // A concrete root preserves this dialog's state when its conditional pane changes.
  return <box><Show when={!confirming()} fallback={<ForgePreview
    input={current()!.registration!}
    scope={props.scope}
    busy={busy()}
    error={error()}
    confirm={(value) => void enroll(value)}
    cancel={close}
  />}>
    <box padding={1} gap={1}>
      <text fg={theme.primary}>Forge · attachment scope</text>
      <text>Choose task-only attachments or explicitly enroll a document in workspace knowledge.</text>
      <text fg={theme.textMuted}>Task-only files remain attached to the eventual coding message. Their bytes are not sent to Forge's preparation model or indexed by this choice. Existing repository indexing and prior registrations are unchanged.</text>
      <Show when={error()}><text fg={theme.error}>{error()}</text></Show>
      <Show when={message()}><text fg={theme.primary}>{message()}</text></Show>
      <scrollbox height={10}>
        <For each={items}>{(item, index) => <text fg={cursor() === index() ? theme.primary : theme.text} onMouseUp={() => setCursor(index())}>{cursor() === index() ? "> " : "  "}{item.label} · {item.registration ? "Can enroll as a document" : "Task only"}</text>}</For>
        <Show when={!items.length}><text>No file attachments in this draft.</text></Show>
      </scrollbox>
      <Show when={current()}>{(item) => <text>{item().registration?.location ?? item().reason}</text>}</Show>
      <text fg={theme.primary} onMouseUp={proceed}>[t] Use for this task / continue without new enrollment</text>
      <Show when={current()?.registration}><text onMouseUp={() => setConfirming(true)}>[w] Add selected document to workspace knowledge</text></Show>
      <text onMouseUp={props.library}>[k] Manage library approvals</text>
      <text fg={theme.textMuted}>[n]/[b] Next/previous attachment · [r] Reject / close · Esc / Backspace Back</text>
    </box>
  </Show></box>
}
