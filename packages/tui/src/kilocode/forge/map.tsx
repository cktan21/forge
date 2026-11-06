import { batch, createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import type { ScrollBoxRenderable } from "@opentui/core"
import type { Inventory, Manifest, RequestInfo, Source, View } from "@kilocode/forge/schema"
import { category, labels } from "@kilocode/forge/references"
import { useBindings } from "../../keymap"
import { useSDK } from "../../context/sdk"
import { useTheme } from "../../context/theme"
import { capacity, connections, counts, layout, move, projection, truncate } from "./graph"
import { navigation } from "./back"

export function ForgeMap(props: {
  view?: View
  inventory?: Inventory
  manifest?: Manifest
  request?: RequestInfo
  model?: string
  scope: { directory?: string; workspace?: string; session: string }
  category?: string
  document?: string
  loading?: boolean
  enabled: boolean
  navigate: (focus: { category?: string; document?: string }) => void
  back: () => void
}) {
  const sdk = useSDK()
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const [captured, setCaptured] = createSignal(false)
  const [group, setGroup] = createSignal("")
  const [cursor, setCursor] = createSignal("forge")
  const [page, setPage] = createSignal(0)
  const [inspection, setInspection] = createSignal<Source | "forge">()
  const inspected = () => { const value = inspection(); return typeof value === "object" ? value : undefined }
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal("")
  const width = () => Math.max(28, Math.min(112, dimensions().width - 6))
  const height = () => Math.max(8, Math.min(28, dimensions().height - 26))
  const size = () => capacity(height())
  const selected = () => captured() ? props.manifest : undefined
  const sources = createMemo(() => captured() && !props.manifest ? [] : projection(props.view, selected()))
  const focus = () => captured() ? group() : props.category ?? ""
  const model = () => captured() ? props.manifest?.model || props.request?.model || "No captured model" : props.model || "No model selected"
  const groups = createMemo(() => captured() ? counts(sources()) : props.view?.categories ?? props.inventory?.counts ?? counts(sources()))
  const items = createMemo(() => {
    if (!focus() && !props.document) return Object.entries(groups()).filter(([, count]) => count > 0)
      .sort(([a], [b]) => (labels[a] ?? a).localeCompare(labels[b] ?? b))
      .map(([kind, count]) => ({ id: `category:${kind}`, label: labels[kind] ?? kind, caption: `${count} ${captured() ? "captured sources" : "source objects"}`, category: kind }))
    if (!captured() && props.loading) return []
    return sources().filter((source) => (!captured() && props.view?.categories != null) || props.document || category(source) === focus()).map((source) => ({
      id: source.id, label: source.label || source.uri, caption: source.detail?.stage ?? source.status, source,
    }))
  })
  const nodes = createMemo(() => layout(items().slice(page() * size(), (page() + 1) * size()), width(), height(), model()))
  const current = () => nodes().find((node) => node.id === cursor()) ?? nodes().at(0)!
  const controller = new AbortController()
  let pending: AbortController | undefined
  let scroll: ScrollBoxRenderable | undefined

  function close() {
    pending?.abort()
    pending = undefined
    setInspection(undefined)
    setLoading(false)
    setError("")
  }

  function reset() {
    close()
    setPage(0)
    setCursor("forge")
  }

  function out() {
    if (inspection()) { close(); return }
    reset()
    if (captured() && group()) { setGroup(""); return }
    if (props.document) { props.navigate({ category: props.category }); return }
    if (props.category) { props.navigate({}); return }
    props.back()
  }

  function zoom() {
    const item = current()
    if (item.category) {
      reset()
      if (captured()) { setGroup(item.category); return }
      props.navigate({ category: item.category })
      return
    }
    if (item.source?.method === "collection-document" && !captured()) {
      reset()
      props.navigate({ category: props.category, document: item.source.id })
      return
    }
    void inspect()
  }

  async function inspect() {
    const item = current()
    if (item.category) { zoom(); return }
    close()
    if (!item.source) { setInspection("forge"); return }
    setInspection(item.source)
    if (captured() || item.source.status === "unavailable") return
    const request = new AbortController()
    pending = request
    setLoading(true)
    try {
      const result = await sdk.client.forge.source({ ...props.scope, id: item.source.id }, {
        throwOnError: true, signal: AbortSignal.any([controller.signal, request.signal]),
      })
      if (props.enabled && !request.signal.aborted && pending === request) setInspection(result.data)
    } catch (err) {
      if (!request.signal.aborted && pending === request) setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (pending === request) setLoading(false)
    }
  }

  function cycle(direction: 1 | -1) {
    close()
    const all = ["forge", ...items().map((item) => item.id)]
    const index = (Math.max(0, all.indexOf(cursor())) + direction + all.length) % all.length
    batch(() => {
      if (index) setPage(Math.floor((index - 1) / size()))
      setCursor(all.at(index) ?? "forge")
    })
  }

  function turn(direction: 1 | -1) {
    close()
    setCursor("forge")
    setPage((value) => Math.max(0, Math.min(Math.ceil(items().length / size()) - 1, value + direction)))
  }

  createEffect(() => {
    props.view
    props.manifest
    props.category
    props.document
    captured()
    reset()
  })
  createEffect(() => { if (!props.enabled) close() })
  createEffect(() => {
    if (nodes().some((node) => node.id === cursor())) return
    setCursor("forge")
  })
  onCleanup(() => { controller.abort(); pending?.abort() })
  navigation(out, () => props.enabled)
  useBindings(() => ({
    enabled: props.enabled,
    priority: 2,
    bindings: [
      ...(["up", "down", "left", "right"] as const).map((key) => ({
        key, desc: `Move ${key}`, group: "Forge Map", cmd: () => {
          if (inspection()) { scroll?.scrollBy(key === "up" || key === "left" ? -1 : 1); return }
          setCursor(move(nodes(), cursor(), key))
        },
      })),
      { key: "tab", desc: "Next object", group: "Forge Map", cmd: () => cycle(1) },
      { key: "shift+tab", desc: "Previous object", group: "Forge Map", cmd: () => cycle(-1) },
      { key: "return", desc: "Inspect object", group: "Forge Map", cmd: () => { void inspect() } },
      { key: "z", desc: "Zoom into object", group: "Forge Map", cmd: zoom },
      { key: "shift+z", desc: "Zoom out", group: "Forge Map", cmd: out },
      { key: "0", desc: "Reset map", group: "Forge Map", cmd: () => { reset(); setGroup(""); props.navigate({}) } },
      { key: "]", desc: "Next objects", group: "Forge Map", cmd: () => turn(1) },
      { key: "[", desc: "Previous objects", group: "Forge Map", cmd: () => turn(-1) },
      { key: "pagedown", desc: "Page down", group: "Forge Map", cmd: () => { if (inspection()) scroll?.scrollBy(10); else turn(1) } },
      { key: "pageup", desc: "Page up", group: "Forge Map", cmd: () => { if (inspection()) scroll?.scrollBy(-10); else turn(-1) } },
      { key: "v", desc: "Available / captured context", group: "Forge Map", cmd: () => {
        reset(); setGroup(""); setCaptured((value) => !value); props.navigate({})
      } },
    ],
  }))

  return <box gap={0}>
    <text fg={theme.primary}>Terminal knowledge map · {captured() ? "Captured request context" : "Available knowledge"}{focus() ? ` / ${labels[focus()] ?? focus()}` : ""}{props.document ? " / Sections" : ""}</text>
    <text fg={theme.textMuted}>{captured() ? `Captured model: ${model()}` : `Selected model: ${model()}`} · [v] Switch view</text>
    <Show when={!inspection()} fallback={<box>
      <text fg={theme.primary}>Source inspector (read-only) · Esc / Backspace returns to map</text>
      <Show when={loading()}><text>Loading the permission-checked original; showing last observed excerpt.</text></Show>
      <Show when={error()}><text fg={theme.error}>{error()}</text></Show>
      <scrollbox ref={(value: ScrollBoxRenderable) => { scroll = value }} height={height()}>
        <Show when={inspected()} fallback={<text>
          Forge assembles relevant source passages for the selected model.{"\n"}
          Available knowledge is not necessarily included in a request.{"\n"}
          Captured context records retrieved, selected, assembled, and observed-sent excerpts.{"\n"}
          Observed delivery does not prove the model retained or understood the content.{"\n"}
          Model: {model()}{"\n"}Request: {props.manifest?.id ?? "No request captured"}
        </text>}>{(source) => {
          return <box gap={1}>
            <text>{source().label}{"\n"}{source().uri}</text>
            <text fg={theme.textMuted}>{labels[category(source())] ?? source().kind} · {source().status} · {source().method}{"\n"}
              {source().detail?.stage ? `Request stage: ${source().detail.stage}` : "Available source; inclusion in the model's context is not established."}{"\n"}
              {source().detail?.page ? `Page ${source().detail.page} · ` : ""}Lines {source().start}-{source().end}{"\n"}
              Version: {source().hash}{"\n"}{source().detail?.coverage}
            </text>
            <text>{source().text || source().detail?.brief || "No text excerpt. Press z on an available registered document to browse its sections."}</text>
            <Show when={!captured()}>
              <For each={props.view?.relations.filter((edge) => edge.from === source().id || edge.to === source().id)}>{(edge) =>
                <text fg={theme.textMuted}>{edge.kind}{edge.inferred ? " (inferred)" : ""}: {edge.from === source().id ? edge.to : edge.from}{"\n"}{edge.reason}</text>
              }</For>
              <text fg={theme.textMuted}>Relationships are limited to endpoints on the current source page.</text>
            </Show>
            <Show when={captured()}><text fg={theme.textMuted}>Historical capture only. Current repository relationships are not evidence for this request.</text></Show>
          </box>
        }}</Show>
      </scrollbox>
    </box>}>
      <box width={width()} height={height()} overflow="hidden">
        <text position="absolute" left={0} top={0} width={width()} height={height()} fg={theme.textMuted}>{connections(nodes(), width(), height())}</text>
        <For each={nodes()}>{(node) => <box position="absolute" left={node.x} top={node.y} width={node.width} height={node.height}
          border borderStyle="single" borderColor={cursor() === node.id ? theme.primary : node.source?.status === "unavailable" ? theme.error : node.source?.detail?.stage === "sent" ? theme.success : theme.border}
          backgroundColor={cursor() === node.id ? theme.backgroundElement : theme.backgroundPanel}
          onMouseUp={() => setCursor(node.id)}>
          <text fg={cursor() === node.id ? theme.primary : theme.text}>{truncate(node.label, node.width - 2)}{"\n"}{truncate(node.caption, node.width - 2)}</text>
        </box>}</For>
      </box>
      <text fg={theme.primary}>Selected: {truncate(`${current().label}${current().source ? ` · ${current().source!.uri}` : ""}`, width() - 10)}</text>
      <text fg={theme.textMuted}>Objects {items().length ? page() * size() + 1 : 0}-{Math.min(items().length, (page() + 1) * size())} / {items().length} · [ / ] More objects</text>
      <Show when={!focus()}><text fg={theme.textMuted}>Page sources: {truncate(sources().slice(0, 2).map((source) => `${source.uri} (${source.status})`).join(", ") || "None on this source page", width() - 14)}</text></Show>
      <Show when={captured() && !props.manifest}><text>No captured request context available. The available catalog is not substituted.</text></Show>
      <Show when={focus() && !items().length}><text>No matching sources on this page. Loading, unavailable, or empty category.</text></Show>
    </Show>
    <text fg={theme.textMuted}>Arrows Select · Tab Next · Enter Inspect · z Zoom{"\n"}Shift+z Zoom out · 0 Reset · [v] Available / request</text>
    <text fg={theme.primary} onMouseUp={out}>[Esc / Backspace] Back one level</text>
    <text fg={theme.textMuted}>Edges: category membership, not model delivery.</text>
  </box>
}
