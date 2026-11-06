import { batch, createEffect, createSignal, For, onCleanup, onMount, Show, useContext } from "solid-js"
import type { ScrollBoxRenderable } from "@opentui/core"
import { useBindings } from "../../keymap"
import type { KiloClient } from "@kilocode/sdk/v2"
import { useSDK } from "../../context/sdk"
import { useProject } from "../../context/project"
import { useRoute } from "../../context/route"
import { useTheme } from "../../context/theme"
import { useDialog } from "../../ui/dialog"
import { PromptRefContext } from "../../context/prompt"
import { ForgeLibrary } from "./library"
import { ForgeMap } from "./map"
import { ForgeModel } from "./provider"
import { labels, references } from "@kilocode/forge/references"
import { notice, updates } from "@kilocode/forge/updates"
import { unwrap } from "solid-js/store"
import { caveat } from "@kilocode/forge/lineage"
import { attempts, outcome } from "@kilocode/forge/attempts"
import { summary as decisions, channels } from "@kilocode/forge/selection"
import { semantic, coverage } from "@kilocode/forge/semantic"
import { progress } from "@kilocode/forge/retrieval"
import { navigation } from "./back"

type Status = NonNullable<Awaited<ReturnType<KiloClient["forge"]["status"]>>["data"]>
type Snapshot = NonNullable<Awaited<ReturnType<KiloClient["forge"]["view"]>>["data"]>
type Manifest = NonNullable<Awaited<ReturnType<KiloClient["forge"]["requests"]>>["data"]>[number]

export function ForgeKnowledge(props: { command: "overview" | "map"; back?: () => void }) {
  const sdk = useSDK()
  const project = useProject()
  const route = useRoute()
  const dialog = useDialog()
  const prompt = useContext(PromptRefContext)?.current
  const model = useContext(ForgeModel)
  const draft = prompt ? structuredClone(unwrap(prompt.current)) : undefined
  const { theme } = useTheme()
  const session = route.data.type === "session" ? route.data.sessionID : ""
  const scope = { directory: project.instance.directory() || sdk.directory, workspace: project.workspace.current(), session }
  const controller = new AbortController()
  const options = { signal: controller.signal, throwOnError: true as const }
  const json = { ...options, body: {} }
  const [status, setStatus] = createSignal<Status>()
  const [snapshot, setSnapshot] = createSignal<Snapshot>()
  const [manifest, setManifest] = createSignal<Manifest>()
  const [execution, setExecution] = createSignal(false)
  const [lookup, setLookup] = createSignal<string>()
  const [lookups, setLookups] = createSignal<readonly string[]>([])
  const [purpose, setPurpose] = createSignal<"coding" | "enhance">("coding")
  const selected = () => purpose() === "coding" ? status()?.coding : status()?.preparation
  const [error, setError] = createSignal("")
  const [failure, setFailure] = createSignal("")
  const [summary, setSummary] = createSignal("")
  const [explaining, setExplaining] = createSignal(false)
  const [managing, setManaging] = createSignal(false)
  const [adding, setAdding] = createSignal<"file" | "folder" | "text">()
  const [mapped, setMapped] = createSignal(props.command === "map")
  const [focus, setFocus] = createSignal<{ category?: string; document?: string }>({})
  const [shown, setShown] = createSignal<{ category?: string; document?: string }>({})
  const [paging, setPaging] = createSignal(false)
  const [waiting, setWaiting] = createSignal(true)
  const [elapsed, setElapsed] = createSignal(0)
  const [cancelled, setCancelled] = createSignal(false)
  const freshness = () => waiting() || paging() ? "; refreshing" : snapshot() && snapshot()!.generation !== status()?.inventory.generation ? "; newer inventory observed; [u] Retry" : ""
  let started = performance.now()
  let pending: AbortController | undefined
  let browsing: AbortController | undefined
  let generation = ""
  let sequence = 0
  let captured = ""
  let scroll: ScrollBoxRenderable | undefined
  const refresh = updates({ signal: controller.signal, load: () => cancelled() ? Promise.resolve() : load(false), error: report })

  createEffect(() => {
    if (!waiting()) return
    const timer = setInterval(() => setElapsed(Math.floor((performance.now() - started) / 1000)), 1000)
    onCleanup(() => clearInterval(timer))
  })

  function interrupt() {
    browsing?.abort()
    browsing = undefined
    sequence++
    setPaging(false)
  }

  function cancel() {
    pending?.abort()
    interrupt()
    setWaiting(false)
    setCancelled(true)
  }

  function report(err: unknown) {
    if (valid()) setError(err instanceof Error ? err.message : String(err))
  }

  function failed(err: unknown) {
    if (valid()) setFailure(err instanceof Error ? err.message : String(err))
  }

  function valid() {
    const active = route.data.type === "session" ? route.data.sessionID : ""
    return !controller.signal.aborted && active === session && project.workspace.current() === scope.workspace
      && (project.instance.directory() || sdk.directory) === scope.directory
  }

  function map(value = !mapped()) {
    if (!valid()) return
    if (!value && props.back) { props.back(); return }
    setMapped(value)
    if (!focus().category && !focus().document) return
    setFocus({})
    void browse()
  }

  function add(kind?: "file" | "folder" | "text") {
    if (!valid()) return
    setAdding(kind)
    setManaging(true)
  }

  function navigate(value: { category?: string; document?: string }) {
    if (!valid()) return
    setFocus(value)
    void browse()
  }

  async function load(manual = true) {
    if (!valid()) return
    pending?.abort()
    if (manual) interrupt()
    const request = new AbortController()
    pending = request
    const signal = AbortSignal.any([controller.signal, request.signal])
    const options = { signal, throwOnError: true as const }
    started = performance.now()
    setElapsed(0)
    setCancelled(false)
    setWaiting(true)
    setFailure("")
    try {
      const result = await sdk.client.forge.status(scope, options)
      if (!valid() || signal.aborted || pending !== request) return
      setWaiting(false)
      setStatus(result.data)
      const lens = purpose()
      const coding = lens === "coding" ? result.data.coding : result.data.preparation
      const reference = lookup()
      const key = reference ?? JSON.stringify(coding) ?? ""
      if (captured !== key || !coding) setManifest(undefined)
      // Source browsing and capture loading are independent, but excerpts must match the selected request.
      // A held page must not prevent newer inventory events from invalidating it.
      if ((browsing ? generation : snapshot()?.generation) !== result.data.inventory.generation) void browse()
      if (!coding) { captured = ""; return }
      if (manifest() && captured === key) return
      const item = reference ? (await sdk.client.forge.request({ ...scope, id: reference }, options)).data.request
        : (await sdk.client.forge.requests({ ...scope, purpose: lens, limit: "1" }, options)).data.at(0)
      if (!valid() || signal.aborted || pending !== request || purpose() !== lens || lookup() !== reference) return
      if (item?.id !== (reference ?? coding.id) || item.session !== session || (reference && item.purpose !== "tool-retrieval")) throw new Error(`Selected ${reference ? "tool retrieval" : lens === "coding" ? "coding" : "preparation"} capture is unavailable or changed. Press u to retry.`)
      if (!reference) setLookups(item.lookups ?? [])
      setManifest(item)
      captured = key
    } catch (err) {
      if (!signal.aborted && pending === request) failed(err)
    } finally {
      if (pending === request) setWaiting(false)
    }
  }

  async function browse(offset = 0) {
    if (!valid()) return
    browsing?.abort()
    const request = new AbortController()
    browsing = request
    generation = status()?.inventory.generation ?? ""
    const signal = AbortSignal.any([controller.signal, request.signal])
    const attempt = ++sequence
    const lens = focus()
    setPaging(true)
    setFailure("")
    try {
      const result = await sdk.client.forge.view({ ...scope, ...lens, limit: "25", offset: String(offset), generation: snapshot()?.generation }, { ...options, signal })
      if (valid() && attempt === sequence && !signal.aborted) batch(() => { setSnapshot(result.data); setShown(lens) })
    } catch (err) {
      if (attempt === sequence && !signal.aborted) failed(err)
    } finally {
      if (browsing === request) browsing = undefined
      if (attempt === sequence) setPaging(false)
    }
  }

  async function index() {
    if (!valid()) return
    setError("")
    await sdk.client.forge.index(scope, json)
    refresh()
  }

  async function explain() {
    if (!valid() || explaining()) return
    setExplaining(true)
    try {
      const result = await sdk.client.forge.overview(scope, json)
      if (!valid()) return
      setSummary(result.data.summary)
    } catch (err) {
      report(err)
    } finally {
      setExplaining(false)
    }
  }

  onMount(() => {
    prompt?.blur()
    dialog.setSize(mapped() ? "xlarge" : "large")
    const off = sdk.event.on("event", (event) => { if (notice(event, scope, true)) refresh() })
    onCleanup(off)
    void load()
  })
  onCleanup(() => { controller.abort(); prompt?.focus() })
  createEffect(() => { if (!managing()) dialog.setSize(mapped() ? "xlarge" : "large") })
  createEffect(() => {
    const active = route.data.type === "session" ? route.data.sessionID : ""
    if (active === session && project.workspace.current() === scope.workspace && (project.instance.directory() || sdk.directory) === scope.directory) return
    controller.abort()
    cancel()
    setStatus(undefined)
    setSnapshot(undefined)
    setManifest(undefined)
    setManaging(false)
    setMapped(false)
    setSummary("")
    setFailure("")
    setExplaining(false)
    setLookup(undefined)
    setLookups([])
    setError("Workspace or session changed. Reopen Forge to inspect its knowledge.")
  })
  navigation(() => {
    if (execution()) { setExecution(false); return }
    if (props.back) { props.back(); return }
    dialog.clear()
  }, () => !mapped() && !managing())
  useBindings(() => ({
    enabled: !managing(),
    priority: 1,
    bindings: [
      { key: "down", desc: "Scroll knowledge down", group: "Forge", cmd: () => scroll?.scrollBy(1) },
      { key: "up", desc: "Scroll knowledge up", group: "Forge", cmd: () => scroll?.scrollBy(-1) },
      { key: "pagedown", desc: "Page knowledge down", group: "Forge", cmd: () => scroll?.scrollBy(16) },
      { key: "pageup", desc: "Page knowledge up", group: "Forge", cmd: () => scroll?.scrollBy(-16) },
      { key: "r", desc: "Close knowledge", group: "Forge", cmd: () => dialog.clear() },
      { key: "c", desc: "Cancel inspection read", group: "Forge", cmd: cancel },
      { key: "m", desc: "Toggle terminal map", group: "Forge", cmd: () => map() },
      { key: "o", desc: "Return to overview", group: "Forge", cmd: () => map(false) },
      { key: "i", desc: "Index knowledge", group: "Forge", cmd: () => { void index().catch(report) } },
      { key: "x", desc: "Cancel indexing", group: "Forge", cmd: () => { void sdk.client.forge.cancel(scope, json).catch(report) } },
      { key: "e", desc: "Explain repository", group: "Forge", cmd: () => { void explain() } },
      { key: "k", desc: "Manage knowledge", group: "Forge", cmd: () => add() },
      { key: "a", desc: "Add reference", group: "Forge", cmd: () => add("file") },
      { key: "d", desc: "Add reference file", group: "Forge", cmd: () => add("file") },
      { key: "f", desc: "Add references folder", group: "Forge", cmd: () => add("folder") },
      { key: "t", desc: "Add pasted reference", group: "Forge", cmd: () => add("text") },
      { key: "u", desc: "Reload knowledge", group: "Forge", cmd: () => { void load() } },
      { key: "h", desc: "Inspect retrieval execution", group: "Forge", cmd: () => { setMapped(false); setExecution((value) => !value); scroll?.scrollTo(0) } },
      { key: "p", desc: "Switch coding/preparation", group: "Forge", cmd: () => {
        scroll?.scrollTo(0)
        setExecution(false)
        setLookup(undefined)
        setLookups([])
        setManifest(undefined)
        setPurpose((value) => value === "coding" ? "enhance" : "coding")
        void load()
      } },
      { key: "l", desc: "Cycle referenced tool retrievals", group: "Forge", cmd: () => {
        setLookup((value) => lookups().at(value ? lookups().indexOf(value) + 1 : 0))
        setManifest(undefined)
        scroll?.scrollTo(0)
        void load()
      } },
      { key: "n", desc: "Next sources", group: "Forge", cmd: () => { if (!paging() && snapshot()?.page?.next != null) void browse(snapshot()!.page.next) } },
      { key: "b", desc: "Previous sources", group: "Forge", cmd: () => { if (!paging() && snapshot()?.page?.offset) void browse(Math.max(0, snapshot()!.page.offset - snapshot()!.page.limit)) } },
    ],
  }))

  return <box><Show when={!managing()} fallback={<ForgeLibrary scope={scope} root={status()?.inventory.root} references={status()?.references} initial={adding()} back={() => { setManaging(false); refresh() }} draft={draft} valid={() => !controller.signal.aborted && JSON.stringify(unwrap(prompt?.current)) === JSON.stringify(draft)} />}><box padding={1} gap={mapped() ? 0 : 1}>
    <text fg={theme.primary}>Forge · {mapped() ? "map" : "overview"} · agent knowledge</text>
    <text fg={theme.textMuted}>{scope.directory}{"\n"}Session: {session || "No active coding session"}</text>
    <Show when={!mapped()} fallback={<box>
      <Show when={waiting()}><text fg={theme.primary}>{status() ? "Refreshing" : "Waiting for"} saved inventory status · {elapsed()}s elapsed · [c] Cancel wait</text></Show>
      <Show when={cancelled()}><text>Status wait cancelled locally. Backend work may continue. [u] Retry · [r] Close</text></Show>
      <Show when={error()}><text fg={theme.error}>{error()}</text></Show>
      <Show when={failure()}><text fg={theme.error}>{failure()}</text></Show>
      <Show when={status() && !status()!.inventory.indexed}><text>No inventory yet. Press i to index this workspace.</text></Show>
      <ForgeMap view={snapshot()} inventory={status()?.inventory} manifest={manifest()} request={selected()} model={model?.()}
        scope={scope} category={focus().category} document={focus().document} loading={paging() || JSON.stringify(shown()) !== JSON.stringify(focus())} enabled={valid()} navigate={navigate} back={() => map(false)} />
      <Show when={status()}>{(value) => <text fg={theme.textMuted}>Index: {value().job.state} · {value().job.message}{"\n"}Latest {purpose() === "coding" ? "coding request" : "preparation"}: {selected()?.model ?? "None observed"}</text>}</Show>
      <Show when={paging()}><text fg={theme.textMuted}>Reading source page. [c] Cancel read · [u] Retry · [r] Close</text></Show>
      <Show when={snapshot()?.page}>{(page) => <text fg={theme.textMuted}>Source Page {Math.floor(page().offset / page().limit) + 1} · {page().next == null ? "Last page" : "More available"} · [n]/[b] Sources{freshness()}</text>}</Show>
      <For each={snapshot()?.warnings.slice(0, 1)}>{(warning) => <text fg={theme.textMuted}>{warning}</text>}</For>
    </box>}>
    <scrollbox ref={(value: ScrollBoxRenderable) => { scroll = value }} height={20} contentOptions={{ paddingLeft: 1 }}>
      <Show when={waiting()}>
        <text fg={theme.primary}>{status() ? "Refreshing" : "Waiting for"} saved inventory status · {elapsed()}s elapsed</text>
        <text>{status() ? `Showing last observed inventory generation ${status()!.inventory.generation}; refreshing.` : "Saved inventory unknown until the status response arrives."}</text>
        <text fg={theme.textMuted}>Request waiting may include local initialization or recovery.</text>
        <text fg={theme.textMuted}>Backend progress is not observed.</text>
        <text fg={theme.textMuted}>Inspection starts no model call or scan. [c] Cancel wait · [u] Retry · [r] Close</text>
      </Show>
      <Show when={cancelled()}><text>Status wait cancelled locally. Backend work may continue. [u] Retry · [r] Close</text></Show>
      <Show when={error()}><text fg={theme.error}>{error()}</text></Show>
      <Show when={failure()}><text fg={theme.error}>{failure()}</text></Show>
      <Show when={execution()}><For each={progress(manifest()?.retrieval)}>{(line) => <text>{line}</text>}</For></Show>
      <Show when={!execution()}><Show when={status()} fallback={!waiting() ? <text>Saved inventory unknown. [u] Retry status · [r] Close</text> : undefined}>{(value) => <>
        <text fg={theme.primary}>Available knowledge</text>
        <text>{value().inventory.indexed ? `${value().inventory.files} files inspected; ${value().inventory.partial ? "partial coverage" : "within configured scope"}` : "No inventory yet. Press i to index this workspace."}</text>
        <text fg={theme.textMuted}>Available sources are not necessarily in the agent's context.</text>
        <text fg={theme.textMuted}>{semantic(value().semantic)}</text>
        <text fg={theme.textMuted}>{coverage}</text>
        <For each={Object.entries(value().inventory.counts)}>{([kind, count]) => <text>{kind}: {count}</text>}</For>
        <For each={Object.entries(snapshot()?.categories ?? {}).filter(([kind]) => ["pdf", "word", "markdown", "text", "web", "document"].includes(kind))}>{([kind, count]) =>
          <text>{labels[kind]}: {count} document objects{freshness()}</text>
        }</For>
        <text>{"\n"}Index: {value().job.state} · {value().job.message}</text>
        <text fg={theme.primary}>{"\n"}Latest {purpose() === "coding" ? "coding request" : "preparation"} · [p] Switch coding/preparation</text>
        <Show when={lookup()}><text>Inspecting tool retrieval: {lookup()} · [l] Next retrieval / return</text></Show>
        <Show when={!lookup() && selected()} fallback={!lookup() ? <text>No {purpose() === "coding" ? "coding request" : "preparation"} observed for this session.</text> : undefined}>{(coding) => <>
          <text>{coding().model} · {coding().state} · {new Date(coding().observed).toLocaleTimeString()}</text>
          <text>{coding().sent} excerpts observed sent / {coding().entries} captured. This does not prove model retention.</text>
          <Show when={!manifest()}><text fg={theme.textMuted}>Capture unavailable or loading. Press u to retry.</text></Show>
        </>}</Show>
        <Show when={manifest()?.preparation}>{(key) => <text fg={theme.textMuted}>Preparation reference: {key()}{"\n"}{caveat}</text>}</Show>
        <Show when={manifest()}>{(item) => <>
          <Show when={item().operation}><text fg={theme.textMuted}>Operation: {item().operation}</text></Show>
          <For each={item().lookups}>{(key) => <text>Tool retrieval: {key} · [l] Inspect</text>}</For>
          <Show when={item().lookup}>{(value) => <text>Lookup tool: {value().tool}{"\n"}Tool call: {value().call ?? "not recorded"}{"\n"}Query / source ID: {value().query}</text>}</Show>
          <text fg={theme.textMuted}>{attempts(item())}</text>
          <For each={item().attempts}>{(attempt) => <text>{outcome(attempt)}{"\n"}{attempt.id}</text>}</For>
          <Show when={purpose() === "enhance" || item().lookup}>
            <text fg={theme.textMuted}>{decisions(item().selection)}</text>
            <For each={channels(item().selection)}>{(line) => <text fg={theme.textMuted}>{line}</text>}</For>
            <For each={item().selection?.candidates}>{(candidate) => <box flexDirection="column">
              <text>{candidate.state} {candidate.source} · {candidate.reason}{"\n"}{candidate.retrieval}</text>
              <For each={candidate.channels}>{(channel) => <text fg={theme.textMuted}>{channel.name} rank {channel.rank} · score {channel.score} · {channel.reason}</text>}</For>
            </box>}</For>
          </Show>
        </>}</Show>
        <For each={manifest()?.entries.slice(0, 20)}>{(entry) => <text>{entry.stage.padEnd(12)} {entry.label ?? entry.uri ?? entry.source}</text>}</For>
        <Show when={value().preparation}>{(item) => <text>{"\n"}Latest preparation: {item().state} · {item().model}</text>}</Show>
        <text fg={theme.primary}>{"\n"}Available sources{snapshot() ? ` · Source generation: ${snapshot()!.generation}` : ""}</text>
        <Show when={paging()}><text fg={theme.textMuted}>Reading source page. [c] Cancel read · [u] Retry · [r] Close</text></Show>
        <Show when={snapshot()?.page}>{(page) => <text fg={theme.textMuted}>Page {Math.floor(page().offset / page().limit) + 1} · {snapshot()?.sources.length} sources · {paging() ? "Loading" : page().next == null ? "Last page" : "More available"}{"\n"}[n] Next sources · [b] Previous sources. Knowledge updates restart browsing.</text>}</Show>
        <For each={snapshot()?.sources}>{(item) => <text>{item.kind.padEnd(12)} {item.uri} · last observed {item.status}{freshness()}</text>}</For>
        <text fg={theme.primary}>{"\n"}References directory: {value().references ?? references(value().inventory.root)}</text>
        <text fg={theme.textMuted}>[a] Add file · [f] Add references folder · [t] Paste text. Confirm ADD to parse locally; provider sharing stays separate.</text>
        <For each={value().inventory.warnings}>{(warning) => <text fg={theme.textMuted}>{warning}</text>}</For>
      </>}</Show></Show>
      <Show when={explaining()}><text>Generating repository explanation. Knowledge inspection remains available.</text></Show>
      <Show when={summary()}><text>{"\n"}{summary()}</text></Show>
    </scrollbox>
    </Show>
    <Show when={!mapped()} fallback={<box>
      <text onMouseUp={() => add("file")}>[a] Reference · [f] Folder · [k] Library · [o] Overview</text>
      <text fg={theme.textMuted}>[u] Reload · [p] Coding/preparation · [r] Reject / close</text>
    </box>}>
    <text fg={theme.textMuted} onMouseUp={() => { setExecution((value) => !value); scroll?.scrollTo(0) }}>Up/Down or Page Up/Page Down · [h] {execution() ? "Return to knowledge" : "Retrieval execution history"}</text>
    <text fg={theme.primary} onMouseUp={() => void index().catch(report)}>[i] Index / refresh knowledge</text>
    <text onMouseUp={() => add()}>[k] Add / manage documents and folders · [a] Add reference</text>
    <text onMouseUp={() => void sdk.client.forge.cancel(scope, json).catch(report)}>[x] Cancel indexing</text>
    <text onMouseUp={() => void explain()}>[e] Explain repository (model call)</text>
    <text onMouseUp={() => map()}>[m] Interactive knowledge map (terminal)</text>
    <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>[r] Reject / close · [u] Reload view · Esc / Backspace Back</text>
    </Show>
  </box></Show></box>
}
