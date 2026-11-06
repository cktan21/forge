import { createSignal, For, onCleanup, onMount, Show } from "solid-js"
import type { Preview, Registration } from "@kilocode/forge/schema"
import { useSDK } from "../../context/sdk"
import { useTheme } from "../../context/theme"
import { DialogPrompt } from "../../ui/dialog-prompt"
import { navigation } from "./back"

export function ForgePreview(props: {
  input: Registration
  scope: { directory?: string; workspace?: string }
  busy?: boolean
  parse?: boolean
  error?: string
  confirm: (value: string) => void
  cancel: () => void
}) {
  const sdk = useSDK()
  const { theme } = useTheme()
  const [preview, setPreview] = createSignal<Preview>()
  const [error, setError] = createSignal("")
  const controller = new AbortController()
  navigation(props.cancel)
  onCleanup(() => controller.abort())
  onMount(() => {
    const input = props.input
    void sdk.client.forge.preview({ ...props.scope, ...input, include: input.include ? [...input.include] : undefined, exclude: input.exclude ? [...input.exclude] : undefined }, { signal: controller.signal, throwOnError: true })
      .then((result) => { if (!controller.signal.aborted) setPreview(result.data) })
      .catch((err) => { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err)) })
  })
  return <box><DialogPrompt
    title={preview() ? props.parse ? "Review reference. Type ADD to parse locally" : "Review ingestion preview. Type ADD to register" : error() ? "Preview unavailable. Esc closes without registration" : "Reading bounded preview (no registration or model call)"}
    busy={!preview() || props.busy}
    description={() => <box>
      <text>{props.input.label} · {props.input.session ? "Session" : "Workspace"} knowledge</text>
      <text fg={theme.textMuted} onMouseUp={props.cancel}>[Esc] Back without adding</text>
      <Show when={error() || props.error}><text fg={theme.error}>{error() || props.error}</text></Show>
      <Show when={preview()}>{(value) => <scrollbox height={12}>
        <text>{value().location || "Pasted text"}{"\n"}{value().partial ? "Partial inventory" : "Discovered inventory"}: {value().files} files · {value().bytes} bytes · {value().excluded} excluded entries</text>
        <For each={value().samples}>{(item) => <text>{"\n"}{item.name} · {item.bytes} bytes{"\n"}{item.text || "No excerpt available"}</text>}</For>
        <For each={value().warnings}>{(warning) => <text fg={theme.textMuted}>{warning}</text>}</For>
      </scrollbox>}</Show>
      <text>Bounded sample: up to 5 documents, 2 MiB each, 8 MiB total, 2000 visited entries, 30 seconds. File paths refer to the backend. URL previews explicitly fetch that URL.{"\n"}
        {props.parse ? "ADD approves local parsing of current content. Provider sharing and embedding approval remain separate. Files are indexed in place, not moved or copied." : "Preview is not a frozen snapshot or indexing/sharing approval. Full indexing reads current content."}
        {"\n"}Original files and draft attachments are unchanged.
      </text>
    </box>}
    onConfirm={props.confirm}
    onCancel={props.cancel}
  /></box>
}
