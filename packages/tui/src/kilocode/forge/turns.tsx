import { createEffect, createSignal, For, Show } from "solid-js"
import type { ScrollBoxRenderable } from "@opentui/core"
import type { Finding, Observation, Round } from "@kilocode/forge/investigation"
import { useTheme } from "../../context/theme"
import { useBindings } from "../../keymap"

export function ForgeTurns(props: {
  journal?: readonly Round[]
  observations: readonly Observation[]
  findings?: readonly Finding[]
  model: string
  height: number
}) {
  const { theme } = useTheme()
  const [cursor, setCursor] = createSignal(0)
  const [opened, setOpened] = createSignal(new Set<number>())
  const [details, setDetails] = createSignal(new Set<number>())
  const [following, setFollowing] = createSignal(true)
  const id = `forge-turns-${crypto.randomUUID()}`
  let scroll: ScrollBoxRenderable | undefined
  let latest = 0
  createEffect(() => {
    const count = props.journal?.length ?? 0
    if (count === latest) return
    latest = count
    if (!following() || !count) return
    const item = props.journal!.at(-1)!
    setCursor(count - 1)
    setOpened(new Set([item.number]))
    queueMicrotask(() => scroll?.scrollChildIntoView(`${id}-${item.number}`))
  })
  function choose(value: number) {
    setFollowing(false)
    const count = props.journal?.length ?? 0
    if (!count) return
    const index = (value + count) % count
    setCursor(index)
    scroll?.scrollChildIntoView(`${id}-${props.journal!.at(index)!.number}`)
  }
  function toggle(index = cursor()) {
    choose(index)
    const item = props.journal?.at(index)
    if (!item) return
    setOpened((value) => {
      const next = new Set(value)
      if (!next.delete(item.number)) next.add(item.number)
      return next
    })
  }
  function expand() {
    const item = props.journal?.at(cursor())
    if (!item) return
    setOpened((value) => new Set([...value, item.number]))
    setDetails((value) => {
      const next = new Set(value)
      if (!next.delete(item.number)) next.add(item.number)
      return next
    })
  }
  useBindings(() => ({
    priority: 3,
    bindings: [
      { key: "up", group: "Forge Turns", desc: "Previous turn", cmd: () => choose(cursor() - 1) },
      { key: "down", group: "Forge Turns", desc: "Next turn", cmd: () => choose(cursor() + 1) },
      { key: "tab", group: "Forge Turns", desc: "Next turn", cmd: () => choose(cursor() + 1) },
      { key: "shift+tab", group: "Forge Turns", desc: "Previous turn", cmd: () => choose(cursor() - 1) },
      { key: "return", group: "Forge Turns", desc: "Expand or collapse turn", cmd: () => toggle() },
      { key: "space", group: "Forge Turns", desc: "Expand or collapse turn", cmd: () => toggle() },
      { key: "r", group: "Forge Turns", desc: "Toggle resource previews and local activity", cmd: expand },
      { key: "pagedown", group: "Forge Turns", desc: "Scroll turn details down", cmd: () => scroll?.scrollBy(Math.max(1, props.height - 3)) },
      { key: "pageup", group: "Forge Turns", desc: "Scroll turn details up", cmd: () => scroll?.scrollBy(-Math.max(1, props.height - 3)) },
    ],
  }))
  return <box gap={1} flexGrow={1} flexShrink={1} flexBasis={0} minHeight={1}>
    <text flexShrink={0} fg={theme.primary}>Turn history | {props.model}</text>
    <text flexShrink={0} fg={theme.textMuted}>Public updates and recorded evidence, not private reasoning. Local reads do not prove model use.</text>
    <scrollbox ref={(value) => { scroll = value }} flexGrow={1} flexShrink={1} flexBasis={0} minHeight={1} scrollY={true}>
      <Show when={props.journal?.length} fallback={<box gap={1}>
        <text>{props.observations.length ? "Earlier run: turn boundaries were not recorded." : "No model turns recorded yet."}</text>
        <For each={props.observations}>{(item) => <box marginBottom={1}>
          <text fg={theme.primary}>{item.tool}</text>
          <For each={item.sources}>{(source) => <text>{source.uri}:{source.start}-{source.end} [{source.id}]</text>}</For>
        </box>}</For>
      </box>}>
        <For each={props.journal}>{(turn, index) => {
          const results = () => props.observations.filter((item) => item.turn === turn.number)
          const context = () => props.observations.filter((item) => turn.included.includes(item.id) || turn.omitted.includes(item.id))
          const cited = () => {
            const ids = new Set(results().flatMap((item) => item.sources.map((source) => source.id)))
            return props.findings?.filter((item) => [...item.evidence, ...item.counterevidence].some((id) => ids.has(id))) ?? []
          }
          return <box marginBottom={1} gap={1}>
            <text id={`${id}-${turn.number}`} fg={cursor() === index() ? theme.primary : theme.text} onMouseUp={() => toggle(index())}>
              {cursor() === index() ? "> " : "  "}{opened().has(turn.number) ? "v" : ">"} Turn {turn.number} | {turn.state}{turn.final ? " | final" : ""} | {turn.inspections.filter((item) => item.state === "complete").length}/{turn.requested} calls complete
            </text>
            <Show when={opened().has(turn.number)}>
              <text>{turn.summary}</text>
              <text fg={theme.textMuted}>Request {turn.request} | {new Date(turn.started).toLocaleTimeString()} | {Math.max(0, turn.updated - turn.started)} ms recorded</text>
              <Show when={turn.note} fallback={<text fg={theme.textMuted}>Public update: none returned by the model.</text>}>
                <text>Public update: {turn.note}</text>
              </Show>
              <Show when={turn.usage}>{(usage) => <text fg={theme.textMuted}>
                Tokens ({usage().measured ? "provider-reported" : "not fully reported"}): {usage().input} input, {usage().cached} cached, {usage().output} output{turn.reasoning == null ? "" : `, ${turn.reasoning} reasoning (count only)`}. Request estimate: {turn.bytes ?? 0} UTF-8 bytes.
              </text>}</Show>
              <text>Context assembled: user request + {turn.included.length} tool results; {turn.omitted.length} earlier results reduced to source references.</text>
              <Show when={details().has(turn.number)}>
                <For each={context()}>{(item) => <box>
                  <text fg={theme.textMuted}>{turn.included.includes(item.id) ? "Excerpt included" : "Metadata only"} from {item.tool} [{item.id}]</text>
                  <For each={item.sources}>{(source) => <text>{source.uri}:{source.start}-{source.end} [{source.id}]</text>}</For>
                </box>}</For>
              </Show>
              <For each={turn.inspections}>{(call) => {
                const observed = () => props.observations.find((item) => item.id === call.id && item.turn === turn.number)
                // Tall borders can escape terminal scroll clipping and overwrite fixed controls.
                return <box paddingLeft={1} paddingRight={1}>
                  <text fg={theme.primary}>{call.tool} | {call.state}</text>
                  <text>Arguments: {call.input}</text>
                  <Show when={call.activity}>
                    <text fg={theme.textMuted}>Local activity: {call.activity!.total} updates. {Object.entries(call.activity!.counts ?? {}).map(([key, count]) => `${key}: ${count}`).join(" | ")}</text>
                    <Show when={details().has(turn.number)}>
                      <For each={call.activity!.entries}>{(item) => <text fg={theme.textMuted}>{item.action}{item.path ? `: ${item.path}` : ""} | {item.detail}</text>}</For>
                      <Show when={call.activity!.total > call.activity!.entries.length}><text fg={theme.textMuted}>Bounded samples shown; counts include all recorded updates.</text></Show>
                    </Show>
                  </Show>
                  <Show when={observed()}>{(item) => <box>
                    <text>Returned resources: {item().sources.length} excerpts. Available to subsequent model turns.</text>
                    <For each={item().sources}>{(source) => <box>
                      <text>{source.uri}:{source.start}-{source.end} [{source.id}]</text>
                      <Show when={details().has(turn.number)}><text fg={theme.textMuted}>{source.text.slice(0, 2000)}{source.text.length > 2000 ? "\n[Preview truncated]" : ""}</text></Show>
                    </box>}</For>
                    <Show when={!item().sources.length}><text fg={theme.textMuted}>Tool feedback: {item().output.slice(0, 2000)}</text></Show>
                  </box>}</Show>
                </box>
              }}</For>
              <Show when={turn.requested > turn.inspections.length}><text fg={theme.warning}>Only the first {turn.inspections.length} request previews are retained.</text></Show>
              <For each={cited()}>{(item) => <text>Verdict reference: {item.title} ({item.kind}, {item.support})</text>}</For>
              <text fg={theme.textMuted} onMouseUp={() => { choose(index()); expand() }}>[r] {details().has(turn.number) ? "Hide" : "Show"} context resources, excerpts and local parse/search activity</text>
            </Show>
          </box>
        }}</For>
      </Show>
    </scrollbox>
    <text flexShrink={0} fg={theme.textMuted}>Up/Down turns | Enter/Space expand | r Resources | PgUp/PgDn scroll | t Back</text>
  </box>
}
