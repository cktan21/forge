import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { useKeyboard } from "@opentui/solid"
import type { KiloClient } from "@kilocode/sdk/v2"
import { useSDK } from "../../context/sdk"
import { useTheme } from "../../context/theme"
import { useDialog } from "../../ui/dialog"
import { DialogPrompt } from "../../ui/dialog-prompt"
import { notice, updates } from "@kilocode/forge/updates"
import type { PromptInfo } from "../../prompt/history"
import { ForgeAttachments } from "./attachments"
import { ForgePreview } from "./preview"
import type { Registration } from "@kilocode/forge/schema"
import { activity, outcome } from "@kilocode/forge/imports"
import { ForgeImports } from "./imports"
import { ForgeEmbeddings } from "./embeddings"
import { references } from "@kilocode/forge/references"
import { navigation } from "./back"

type Registry = NonNullable<Awaited<ReturnType<KiloClient["forge"]["knowledge"]>>["data"]>
type Collection = Registry["collections"][number]
type Stage = "folder" | "file" | "url" | "text" | "share" | "remove" | "purge" | "search"

export function ForgeLibrary(props: { scope: { directory?: string; workspace?: string; session: string }; root?: string; references?: string; initial?: "file" | "folder" | "text"; back: () => void; draft?: PromptInfo; valid?: () => boolean }) {
  const sdk = useSDK()
  const dialog = useDialog()
  const { theme } = useTheme()
  const [registry, setRegistry] = createSignal<Registry>({ collections: [], provider: "", generation: "", page: { offset: 0, limit: 10, total: 0 } })
  const [search, setSearch] = createSignal("")
  const [paging, setPaging] = createSignal(false)
  const [cursor, setCursor] = createSignal(0)
  const [stage, show] = createSignal<Stage>()
  const [target, setTarget] = createSignal<Collection>()
  const [destination, setDestination] = createSignal("")
  const [routing, setRouting] = createSignal<Registry["destination"]>()
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal("")
  const [privateScope, setPrivateScope] = createSignal(false)
  const [enrolling, setEnrolling] = createSignal(false)
  const [pending, setPending] = createSignal<Registration>()
  const [inspecting, setInspecting] = createSignal<Collection>()
  const [embedding, setEmbedding] = createSignal<Collection>()
  const current = createMemo(() => registry().collections.at(cursor()))
  const directory = () => props.references ?? registry().references ?? references(props.root)
  const controller = new AbortController()
  const options = { throwOnError: true as const, signal: controller.signal }
  let sequence = 0
  let position = 0
  let filter = ""
  const refresh = updates({ signal: controller.signal, load, error: (err) => setError(String(err)) })

  function setStage(value?: Stage) { setTarget(current()); setDestination(registry().provider); setRouting(registry().destination); show(value) }
  async function load(offset = position, text = filter, tail = false) {
    position = offset
    filter = text
    const attempt = ++sequence
    const selected = current()?.id
    setPaging(true)
    try {
      const result = (await sdk.client.forge.knowledge({ ...props.scope, limit: "10", offset: String(offset), query: text, generation: text === search() ? registry().generation : undefined }, options)).data
      if (attempt !== sequence || controller.signal.aborted) return
      const index = result.collections.findIndex((item) => item.id === selected)
      position = result.page?.offset ?? 0
      setRegistry(result)
      setSearch(text)
      setCursor(index >= 0 ? index : tail ? Math.max(0, result.collections.length - 1) : 0)
    } catch (err) { if (!controller.signal.aborted) setError(String(err)) } finally { if (attempt === sequence) setPaging(false) }
  }
  async function action(fn: () => Promise<unknown>) {
    if (busy()) return
    setBusy(true)
    setError("")
    try { await fn() } catch (err) { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err)) } finally { setBusy(false); refresh() }
  }
  async function control(item: Collection, action: "approve" | "index" | "pause" | "remove" | "purge", providers?: string[], grants?: Record<string, string>) {
    return sdk.client.forge.collection({ ...props.scope, id: item.id, session: item.session, action, providers, grants, confirmation: action === "purge" ? "PURGE" : undefined }, options)
  }
  async function approve(item: Collection, providers: string[], grants: Record<string, string> = {}) {
    await control(item, "approve", providers, grants)
    await control(item, "index")
  }
  function close() { setStage(undefined); dialog.setSize("large") }
  async function submit(value: string) {
    const kind = stage()
    const item = target()
    const provider = destination()
    const fingerprint = routing()?.fingerprint
    close()
    await action(async () => {
      if (kind === "search") { await load(0, value.trim()); return }
      if (kind === "share") {
        if (!item || !fingerprint || value !== "ALLOW") throw new Error("Type ALLOW to approve this provider's current routing")
        await approve(item, [provider], { [provider]: fingerprint })
        return
      }
      if (kind === "remove" || kind === "purge") {
        if (!item || value !== kind.toUpperCase()) throw new Error(`Type ${kind.toUpperCase()} to confirm`)
        await control(item, kind)
        return
      }
      if (!kind) return
      setPending({
        kind, location: kind === "text" ? "" : value.trim(),
        label: kind === "text" ? "Pasted reference" : (value.trim().split(/[\\/]/).at(-1) || "Document").slice(0, 200),
        content: kind === "text" ? value : undefined, session: privateScope() ? props.scope.session : "", watch: kind === "folder",
      })
    })
  }

  onMount(() => {
    const off = sdk.event.on("event", (event) => { if (notice(event, props.scope, true)) refresh() })
    onCleanup(off)
    refresh()
    if (props.initial) setStage(props.initial)
  })
  onCleanup(() => { controller.abort() })
  function back() {
    if (pending()) { setPending(undefined); dialog.setSize("large"); return }
    if (stage()) { close(); return }
    props.back()
  }
  navigation(back, () => !pending() && !inspecting() && !embedding() && !enrolling())
  useKeyboard((event) => {
    if (event.ctrl || event.meta || event.option || event.super) return
    if (stage() || (busy() && event.name !== "x") || (paging() && event.name !== "e") || enrolling() || pending() || inspecting() || embedding()) return
    if (!["f", "d", "u", "t", "s", "n", "b", "up", "down", "tab", "a", "p", "i", "j", "e", "x", "r", "z", "q", "h", "/"].includes(event.name)) return
    event.preventDefault()
    event.stopPropagation()
    const item = current()
    if (event.name === "q") props.back()
    if (event.name === "f") setStage("folder")
    if (event.name === "d") setStage("file")
    if (event.name === "u") setStage("url")
    if (event.name === "t") setStage("text")
    if (event.name === "/") setStage("search")
    if (event.name === "s" && props.scope.session) setPrivateScope((value) => !value)
    if (event.name === "h" && props.draft?.parts.some((part) => part.type === "file")) setEnrolling(true)
    if (event.name === "n" || event.name === "down" || (event.name === "tab" && !event.shift)) {
      if (cursor() === registry().collections.length - 1 && registry().page?.next != null) { void load(registry().page.next); return }
      setCursor((value) => Math.max(0, Math.min(registry().collections.length - 1, value + 1)))
      return
    }
    if (event.name === "b" || event.name === "up" || (event.name === "tab" && event.shift)) {
      if (cursor() === 0 && registry().page?.offset) { void load(Math.max(0, registry().page.offset - registry().page.limit), search(), true); return }
      setCursor((value) => Math.max(0, value - 1))
      return
    }
    if (!item) return
    if (event.name === "j") setInspecting(item)
    if (event.name === "e") setEmbedding(item)
    if (event.name === "a") void action(() => approve(item, []))
    if (event.name === "p" && registry().provider && registry().destination) setStage("share")
    if (event.name === "i") void action(() => control(item, "index"))
    if (event.name === "x") {
      if (busy()) { void control(item, "pause").catch((err) => setError(String(err))); return }
      void action(() => control(item, "pause"))
    }
    if (event.name === "r") setStage("remove")
    if (event.name === "z") setStage("purge")
  })

  return <box><Show when={!embedding()} fallback={<ForgeEmbeddings scope={props.scope} target={embedding()!} back={() => setEmbedding(undefined)} />}><Show when={!inspecting()} fallback={<ForgeImports scope={props.scope} target={inspecting()!} back={() => setInspecting(undefined)} />}><box><Show when={!pending()} fallback={<ForgePreview input={pending()!} scope={props.scope} parse busy={busy()} error={error()} cancel={() => { setPending(undefined); dialog.setSize("large") }} confirm={(value) => {
    if (value !== "ADD") { setError("Type ADD to register the previewed document."); return }
    const input = pending()
    if (!input) return
    void action(async () => {
      const item = (await sdk.client.forge.register({ ...props.scope, ...input, include: input.include ? [...input.include] : undefined, exclude: input.exclude ? [...input.exclude] : undefined }, options)).data
      controller.signal.throwIfAborted()
      setPending(undefined)
      dialog.setSize("large")
      await load(0, input.label)
      if (!item.approved) await control(item, "approve", [])
      controller.signal.throwIfAborted()
      await control(item, "index")
    })
  }} />}><Show when={!enrolling()} fallback={<ForgeAttachments parts={props.draft?.parts ?? []} scope={props.scope} valid={() => props.valid?.() ?? false} back={() => setEnrolling(false)} proceed={() => setEnrolling(false)} library={() => { setEnrolling(false); refresh() }} />}><Show when={!stage()} fallback={<DialogPrompt
    title={stage() === "search" ? "Find collections by label or path; submit empty text for all" : stage() === "share" ? `Allow selected passages to be sent to ${destination()}? Type ALLOW` : stage() === "purge" ? "Purge collection AND workspace captures/caches? Type PURGE" : stage() === "remove" ? "Remove from future retrieval? Type REMOVE" : `Add ${stage()} to ${privateScope() ? "this session" : "workspace"} knowledge`}
    value={stage() === "folder" ? directory() : stage() === "file" ? `${directory()}/` : undefined}
    description={() => <text>{target()?.label} {target()?.location}{"\n"}Paths refer to the backend machine. Extraction is local; coding-provider sharing and embedding indexing require separate approvals.{"\n"}<Show when={stage() === "share"}>Allowed origins: {routing()?.origins.join(", ") || "None: configure an explicit endpoint"}{"\n"}Routing fingerprint: {routing()?.fingerprint}{"\n"}Standard transport only; redirects and custom fetchers are blocked.{"\n"}</Show>Original files and existing chat transcripts are not changed.</text>}
    onConfirm={(value) => void submit(value)}
    onCancel={close}
  />}>
    <box padding={1} gap={1}>
      <text fg={theme.primary}>Forge knowledge library</text>
      <text>New registrations: {privateScope() ? "this session" : "workspace"} scope. ADD also approves local parsing; coding-provider and embedding approvals are separate.</text>
      <text fg={theme.textMuted}>Default document directory: {directory()} · folders watch for changes after local approval.</text>
      <Show when={error()}><text fg={theme.error}>{error()}</text></Show>
      <Show when={registry().warning}><text fg={theme.error}>{registry().warning}</text></Show>
      <Show when={registry().page}>{(page) => <text fg={theme.textMuted}>Page {Math.floor(page().offset / page().limit) + 1} · {page().total ?? registry().collections.length} matches{search() ? ` for "${search()}"` : ""} · [/] Search</text>}</Show>
      <scrollbox height={20}>
        <For each={registry().collections}>{(item, index) => <text fg={index() === cursor() ? theme.primary : theme.text} onMouseUp={() => setCursor(index())}>{index() === cursor() ? "> " : "  "}{item.label} · {item.state} · {item.chunks} records</text>}</For>
        <Show when={!registry().collections.length}><text>{search() ? "No matching registrations." : "No registered knowledge yet."}</text></Show>
      <Show when={current()}>{(item) => <>
        <text>{item().location || "Pasted text"}{"\n"}{item().session ? "Session" : "Workspace"} · Sharing: {item().providers.join(", ") || "local only"}</text>
        <Show when={item().progress}>{(progress) => <text>{progress().stage}: {progress().document || "collection"} · {progress().files} files · {progress().bytes} bytes · {progress().chunks} records{"\n"}Updated {new Date(progress().updated).toLocaleTimeString()} · {activity(progress())}</text>}</Show>
        <Show when={item().result}>{(result) => <text>{outcome(result())}</text>}</Show>
        <text onMouseUp={() => setInspecting(item())}>[j] Inspect import history</text>
        <text onMouseUp={() => { if (!busy()) setEmbedding(item()) }}>[e] Manage embeddings</text>
        <Show when={item().providers.includes(registry().provider) && item().grants?.[registry().provider] !== registry().destination?.fingerprint}><text fg={theme.error}>Routing changed or legacy grant. Approve the current destination before model use.</text></Show>
        <For each={item().warnings}>{(warning) => <text fg={theme.textMuted}>{warning}</text>}</For>
        <text>[a] Approve local indexing / revoke sharing · [p] Approve {registry().provider || "provider unavailable"}{"\n"}[i] Refresh · [x] Pause · [r] Remove · [z] Purge stored content</text>
      </>}</Show>
      </scrollbox>
      <text>[f] Folder · [d] File/PDF/DOCX · [u] URL · [t] Paste text · [s] Toggle scope</text>
      <Show when={props.draft?.parts.some((part) => part.type === "file")}><text onMouseUp={() => setEnrolling(true)}>[h] Enroll a current draft attachment</text></Show>
      <text fg={theme.textMuted} onMouseUp={back}>Arrows / Tab / [n]/[b] Select collection · [q] Back / Esc / Backspace {busy() || paging() ? "· Parsing/working... [x] Pause" : ""}</text>
    </box>
  </Show></Show></Show></box></Show></Show></box>
}
