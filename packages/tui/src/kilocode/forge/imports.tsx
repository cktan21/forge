import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import type { ScrollBoxRenderable } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { useSDK } from "../../context/sdk"
import { useTheme } from "../../context/theme"
import type { ImportHistory } from "@kilocode/forge/schema"
import { history } from "@kilocode/forge/imports"
import { notice, updates } from "@kilocode/forge/updates"
import { navigation } from "./back"

export function ForgeImports(props: { scope: { directory?: string; workspace?: string; session: string }; target: { id: string; label: string }; back: () => void }) {
  const sdk = useSDK()
  const { theme } = useTheme()
  const [value, setValue] = createSignal<ImportHistory>()
  const [run, setRun] = createSignal<string>()
  const [offset, setOffset] = createSignal(0)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal("")
  const controller = new AbortController()
  let scroll: ScrollBoxRenderable | undefined
  let sequence = 0
  async function load() {
    const attempt = ++sequence
    const opts = { ...props.scope, id: props.target.id, run: run(), offset: String(offset()), limit: "10" }
    setBusy(true)
    setError("")
    setValue(undefined)
    try {
      const result = await sdk.client.forge.imports(opts, { signal: controller.signal, throwOnError: true })
      if (attempt === sequence && !controller.signal.aborted) { setValue(result.data); scroll?.scrollTo(0) }
    } catch (err) { if (attempt === sequence && !controller.signal.aborted) setError(String(err)) }
    finally { if (attempt === sequence) setBusy(false) }
  }
  const refresh = updates({ signal: controller.signal, load, error: (err) => setError(String(err)) })
  createEffect(() => { run(); offset(); refresh() })
  onMount(() => { const off = sdk.event.on("event", (event) => { if (notice(event, props.scope, true)) refresh() }); onCleanup(off) })
  onCleanup(() => controller.abort())
  navigation(props.back)
  useKeyboard((event) => {
    if (!["q", "r", "n", "b", "o", "u", "down", "up", "pagedown", "pageup"].includes(event.name)) return
    event.preventDefault()
    event.stopPropagation()
    if (event.name === "q") { props.back(); return }
    if (event.name === "down" || event.name === "pagedown") scroll?.scrollBy(event.name === "down" ? 1 : 16)
    if (event.name === "up" || event.name === "pageup") scroll?.scrollBy(event.name === "up" ? -1 : -16)
    if (busy()) return
    if (event.name === "r") refresh()
    const data = value()
    if (!data) return
    if (event.name === "n" && data.page.next != null) setOffset(data.page.next)
    if (event.name === "b") setOffset(Math.max(0, data.page.offset - data.page.limit))
    const index = data.runs.findIndex((item) => item.id === data.selected?.id)
    const target = event.name === "o" ? data.runs.at(index + 1) : event.name === "u" && index > 0 ? data.runs.at(index - 1) : undefined
    if (target) { setRun(target.id); setOffset(0) }
  })
  return <box padding={1} gap={1}>
    <text fg={theme.primary}>Import history · {props.target.label}</text>
    <Show when={error()}><text fg={theme.error}>{error()}</text></Show>
    <Show when={busy()}><text>Loading import history...</text></Show>
    <scrollbox ref={(value: ScrollBoxRenderable) => { scroll = value }} height={20}>
      <Show when={value()}>{(value) => <For each={history(value())}>{(line) => <text>{line}</text>}</For>}</Show>
    </scrollbox>
    <text>[n]/[b] Next/previous file page · [o]/[u] Older/newer run</text>
    <text onMouseUp={props.back}>[r] Reload · Up/Down or Page Up/Page Down to scroll · [q] Back to library · Esc / Backspace</text>
  </box>
}
