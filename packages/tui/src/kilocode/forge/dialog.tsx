import { createEffect, createSignal, For, onCleanup, onMount, Show, useContext } from "solid-js"
import { useBindings } from "../../keymap"
import { useSDK } from "../../context/sdk"
import { useProject } from "../../context/project"
import { PromptRefContext } from "../../context/prompt"
import { useRoute } from "../../context/route"
import { useTheme } from "../../context/theme"
import { useDialog } from "../../ui/dialog"
import { DialogPrompt } from "../../ui/dialog-prompt"
import { DialogAlert } from "../../ui/dialog-alert"
import { Spinner } from "../../component/spinner"
import type { KiloClient } from "@kilocode/sdk/v2"
import { unwrap } from "solid-js/store"
import { prepared, requirements } from "./draft"
import { ForgeKnowledge } from "./knowledge"
import { attachments } from "./attachment"
import { ForgeAttachments } from "./attachments"
import { ForgeLibrary } from "./library"
import { compare, details } from "@kilocode/forge/review"
import { navigation } from "./back"
import { ForgeWorkshop } from "./workshop"

type Proposal = NonNullable<Awaited<ReturnType<KiloClient["forge"]["enhance"]>>["data"]>
type Opportunity = NonNullable<Awaited<ReturnType<KiloClient["forge"]["ideas"]>>["data"]>[number]
export type Command = "overview" | "ideas" | "enhance" | "map"

export function ForgeDialog(props: { command: Command; text?: string; previous?: Proposal; answers?: string }) {
  if (props.command === "overview" || props.command === "map") return <ForgeKnowledge command={props.command} />
  if (props.command === "enhance") return <ForgeWorkshop text={props.text} previous={props.previous} answers={props.answers} />
  return <ForgeReview command={props.command} text={props.text} previous={props.previous} answers={props.answers} />
}

function ForgeReview(props: { command: "ideas" | "enhance"; text?: string; previous?: Proposal; answers?: string }) {
  const sdk = useSDK()
  const project = useProject()
  const prompt = useContext(PromptRefContext)
  const route = useRoute()
  const dialog = useDialog()
  const { theme } = useTheme()
  const controller = new AbortController()
  const initial = prompt?.current
  const draft = initial ? structuredClone(unwrap(initial.current)) : undefined
  const directory = project.instance.directory() || sdk.directory
  const workspace = project.workspace.current()
  const session = route.data.type === "session" ? route.data.sessionID : undefined
  const input = (draft && (props.text == null || props.text === draft.input)
    ? requirements(draft)
    : props.text ?? "").replace(/^\/(?:enhance|ideas|overview|map)(?:\s+|$)/, "")
  const choice = !props.previous && props.command === "enhance" && attachments(draft?.parts ?? []).some((item) => item.registration)
  const [choosing, setChoosing] = createSignal(choice)
  const [managing, setManaging] = createSignal(false)
  const [mapped, setMapped] = createSignal(false)
  const [busy, setBusy] = createSignal(!choice)
  const [error, setError] = createSignal("")
  const [text, setText] = createSignal("")
  const [proposal, setProposal] = createSignal<Proposal>()
  const [previous, setPrevious] = createSignal(props.previous)
  const [ideas, setIdeas] = createSignal<Opportunity[]>([])
  const [editing, setEditing] = createSignal(false)
  const scope = { directory, workspace }
  const options = { throwOnError: true as const, signal: controller.signal }

  function valid() {
    return !controller.signal.aborted && same()
  }
  function current() {
    const current = route.data.type === "session" ? route.data.sessionID : undefined
    return current === session && project.workspace.current() === workspace && (project.instance.directory() || sdk.directory) === directory
  }
  function same() {
    return current() && (!initial || (prompt?.current === initial && JSON.stringify(unwrap(initial.current)) === JSON.stringify(draft)))
  }

  function report(err: unknown) {
    if (controller.signal.aborted || !current()) return
    setError(err instanceof Error ? err.message : typeof err === "object" && err && "message" in err ? String(err.message) : JSON.stringify(err))
  }

  async function enhance(value: string, answers?: string) {
    if (!valid()) throw new Error("The draft changed. Close and reopen Forge before preparing it.")
    setBusy(true)
    setError("")
    const result = await sdk.client.forge.enhance({ ...scope, text: value, answers, session }, options)
    if (!valid()) return
    if (proposal()) setPrevious(proposal())
    setProposal(result.data)
    setText(result.data.prompt)
    setIdeas([])
    setBusy(false)
  }

  function map() {
    if (controller.signal.aborted || !current()) return
    setMapped(true)
  }

  async function accept() {
    const value = proposal()
    if (!value || busy() || value.status !== "ready") return
    if (!initial || !draft) throw new Error("No chat input is available. Close this review and open Forge from a chat.")
    if (!valid()) throw new Error("The draft changed while Forge was preparing it. Close this review and enhance the current draft.")
    setBusy(true)
    const result = await sdk.client.forge.validate({ ...value, ...scope }, options)
    if (!result.data.valid) throw new Error("Supporting files changed. Regenerate this proposal before running it.")
    if (!valid()) throw new Error("The draft changed during validation. Close this review and enhance the current draft.")
    initial.set(prepared(draft, text(), value.context.text, value.id))
    dialog.clear()
    initial.submit()
  }

  async function edit(clarify: boolean) {
    if (controller.signal.aborted || !current()) return
    if (!clarify && !initial) throw new Error("No chat input is available. Close this review and open Forge from a chat.")
    setEditing(true)
    const value = await DialogPrompt.show(dialog, clarify ? "Clarify the task" : "Edit the prepared task", { value: clarify ? "" : text() })
    if (value == null) return
    if (!same()) {
      await DialogAlert.show(dialog, "Draft changed", "The draft, attachments, or session changed while editing. Your current draft was left untouched. Reopen Forge to prepare it again.")
      return
    }
    // Return edits to the ordinary composer so the developer can review and submit them explicitly.
    if (clarify) {
      const previous = proposal()
      const answers = [props.answers, value].filter((item) => item?.trim()).join("\n\n")
      dialog.replace(() => <ForgeDialog command="enhance" text={previous?.original ?? input} previous={previous} answers={answers} />)
      return
    }
    if (initial && draft) initial.set(prepared(draft, value, proposal()?.context.text ?? "", proposal()?.id))
    dialog.clear()
    initial?.focus()
  }

  onMount(() => {
    dialog.setSize("large")
    initial?.blur()
    void (async () => {
      if (props.command === "enhance") {
        if (choosing()) return
        if (!input.trim()) { setText("Enter a draft, then use /enhance."); return }
        await enhance(input, props.answers)
        return
      }
      if (props.command === "ideas") {
        const result = await sdk.client.forge.ideas({ ...scope, goal: input }, options)
        if (!valid()) return
        setIdeas(result.data)
        setText(result.data.length ? "Select an opportunity to prepare a task. Suggestions remain hypotheses until verified." : "No supported opportunities were found. Try a more specific development goal.")
        return
      }
    })().catch(report).finally(() => setBusy(false))
  })
  createEffect(() => {
    if (current()) return
    // Aborting transport alone does not invalidate an already resolved response or visible review.
    controller.abort()
    setProposal(undefined)
    setPrevious(undefined)
    setIdeas([])
    setText("")
    setBusy(false)
    setChoosing(false)
    setManaging(false)
    setError("Workspace or session changed. Reopen Forge to prepare the current draft.")
  })
  onCleanup(() => { controller.abort(); if (!editing()) initial?.focus() })
  navigation(() => dialog.clear(), () => !editing() && !choosing() && !mapped())
  useBindings(() => ({
    enabled: !busy() && !editing() && !choosing() && !mapped(),
    priority: 1,
    bindings: [
      { key: "a", desc: "Accept prepared task", group: "Forge Review", cmd: () => { void accept().catch(report).finally(() => setBusy(false)) } },
      { key: "e", desc: "Edit prepared task", group: "Forge Review", cmd: () => { if (proposal()) void edit(false).catch(report) } },
      { key: "c", desc: "Clarify task", group: "Forge Review", cmd: () => { if (proposal()) void edit(true).catch(report) } },
      { key: "m", desc: "Open terminal map", group: "Forge Review", cmd: map },
      { key: "r", desc: "Close review", group: "Forge Review", cmd: () => dialog.clear() },
      ...["1", "2", "3"].map((key) => ({ key, desc: `Prepare opportunity ${key}`, group: "Forge Review", cmd: () => {
        const idea = ideas().at(Number(key) - 1)
        if (idea) void enhance(idea.prompt).catch(report).finally(() => setBusy(false))
      } })),
    ],
  }))

  // A stable renderable root prevents view changes from recreating this review and rerunning preparation.
  return <box><Show when={!mapped()} fallback={<ForgeKnowledge command="map" back={() => { setMapped(false); dialog.setSize("large"); initial?.blur() }} />}><box><Show when={!choosing()} fallback={
    <Show when={!managing()} fallback={<ForgeLibrary scope={{ ...scope, session: session ?? "" }} back={() => setManaging(false)} />}>
      <ForgeAttachments parts={draft?.parts ?? []} scope={{ ...scope, session }} valid={valid} library={() => setManaging(true)} proceed={() => {
        setChoosing(false)
        if (!input.trim()) { setText("Enter a draft, then use /enhance."); return }
        void enhance(input, props.answers).catch(report).finally(() => setBusy(false))
      }} />
    </Show>
  }><box padding={1} gap={1}>
    <text fg={theme.primary}>Forge · {props.command}</text>
    <Show when={busy()}><Spinner>Gathering and checking repository evidence…</Spinner></Show>
    <Show when={error()}><text fg={theme.error}>{error()}</text></Show>
    <scrollbox height={20}>
      <Show when={proposal()}>{(value) => <>
        <For each={details(value().context)}>{(line) => <text fg={theme.textMuted}>{line}</text>}</For>
        <For each={compare(value().context, previous()?.context)}>{(line) => <text fg={theme.textMuted}>{line}</text>}</For>
        <For each={value().warnings}>{(line) => <text fg={theme.warning}>{line}</text>}</For>
      </>}</Show>
      <Show when={proposal()}><text fg={theme.textMuted}>Original request: {proposal()!.original}{"\n\n"}</text></Show>
      <text fg={theme.text}>{text()}</text>
      <For each={ideas()}>{(idea, index) => <box marginTop={1}>
        <text fg={theme.primary} onMouseUp={() => { void enhance(idea.prompt).catch(report).finally(() => setBusy(false)) }}>[{index() + 1}] {idea.title}</text>
        <text>{idea.benefit}{"\n"}Evidence: {idea.evidence.join(", ")}{"\n"}Uncertainty: {idea.uncertainty}{"\n"}Verify: {idea.verification}</text>
        <text fg={theme.textMuted} onMouseUp={() => { void sdk.client.forge.decide({ ...scope, id: idea.id, status: "rejected" }, options).then(() => { if (valid()) setIdeas((values) => values.filter((value) => value.id !== idea.id)) }).catch(report) }}>Dismiss suggestion</text>
      </box>}</For>
      <Show when={proposal()}><text fg={theme.textMuted}>{"\n\n"}Supporting evidence ({proposal()!.context.estimator}):{"\n"}{proposal()!.context.text}</text></Show>
      <For each={proposal()?.context.matches}>{(match) => <text fg={theme.textMuted}>Selected version: {match.source.id} @ {match.source.hash}</text>}</For>
    </scrollbox>
    <Show when={proposal()}>
      <Show when={initial} fallback={<text fg={theme.textMuted}>No chat input is available. Open Forge from a chat to edit or run this proposal.</text>}>
        <text fg={theme.primary} onMouseUp={() => { void accept().catch(report).finally(() => setBusy(false)) }}>{proposal()!.status === "ready" ? "[a] Accept and run" : "Answer the open questions before running"}</text>
        <text fg={theme.text} onMouseUp={() => { void edit(false).catch(report) }}>[e] Edit in composer</text>
      </Show>
      <text fg={theme.text} onMouseUp={() => { void edit(true).catch(report) }}>[c] Clarify</text>
    </Show>
    <text fg={theme.textMuted} onMouseUp={map}>[m] Source map (terminal)</text>
    <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>[r] Reject / close · Esc / Backspace closes without running</text>
  </box></Show></box></Show></box>
}
