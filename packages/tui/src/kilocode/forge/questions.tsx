import { createSignal, For, Show } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import type { ScrollBoxRenderable } from "@opentui/core"
import type { Question } from "@kilocode/forge/schema"
import { useTheme } from "../../context/theme"
import { useBindings } from "../../keymap"
import type { Answer } from "./conversation"
import { ForgeField } from "./field"

export function ForgeQuestions(props: {
  questions: readonly Question[]
  values: Record<string, Answer>
  change: (key: string, value: Answer) => void
  submit: () => void
  back: () => void
}) {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const [index, setIndex] = createSignal(0)
  const [cursor, setCursor] = createSignal(0)
  const [editing, setEditing] = createSignal(false)
  const [error, setError] = createSignal("")
  const current = () => props.questions.at(index())
  const answer = () => props.values[current()?.id ?? ""]
  const complete = (item: Question) => !!(props.values[item.id]?.option || props.values[item.id]?.comment?.trim())
  const id = `forge-questions-${crypto.randomUUID()}`
  let scroll: ScrollBoxRenderable | undefined

  function change(value: Answer) {
    const item = current()
    if (!item) return
    setError("")
    props.change(item.id, { ...answer(), ...value })
  }
  function move(offset: number) {
    const count = (current()?.options.length ?? 0) + 1
    const next = (cursor() + offset + count) % count
    setCursor(next)
    scroll?.scrollChildIntoView(`${id}-${next}`)
  }
  function choose(value = cursor()) {
    setCursor(value)
    const option = current()?.options.at(value)
    if (option == null) { setEditing(true); return }
    change({ option: answer()?.option === option ? undefined : option, skipped: false })
  }
  function question(value: number) {
    setIndex(Math.max(0, Math.min(props.questions.length - 1, value)))
    setCursor(0)
    setError("")
    scroll?.scrollTo(0)
  }
  function next(skip = false) {
    const item = current()
    if (!item) return
    if (skip && !item.optional) { setError("This question needs an answer. Select an option or press c to type your own."); return }
    if (skip) change({ option: undefined, comment: "", skipped: true })
    if (!skip && !complete(item) && !answer()?.skipped) {
      setError("Select an option with Space or press c to type an answer.")
      return
    }
    if (index() + 1 < props.questions.length) { question(index() + 1); return }
    const missing = props.questions.findIndex((item) => !item.optional && !complete(item))
    if (missing >= 0) {
      question(missing)
      setError("Answer this required question before investigating again.")
      return
    }
    props.submit()
  }
  useBindings(() => ({
    enabled: !editing(),
    priority: 3,
    bindings: [
      { key: "up", group: "Forge Questions", desc: "Previous option", cmd: () => move(-1) },
      { key: "down", group: "Forge Questions", desc: "Next option", cmd: () => move(1) },
      { key: "tab", group: "Forge Questions", desc: "Next option", cmd: () => move(1) },
      { key: "shift+tab", group: "Forge Questions", desc: "Previous option", cmd: () => move(-1) },
      { key: "left", group: "Forge Questions", desc: "Previous question", cmd: () => question(index() - 1) },
      { key: "right", group: "Forge Questions", desc: "Next question", cmd: () => question(index() + 1) },
      { key: "space", group: "Forge Questions", desc: "Select or clear answer", cmd: () => choose() },
      { key: "return", group: "Forge Questions", desc: "Continue with answers", cmd: () => {
        if (cursor() === current()?.options.length && !answer()?.comment?.trim()) { setEditing(true); return }
        next()
      } },
      { key: "c", group: "Forge Questions", desc: "Type an answer or add details", cmd: () => setEditing(true) },
      { key: "s", group: "Forge Questions", desc: "Skip optional question", cmd: () => next(true) },
      { key: "escape", group: "Forge Questions", desc: "Review without losing answers", cmd: props.back },
      { key: "pageup", group: "Forge Questions", desc: "Scroll options up", cmd: () => scroll?.scrollBy(-Math.max(1, dimensions().height - 15)) },
      { key: "pagedown", group: "Forge Questions", desc: "Scroll options down", cmd: () => scroll?.scrollBy(Math.max(1, dimensions().height - 15)) },
    ],
  }))
  return <box gap={1} flexGrow={1} flexShrink={1} flexBasis={0} minHeight={1}>
    <text flexShrink={0} fg={theme.primary}>Clarification {index() + 1}/{props.questions.length} | {current()?.optional ? "Optional" : "Required"}</text>
    <scrollbox ref={(value: ScrollBoxRenderable) => { scroll = value }} flexGrow={1} flexShrink={1} flexBasis={0} minHeight={1}>
      <text fg={theme.primary}>{current()?.question}</text>
      <text fg={theme.textMuted}>{current()?.impact}{"\n"}Choose one option, type your own answer, or add details to your selection.{"\n"}</text>
      <Show when={!editing()}>
        <For each={current()?.options}>{(option, position) => <text id={`${id}-${position()}`} fg={cursor() === position() ? theme.primary : theme.text} onMouseUp={() => choose(position())}>
          {cursor() === position() ? "> " : "  "}[{answer()?.option === option ? "x" : " "}] {option}
        </text>}</For>
        <text id={`${id}-${current()?.options.length ?? 0}`} fg={cursor() === current()?.options.length ? theme.primary : theme.text} onMouseUp={() => setEditing(true)}>
          {cursor() === current()?.options.length ? "> " : "  "}[c] Write my own answer / add details
        </text>
        <text fg={theme.textMuted}>{"\n"}Selected: {answer()?.option ?? (answer()?.skipped ? "Skipped" : "None")}{"\n"}Your answer / details: {answer()?.comment || "None"}</text>
      </Show>
    </scrollbox>
    <Show when={error()}><text flexShrink={0} fg={theme.error}>{error()}</text></Show>
    <Show when={editing()} fallback={<box flexShrink={0}>
      <text fg={theme.primary} onMouseUp={() => next()}>Enter {index() + 1 === props.questions.length ? "Investigate with answers (model calls)" : "Next question"}</text>
      <text fg={theme.textMuted}>Up/Down Move | Space Select | c Type answer | s Skip optional</text>
      <text fg={theme.textMuted}>Left/Right Questions | PgUp/PgDn Scroll | Esc Review</text>
    </box>}>
      <ForgeField title="Your answer or additional details. Enter saves; it does not call the model."
        value={answer()?.comment ?? ""} change={(comment) => change({ comment, skipped: false })}
        submit={(comment) => { change({ comment, skipped: false }); setEditing(false) }} back={() => { setEditing(false) }} />
    </Show>
  </box>
}
