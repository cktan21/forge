import { createEffect, createSignal, For, Show } from "solid-js"
import type { ScrollBoxRenderable } from "@opentui/core"
import type { ActivityLog } from "@kilocode/forge/schema"
import { group } from "@kilocode/forge/activity"
import { useTheme } from "../../context/theme"
import { useBindings } from "../../keymap"

const sections = [
  { id: "repository", title: "Repository reads" },
  { id: "search", title: "Search activity" },
  { id: "retrieval", title: "Retrieved matches" },
  { id: "context", title: "Selected context" },
  { id: "checks", title: "Evidence and citation checks" },
]

export function ForgeActivity(props: { log?: ActivityLog; active?: boolean; scroll?: () => ScrollBoxRenderable | undefined; focus?: () => void }) {
  const { theme } = useTheme()
  const id = `forge-activity-${crypto.randomUUID()}`
  const [cursor, setCursor] = createSignal(0)
  const [opened, setOpened] = createSignal(new Set<string>())
  const rows = (key: string) => (props.log?.entries ?? []).filter((item) => group(item.action) === key)
  createEffect(() => {
    if (props.active) props.scroll?.()?.scrollChildIntoView(`${id}-${sections.at(cursor())!.id}`)
  })
  function choose(next: number) {
    setCursor((next + sections.length) % sections.length)
    props.scroll?.()?.scrollChildIntoView(`${id}-${sections.at(cursor())!.id}`)
  }
  function toggle(index = cursor()) {
    props.focus?.()
    choose(index)
    const key = sections.at(index)!.id
    setOpened((value) => {
      const next = new Set(value)
      if (next.delete(key)) return next
      next.add(key)
      return next
    })
  }
  useBindings(() => ({
    enabled: !!props.active,
    priority: 3,
    bindings: [
      { key: "up", desc: "Previous activity section", group: "Forge Activity", cmd: () => choose(cursor() - 1) },
      { key: "down", desc: "Next activity section", group: "Forge Activity", cmd: () => choose(cursor() + 1) },
      { key: "tab", desc: "Next activity section", group: "Forge Activity", cmd: () => choose(cursor() + 1) },
      { key: "shift+tab", desc: "Previous activity section", group: "Forge Activity", cmd: () => choose(cursor() - 1) },
      { key: "return", desc: "Expand or collapse activity section", group: "Forge Activity", cmd: () => toggle() },
      { key: "space", desc: "Expand or collapse activity section", group: "Forge Activity", cmd: () => toggle() },
    ],
  }))
  return <box gap={1}>
    <text fg={theme.primary} onMouseUp={props.focus}>File Activity{props.log ? ` (${props.log.total} recorded updates)` : ""}</text>
    <text fg={theme.textMuted}>Choose a section to expand it. Local reads are not the same as model-selected excerpts.</text>
    <For each={sections}>{(section, index) => <box gap={1}>
      <text id={`${id}-${section.id}`} fg={cursor() === index() ? theme.primary : theme.text} onMouseUp={() => toggle(index())}>
        {cursor() === index() ? "> " : "  "}{opened().has(section.id) ? "v" : ">"} {section.title} ({props.log?.counts?.[section.id] ?? rows(section.id).length} updates)
      </text>
      <Show when={opened().has(section.id)}>
        <Show when={rows(section.id).length} fallback={<text fg={theme.textMuted}>No recorded operations in this section yet.</text>}>
          <Show when={(props.log?.counts?.[section.id] ?? 0) > rows(section.id).length}>
            <text fg={theme.textMuted}>Showing the latest {rows(section.id).length} updates in this section.</text>
          </Show>
          <For each={rows(section.id)}>{(item) => <box buffered={true} border={true} borderColor={theme.textMuted} paddingLeft={1} paddingRight={1}>
            <text fg={theme.primary}>{item.action}{item.path ? `: ${item.path}` : ""}</text>
            <text fg={theme.textMuted}>{item.detail}</text>
          </box>}</For>
        </Show>
      </Show>
    </box>}</For>
  </box>
}
