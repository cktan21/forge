import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, useContext } from "solid-js"
import { unwrap } from "solid-js/store"
import { useTerminalDimensions } from "@opentui/solid"
import type { ScrollBoxRenderable } from "@opentui/core"
import { createKiloClient } from "@kilocode/sdk/v2"
import { InvestigationFrame, Investigation, recoverable, type Observation, type Round } from "@kilocode/forge/investigation"
import { Prepared } from "@kilocode/forge/writing"
import type { EnhancementModel } from "@kilocode/forge/schema"
import { decode } from "@kilocode/forge/schema"
import { diagnostic, EnhancementError, failure as failed } from "@kilocode/forge/enhancement"
import { reference } from "@kilocode/forge/handoff"
import { notice, updates } from "@kilocode/forge/updates"
import { replies, visible } from "@kilocode/forge/clarification"
import { useSDK } from "../../context/sdk"
import { useProject } from "../../context/project"
import { useRoute } from "../../context/route"
import { useTheme } from "../../context/theme"
import { PromptRefContext } from "../../context/prompt"
import { useBindings } from "../../keymap"
import { useDialog } from "../../ui/dialog"
import { ForgeEnhance } from "./enhance"
import { ForgeField } from "./field"
import { ForgeModel } from "./provider"
import { ForgeAttachments } from "./attachments"
import { ForgeLibrary } from "./library"
import { attachments } from "./attachment"
import { prepared, requirements } from "./draft"
import { attach } from "./handoff"
import { ForgeTurns } from "./turns"
import { progress } from "./progress"
import { operation } from "./operation"
import { ForgeQuestions } from "./questions"
import { responses, transcript, type Answer } from "./conversation"

type Props = Parameters<typeof ForgeEnhance>[0]
type Phase = "input" | "findings" | "questions" | "retry" | "feedback" | "prompt" | "edit" | "sources" | "model"

export function ForgeWorkshop(props: Props) {
  const sdk = useSDK()
  const project = useProject()
  const route = useRoute()
  const dialog = useDialog()
  const [mode, setMode] = createSignal<"loading" | "legacy" | "investigate" | "failed">(props.previous ? "legacy" : "loading")
  const [error, setError] = createSignal("")
  const controller = new AbortController()
  onCleanup(() => controller.abort())
  async function load() {
    if (props.previous || typeof sdk.client.forge.investigationStatus !== "function") { setMode("legacy"); return }
    try {
      const result = await sdk.client.forge.investigationStatus({
        directory: project.instance.directory() || sdk.directory, workspace: project.workspace.current(),
        session: route.data.type === "session" ? route.data.sessionID : undefined,
      }, { signal: controller.signal, throwOnError: true })
      if (!controller.signal.aborted) setMode(result.data.enabled ? "investigate" : "legacy")
    } catch {
      if (controller.signal.aborted) return
      setError("Could not read the workshop capability. Retry, or explicitly choose the legacy rewrite.")
      setMode("failed")
    }
  }
  onMount(() => { void load() })
  // A stable terminal root prevents capability transitions from remounting the dialog.
  return <box><Show when={mode() !== "legacy"} fallback={<ForgeEnhance {...props} />}>
    <Show when={mode() === "investigate"} fallback={<box padding={1} gap={1}>
      <text>{mode() === "failed" ? error() : "Checking investigative enhancement..."}</text>
      <Show when={mode() === "failed"}>
        <text onMouseUp={() => { void load() }}>[Retry]</text>
        <text onMouseUp={() => setMode("legacy")}>[Use legacy rewrite]</text>
      </Show>
      <text onMouseUp={() => dialog.clear()}>[Close]</text>
    </box>}>
      <Workshop {...props} />
    </Show>
  </Show></box>
}

function Workshop(props: Props) {
  const sdk = useSDK()
  const project = useProject()
  const route = useRoute()
  const dialog = useDialog()
  const prompt = useContext(PromptRefContext)
  const initial = prompt?.current
  const draft = initial ? structuredClone(unwrap(initial.current)) : undefined
  const scope = { directory: project.instance.directory() || sdk.directory, workspace: project.workspace.current(), session: route.data.type === "session" ? route.data.sessionID : "" }
  const seed = (draft && (props.text == null || props.text === draft.input) ? requirements(draft) : props.text ?? "").replace(/^\/enhance(?:\s+|$)/, "")
  const selectedModel = useContext(ForgeModel)
  const [model, setModel] = createSignal(selectedModel?.() ?? "")
  const [, setOriginal] = createSignal(seed)
  const [input, setInput] = createSignal(seed)
  const [feedback, setFeedback] = createSignal("")
  const [history, setHistory] = createSignal(props.answers ?? "")
  const [submitted, setSubmitted] = createSignal("")
  const settled = createMemo(() => replies(history()))
  const [values, setValues] = createSignal<Record<string, Answer>>({})
  const [phase, setPhase] = createSignal<Phase>("input")
  const [record, setRecord] = createSignal<Investigation>()
  const questions = createMemo(() => visible(record()?.questions ?? [], values()))
  const [journal, setJournal] = createSignal<readonly Round[]>([])
  const [observations, setObservations] = createSignal<readonly Observation[]>([])
  const [recover, setRecover] = createSignal<Investigation>()
  const [clock, setClock] = createSignal(Date.now())
  const [access, setAccess] = createSignal<"verified" | "unknown">("verified")
  const [attempt, setAttempt] = createSignal<string>()
  const [tracing, setTracing] = createSignal(false)
  const [reported, setReported] = createSignal(model())
  const [ready, setReady] = createSignal<Prepared>()
  const [selected, setSelected] = createSignal<string[]>([])
  const [written, setWritten] = createSignal("")
  const [text, setText] = createSignal("")
  const [cursor, setCursor] = createSignal(0)
  const [invalid, setInvalid] = createSignal(false)
  const [choosing, setChoosing] = createSignal(false)
  const [library, setLibrary] = createSignal(false)
  const [expanded, setExpanded] = createSignal(false)
  const dimensions = useTerminalDimensions()
  const { theme } = useTheme()
  const controller = new AbortController()
  let scroll: ScrollBoxRenderable | undefined
  const clarification = () => record()?.state !== "findings_ready"
    || !record()?.findings.some((item) => item.support !== "contradicted")
  const primary = () => phase() === "prompt" ? "Enter / [a] Use prompt (stage only)"
    : recover() ? "Enter / [i] Retry suggestions (saved evidence, model call)"
    : phase() === "retry" ? "Enter / [i] Retry with saved answers (model calls)"
    : clarification() && record()?.questions.length ? "Enter / [c] Answer questions"
    : clarification() ? "Enter / [i] Continue assessment with saved answers (model calls)"
    : selected().length ? "Enter / [w] Write prompt (model call)" : "Enter / Space Select highlighted finding"
  const signature = () => JSON.stringify([record()?.id, selected(), feedback(), history(), values(), model()])
  const same = () => !controller.signal.aborted && !invalid()
    && (project.instance.directory() || sdk.directory) === scope.directory && project.workspace.current() === scope.workspace
    && (route.data.type === "session" ? route.data.sessionID : "") === scope.session
    && (!initial || prompt?.current === initial && JSON.stringify(initial.current) === JSON.stringify(draft))
  const current = (signal: AbortSignal) => same() && !signal.aborted
  const task = operation({
    signal: controller.signal, valid: same,
    cancelled: () => setJournal((items) => items.map((item) =>
      item.state === "model" || item.state === "tools"
        ? { ...item, state: "cancelled", summary: "Cancelled locally; late work is not accepted." } : item)),
  })
  const busy = task.busy
  const status = task.status
  const error = task.error
  const setError = task.setError
  const run = task.run

  async function client() {
    return sdk.url === "http://kilo.internal" && sdk.browser
      ? createKiloClient({ baseUrl: await sdk.browser(), directory: sdk.directory, headers: sdk.headers })
      : sdk.client
  }
  function referenceModel(): EnhancementModel | undefined {
    const split = model().indexOf("/")
    if (split < 1 || split === model().length - 1) return undefined
    return { providerID: model().slice(0, split), modelID: model().slice(split + 1) }
  }
  function answer(id: string, value: Answer) {
    setValues((items) => {
      const next = { ...items, [id]: value }
      if (JSON.stringify(items[id]) === JSON.stringify(value)) return next
      const changed = new Set([id])
      for (const question of record()?.questions ?? []) {
        if (!question.when || !changed.has(question.when.question)) continue
        changed.add(question.id)
        delete next[question.id]
      }
      return next
    })
  }
  function investigate(resume = false) {
    return run("Understanding the request and inspecting repository evidence", async (signal) => {
      const model = referenceModel()
      if (!model) { setPhase("model"); throw new Error("Choose a provider/model before starting investigation.") }
      if (!input().trim()) throw new Error("Describe the request to investigate.")
      const controls = questions().filter((item) => {
        const answer = values()[item.id]
        return !!(answer?.option || answer?.comment?.trim() || item.optional && answer?.skipped)
      })
      const answers = controls.length
        ? transcript([history(), `Clarification responses:\n${responses(controls, values())}`])
        : history()
      const api = await client()
      const value = input()
      const previous = ready()
      const retry = resume ? recover() : undefined
      if (resume && !retry) throw new Error("No retained investigation is available for conclusion recovery.")
      const key = crypto.randomUUID()
      setReported(`${model.providerID}/${model.modelID}`)
      setAttempt(key)
      setJournal([])
      setObservations([])
      setRecover(undefined)
      setClock(Date.now())
      if (controls.length) {
        setSubmitted(answers)
        setPhase("retry")
      }
      let result: Investigation | undefined
      let failure: unknown
      const response = await api.forge.investigateStream({
        ...scope, key, text: value, answers: answers || undefined, feedback: feedback() || undefined, model,
        previous: previous ? { id: previous.id, revision: previous.revision, session: previous.session } : undefined,
        resume: retry ? { id: retry.id, revision: retry.revision } : undefined,
      }, { signal, throwOnError: true, sseMaxRetryAttempts: 0, onSseError: (err) => { failure = err } })
      for await (const event of response.stream) {
        if (!current(signal)) return
        const frame = decode(InvestigationFrame, event)
        if (frame.type === "error") {
          if (["schema", "json", "cutoff"].includes(frame.failure?.code ?? "")) {
            const saved = await api.forge.investigation({ ...scope, id: key }, { signal, throwOnError: true })
              .then((value) => decode(Investigation, value.data), () => undefined)
            if (current(signal) && saved?.id === key && saved.original === value && saved.session === scope.session) {
              setRecover(saved)
              setJournal(saved.journal ?? [])
              setObservations(saved.observations)
            }
          }
          throw new EnhancementError(frame.message, frame.failure ?? failed("transport"))
        }
        if (frame.type === "result") { result = frame.investigation; break }
        if (frame.journal) setJournal(frame.journal)
        if (frame.observations) setObservations(frame.observations)
        setClock(Date.now())
        const turn = frame.journal?.at(-1)
        const label = turn ? progress(turn, (frame.observations ?? observations()).flatMap((item) => item.sources)) : frame.stage
        task.update(`${label}${frame.elapsed == null ? "" : ` (${Math.floor(frame.elapsed / 1000)}s elapsed)`}`)
      }
      if (!current(signal)) return
      if (!result) throw failure ?? new Error("Investigation ended without validated findings. Retry explicitly.")
      if (result.original !== value || result.session !== scope.session) throw new Error("Investigation response belongs to another request")
      setOriginal(value)
      setHistory(answers)
      setSubmitted("")
      setValues({})
      setRecord(result)
      setRecover(recoverable(result) ? result : undefined)
      setAccess("verified")
      setJournal(result.journal ?? [])
      setObservations(result.observations)
      setSelected([])
      setReady(undefined)
      setCursor(0)
      setExpanded(false)
      setPhase(result.state === "needs_input" && result.questions.length ? "questions" : "findings")
    })
  }
  function toggle(index = cursor()) {
    const item = record()?.findings.at(index)
    if (!item || item.support === "contradicted") return
    setSelected((values) => values.includes(item.id) ? values.filter((key) => key !== item.id) : [...values, item.id])
  }
  function clarify() {
    setError("")
    setPhase(record()?.questions.length ? "questions" : "feedback")
  }
  function proceed() {
    if (phase() === "retry") { void investigate(!!recover()); return }
    if (phase() === "prompt") { void accept(); return }
    if (phase() === "sources") { setPhase(ready() ? "prompt" : "findings"); return }
    if (clarification()) {
      if (!recover() && record()?.questions.length) { clarify(); return }
      void investigate(!!recover())
      return
    }
    if (selected().length) { void write(); return }
    const item = record()?.findings.at(cursor())
    if (!item || item.support === "contradicted") {
      setError("This finding cannot be selected. Choose another finding or give feedback.")
      return
    }
    toggle()
  }
  function move(offset: number) {
    if (phase() !== "findings") { scroll?.scrollBy(offset); return }
    const index = Math.max(0, Math.min((record()?.findings.length ?? 1) - 1, cursor() + offset))
    setCursor(index)
    const item = scroll?.getChildren().find((item) => item.id === `forge-finding-${index}`)
    if (item && scroll) scroll.scrollBy(item.y - scroll.viewport.y)
  }
  function write() {
    if (record()?.state === "needs_input" && record()?.questions.length) { clarify(); return Promise.resolve() }
    return run("Writing the implementation prompt from your selected findings", async (signal) => {
      if (access() !== "verified") throw new Error("Recheck evidence access before writing a prompt.")
      const item = record()
      if (!item || item.state !== "findings_ready") throw new Error("Get valid suggestions before writing a prompt.")
      if (Object.keys(values()).length) throw new Error("Investigate with your pending answers before writing a prompt.")
      const model = referenceModel()
      if (!model || model.providerID !== item.model.providerID || model.modelID !== item.model.modelID) throw new Error("Investigate with the selected model before writing a new prompt.")
      if (!selected().length) throw new Error("Select a finding or diagnostic direction first.")
      const revision = signature()
      const api = await client()
      const previous = ready()
      const chosen = (await api.forge.chooseDirection({
        ...scope, key: crypto.randomUUID(), investigation: item.id, revision: item.revision, selected: selected(), feedback: feedback() || undefined,
        previous: previous ? { id: previous.id, revision: previous.revision, session: previous.session } : undefined,
      }, { signal, throwOnError: true })).data
      if (!current(signal)) return
      const result = (await api.forge.writePrompt({
        ...scope, id: chosen.id, revision: chosen.revision, key: crypto.randomUUID(),
      }, { signal, throwOnError: true })).data
      if (!current(signal)) return
      setReady(decode(Prepared, result))
      setText(result.prompt)
      setWritten(revision)
      setPhase("prompt")
    })
  }
  function edit() {
    return run("Saving your edits with their source dependencies", async (signal) => {
      const item = ready()
      if (!item) return
      const result = (await (await client()).forge.editPrompt({
        ...scope, session: item.session, id: item.id, revision: item.revision, text: text(),
      }, { signal, throwOnError: true })).data
      if (!current(signal)) return
      setReady(decode(Prepared, result))
      setText(result.prompt)
      setPhase("prompt")
    })
  }
  function accept() {
    return run("Rechecking evidence before staging the prompt", async (signal) => {
      if (access() !== "verified") throw new Error("Recheck evidence access before staging a prompt.")
      const item = ready()
      if (!item || !initial || !draft) throw new Error("Open the workshop from a chat composer to stage this prompt.")
      if (signature() !== written()) throw new Error("Your direction or feedback changed. Write an updated prompt before using it.")
      const api = await client()
      const checked = (await api.forge.preparedPrompt({ ...scope, session: item.session, id: item.id }, { signal, throwOnError: true })).data
      if (checked.revision !== item.revision || checked.state !== "ready") throw new Error("Prepared prompt changed. Review its current revision.")
      const next = prepared(draft, checked.prompt, undefined)
      const value = next.input === checked.prompt ? checked : (await api.forge.editPrompt({
        ...scope, session: item.session, id: checked.id, revision: checked.revision, text: next.input,
      }, { signal, throwOnError: true })).data
      if (!current(signal)) return
      initial.set(attach(next, { id: value.id, revision: value.revision, hash: value.hash, session: value.session }))
      dialog.clear()
    })
  }
  async function revalidate(signal = controller.signal) {
      const item = ready()
      const investigation = record()
      if (attempt() && attempt() !== investigation?.id) await sdk.client.forge.investigation({ ...scope, id: attempt()! }, { signal, throwOnError: true })
      if (item) await sdk.client.forge.preparedPrompt({ ...scope, session: item.session, id: item.id }, { signal, throwOnError: true })
      else if (investigation) await sdk.client.forge.investigation({ ...scope, id: investigation.id }, { signal, throwOnError: true })
      if (current(signal)) setAccess("verified")
  }
  const refresh = updates({
    signal: controller.signal,
    load: async () => {
      if (!busy() && same()) await revalidate()
    },
    error: (err) => {
      const value = err != null && typeof err === "object" ? err : undefined
      const failure = diagnostic(value && Reflect.get(value, "failure"))
      if (err instanceof TypeError || failure?.reason === "network" || failure?.reason === "unavailable") {
        setAccess("unknown")
        setError("Evidence access could not be checked. Your input was kept; recheck access before continuing.")
        return
      }
      setRecord(undefined); setReady(undefined); setSelected([]); setText(""); setPhase("input")
      setJournal([]); setObservations([]); setAttempt(undefined); setTracing(false)
      setRecover(undefined)
      setError("Evidence or access changed. Generated content is unavailable until you investigate again.")
    },
  })
  onMount(() => {
    dialog.setSize("large")
    initial?.blur()
    const off = sdk.event.on("event", (event) => { if (notice(event, scope, true)) refresh() })
    onCleanup(off)
    void run("Opening the workshop", async (signal) => {
      const binding = reference(draft?.parts ?? [])
      if (binding) {
        const api = await client()
        const item = (await api.forge.preparedPrompt({ ...scope, session: binding.session ?? scope.session, id: binding.id }, { signal, throwOnError: true })).data
        const investigation = (await api.forge.investigation({ ...scope, session: item.scope, id: item.investigation }, { signal, throwOnError: true })).data
        if (!current(signal)) return
        setRecord(decode(Investigation, investigation)); setReady(decode(Prepared, item)); setSelected(item.findings.map((item) => item.id))
        setJournal(investigation.journal ?? []); setObservations(investigation.observations)
        setReported(`${investigation.model.providerID}/${investigation.model.modelID}`)
        setHistory(investigation.answers)
        setFeedback(item.requirements.find((item) => item.label === "User direction feedback")?.text ?? investigation.feedback)
        setOriginal(investigation.original); setInput(investigation.original); setText(item.prompt)
        setWritten(signature()); setPhase("prompt")
        return
      }
      if (attachments(draft?.parts ?? []).some((item) => item.registration)) { setChoosing(true); return }
    }).then(() => {
      if (!choosing() && !ready() && same() && !error() && props.text?.match(/^\/enhance\s+\S/)) void investigate()
    })
  })
  createEffect(() => {
    project.instance.directory(); project.workspace.current(); route.data
    if (same()) return
    setInvalid(true)
    setJournal([]); setObservations([]); setTracing(false)
    task.cancel()
  })
  onCleanup(() => { controller.abort(); task.cancel(); if (prompt?.current === initial) initial?.focus() })
  useBindings(() => ({
    enabled: !choosing() && !library(), priority: 2,
    bindings: [
      { key: "ctrl+c", group: "Forge Investigation", desc: "Close without submitting", cmd: () => dialog.clear() },
      { key: "escape", group: "Forge Investigation", desc: "Cancel or go back", cmd: () => {
        if (busy()) { task.cancel(); return }
        if (tracing()) { setTracing(false); return }
        if (phase() === "sources") { setPhase(ready() ? "prompt" : "findings"); return }
        dialog.clear()
      } },
      { key: "ctrl+t", group: "Forge Investigation", desc: "Toggle turn history", cmd: () => setTracing((value) => !value) },
      ...(!busy() && !tracing() && !invalid() && (recover() || access() === "unknown") ? [
        { key: "ctrl+r", group: "Forge Investigation", desc: "Recheck access or retry the conclusion", cmd: () => {
          if (access() === "unknown") { void run("Rechecking evidence access", revalidate); return }
          void investigate(true)
        } },
      ] : []),
      ...(!invalid() && (tracing() || busy() || ["findings", "questions", "retry", "prompt", "sources"].includes(phase())) ? [
        { key: "t", group: "Forge Investigation", desc: "Toggle turn history", cmd: () => setTracing((value) => !value) },
      ] : []),
      ...(!busy() && !tracing() && !invalid() && ["findings", "retry", "prompt", "sources"].includes(phase()) ? [
        { key: "pageup", group: "Forge Investigation", desc: "Scroll review up", cmd: () => scroll?.scrollBy(-10) },
        { key: "pagedown", group: "Forge Investigation", desc: "Scroll review down", cmd: () => scroll?.scrollBy(10) },
      ] : []),
      ...(!busy() && !tracing() && !invalid() && phase() === "retry" ? [
        { key: "return", group: "Forge Investigation", desc: "Retry with saved answers", cmd: proceed },
        { key: "i", group: "Forge Investigation", desc: "Retry with saved answers", cmd: proceed },
        { key: "c", group: "Forge Investigation", desc: "Edit saved answers", cmd: clarify },
        { key: "f", group: "Forge Investigation", desc: "Refine the request", cmd: () => setPhase("feedback") },
      ] : []),
      ...(!busy() && !tracing() && !invalid() && ["findings", "prompt", "sources"].includes(phase()) ? [
        { key: "return", group: "Forge Investigation", desc: "Continue workshop", cmd: proceed },
        { key: "up", group: "Forge Investigation", desc: "Previous finding or scroll up", cmd: () => move(-1) },
        { key: "down", group: "Forge Investigation", desc: "Next finding or scroll down", cmd: () => move(1) },
        { key: "space", group: "Forge Investigation", desc: "Select direction", cmd: () => { if (phase() === "findings") toggle() } },
        { key: "w", group: "Forge Investigation", desc: "Write from selected findings", cmd: () => { void write() } },
        { key: "c", group: "Forge Investigation", desc: "Give feedback or answer questions", cmd: clarify },
        { key: "f", group: "Forge Investigation", desc: "Give general feedback", cmd: () => setPhase("feedback") },
        { key: "d", group: "Forge Investigation", desc: "Toggle finding details", cmd: () => setExpanded((value) => !value) },
        { key: "s", group: "Forge Investigation", desc: "Inspect sources and activity", cmd: () => { refresh(); setPhase("sources") } },
        { key: "i", group: "Forge Investigation", desc: "Continue assessment or recover suggestions", cmd: () => { void investigate(!!recover()) } },
        { key: "e", group: "Forge Investigation", desc: "Edit prompt", cmd: () => { if (ready()) setPhase("edit") } },
        { key: "a", group: "Forge Investigation", desc: "Stage prompt without sending", cmd: () => { if (phase() === "prompt") void accept() } },
        { key: "v", group: "Forge Investigation", desc: "Choose model", cmd: () => setPhase("model") },
      ] : []),
    ],
  }))
  return <Show when={!library()} fallback={<ForgeLibrary scope={scope} back={() => setLibrary(false)} />}>
    <Show when={!choosing()} fallback={<ForgeAttachments parts={draft?.parts ?? []} scope={scope} valid={same}
      back={() => { setChoosing(false); setPhase("input") }} library={() => setLibrary(true)}
      proceed={() => { setChoosing(false); void investigate() }} />}>
      <box padding={1} gap={1} height={Math.max(12, dimensions().height - 3)}>
        <box flexShrink={0}>
          <text fg={theme.primary}>Forge /enhance: Prepare your prompt</text>
          <text fg={theme.textMuted}>No code changes or tests. The finished prompt goes back to chat.</text>
        </box>
        <Show when={invalid()}><text fg={theme.error}>Workspace, session, or composer changed. Close and reopen; your current draft was preserved.</text></Show>
        <Show when={error()}><text fg={theme.error}>{error()}</text></Show>
        <Show when={task.failure()}>{(failure) => <text fg={theme.textMuted}>
          Failure: {failure().code}{failure().stage ? ` during ${failure().stage}` : ""}{failure().reason ? ` (${failure().reason})` : ""}
        </text>}</Show>
        <Show when={busy()}><text>{status()} | Esc cancels; no automatic retry</text></Show>
        <Show when={!busy() && access() === "unknown"}>
          <text onMouseUp={() => { void run("Rechecking evidence access", revalidate) }}>[Ctrl+R] Recheck evidence access</text>
        </Show>
        <Show when={!busy() && !invalid() && recover()}>
          <text fg={theme.primary} onMouseUp={() => { void investigate(true) }}>[Ctrl+R] Retry conclusion only: revalidate and reuse recorded evidence</text>
        </Show>
        <Show when={!invalid() && access() === "verified" && (tracing() || busy() && journal().length > 0)}>
          <ForgeTurns journal={journal()} observations={observations()} findings={!attempt() || attempt() === record()?.id ? record()?.findings : []} model={reported()} now={busy() ? clock() : undefined} height={dimensions().height - 15} />
        </Show>
        <Show when={!busy() && !invalid() && !tracing() && (journal().length || observations().length)}>
          <text flexShrink={0} fg={theme.primary} onMouseUp={() => setTracing(true)}>[t / Ctrl+T] Turn history: model updates, tools and resources</text>
        </Show>
        <Show when={!busy() && !invalid() && !tracing() && access() === "verified"}>
          <Show when={phase() === "input"}>
            <text fg={theme.textMuted}>Model: {model() || "not selected"}</text>
            <ForgeField title="What should the agent investigate? Enter starts model calls." value={input()} change={setInput}
              submit={(value) => { setInput(value); void investigate() }} back={() => dialog.clear()} />
          </Show>
          <Show when={phase() === "model"}><ForgeField title="Model: provider/model. Changing it does not start a request." value={model()} change={setModel}
            submit={(value) => { setModel(value); setPhase("input") }} back={() => setPhase("input")} /></Show>
          <Show when={phase() === "input" && ready()}><text onMouseUp={() => setPhase("prompt")}>[Review previous prompt without regenerating]</text></Show>
          <Show when={phase() === "questions"}>
            <ForgeQuestions questions={record()?.questions ?? []} values={values()} step={settled().length + 1}
              context={(settled().at(-1)?.option || settled().at(-1)?.comment || "").replace(/\s+/g, " ").slice(0, 240)}
              change={answer}
              submit={() => { void investigate() }} back={() => { setError(""); setPhase("findings") }} />
          </Show>
          <Show when={phase() === "retry"}>
            <text fg={theme.primary}>Your answers were kept. The next step did not complete.</text>
            <scrollbox ref={(value: ScrollBoxRenderable) => { scroll = value }} flexGrow={1} flexShrink={1} flexBasis={0} minHeight={1}>
              <For each={replies(submitted())}>{(reply) => <box marginBottom={1}>
                <text>{reply.question}</text>
                <text fg={theme.textMuted}>{reply.option || reply.comment || "Skipped optional question"}</text>
                <Show when={reply.option && reply.comment}><text fg={theme.textMuted}>{reply.comment}</text></Show>
              </box>}</For>
            </scrollbox>
            <text fg={theme.primary} onMouseUp={proceed}>{primary()}</text>
            <text fg={theme.textMuted}>c Edit answers | f Refine request | t Turn history | Esc Close</text>
          </Show>
          <Show when={phase() === "feedback"}>
            <ForgeField title="Your answers or feedback. Enter investigates again (model calls)." value={feedback()} change={setFeedback}
              submit={(value) => {
                setFeedback(value)
                if (!value.trim()) { setError("Enter an answer or feedback, or press Esc to return."); return }
                void investigate()
              }} back={() => { setError(""); setPhase("findings") }} />
          </Show>
          <Show when={phase() === "edit"}><ForgeField title="Edit the implementation prompt; provenance remains attached." value={text()} change={setText}
            submit={(value) => { setText(value); void edit() }} back={() => setPhase("prompt")} /></Show>
          <Show when={phase() === "findings"}>
            <text flexShrink={0} fg={theme.primary}>{record()?.state === "needs_input" && record()?.questions.length
              ? "Clarification needed before a prompt can be written."
              : recover() ? "The model's suggestions could not be validated. Your answers were kept."
              : clarification() ? "No actionable improvements were identified in this assessment."
              : `Choose what to include in your prompt. ${selected().length} selected.`}</text>
            <scrollbox ref={(value: ScrollBoxRenderable) => { scroll = value }} flexGrow={1} flexShrink={1} flexBasis={0} minHeight={1}>
              <For each={settled()}>{(reply) => <text fg={theme.textMuted}>
                Answered: {reply.question} {reply.option || reply.comment || "Skipped optional question"}
              </text>}</For>
              <For each={questions()}>{(item) => <box marginBottom={1}>
                <text fg={theme.primary}>{item.optional ? "Optional question" : "Question"}: {item.question}</text>
                <text onMouseUp={clarify}>[c] Select an answer or write your own</text>
                <Show when={expanded()}><text fg={theme.textMuted}>{item.impact}</text></Show>
              </box>}</For>
              <Show when={!record()?.findings.length || record()?.state === "unstructured"}>
                <text>{recover() || record()?.state === "needs_input" && !record()?.questions.length
                  ? "Model response (not validated findings)" : "Assessment summary"}: {record()?.summary}</text>
              </Show>
              <Show when={expanded()}><text>Model: {model()}{"\n"}{record()?.intent}{"\n"}{record()?.summary}{"\n"}</text></Show>
              <For each={record()?.findings}>{(item, index) => <box id={`forge-finding-${index()}`} marginBottom={1} onMouseUp={() => { setCursor(index()); toggle(index()) }}>
                <text fg={cursor() === index() ? theme.primary : theme.text}>{selected().includes(item.id) ? "[x]" : "[ ]"} {item.title} ({item.kind}, {item.support})</text>
                <Show when={item.support === "unresolved"}><text fg={theme.textMuted}>Unverified direction. Investigate before choosing a fix.</text></Show>
                <text>{item.support === "unresolved" ? "Proposed work (verify first)" : "Next step"}: {item.action}</text>
                <Show when={expanded()}>
                  <text>{item.explanation}</text><text>Benefit: {item.benefit}</text>
                  <For each={item.unknowns}>{(value) => <text fg={theme.textMuted}>Unknown: {value}</text>}</For>
                  <For each={item.verification}>{(value) => <text>Verify: {value}</text>}</For>
                  <text fg={theme.textMuted}>Evidence: {item.evidence.join(", ") || "not established"} | Opposing evidence: {item.counterevidence.join(", ") || "none recorded"}</text>
                </Show>
              </box>}</For>
              <Show when={!record()?.findings.length}><text>No improvement candidates are available to select from this response.</text></Show>
              <Show when={expanded() || clarification()}><For each={record()?.limitations}>{(item) => <text fg={theme.textMuted}>{item}</text>}</For></Show>
            </scrollbox>
            <box flexShrink={0}>
              <text fg={theme.primary} onMouseUp={proceed}>{primary()}</text>
              <text>{record()?.questions.length ? "c Answer questions | f Feedback" : "Up/Down Move | Space Select | c Feedback"} | d {expanded() ? "Hide details" : "Details"}</text>
              <text fg={theme.textMuted}>PgUp/PgDn Scroll | s Sources | i Reinvestigate (model calls) | v Model | Esc Close</text>
            </box>
          </Show>
          <Show when={phase() === "prompt"}>
            <scrollbox ref={(value: ScrollBoxRenderable) => { scroll = value }} flexGrow={1} flexShrink={1} flexBasis={0} minHeight={1}>
              <text fg={theme.textMuted}>Prepared with {ready()?.model.providerID}/{ready()?.model.modelID}{"\n"}</text>
              <text>{ready()?.prompt}</text>
            </scrollbox>
            <box flexShrink={0}>
              <text fg={theme.primary} onMouseUp={proceed}>{primary()}</text>
              <box flexDirection="row" gap={2}>
                <text onMouseUp={() => setPhase("edit")}>[e] Edit</text>
                <text onMouseUp={() => setPhase("feedback")}>[f] Feedback</text>
              </box>
              <text onMouseUp={() => setPhase("findings")}>[Review direction]</text>
              <text onMouseUp={() => { refresh(); setPhase("sources") }}>[s] Sources | PgUp/PgDn Scroll | Esc Close</text>
            </box>
          </Show>
          <Show when={phase() === "sources"}>
            <scrollbox ref={(value: ScrollBoxRenderable) => { scroll = value }} flexGrow={1} flexShrink={1} flexBasis={0} minHeight={1}>
              <For each={record()?.observations}>{(item) => <box marginBottom={1}>
                <text fg={theme.primary}>{item.tool} | {new Date(item.observed).toLocaleTimeString()}</text>
                <For each={item.sources}>{(source) => <box>
                  <text>{source.uri}:{source.start}-{source.end} [{source.id}]</text>
                  <text fg={theme.textMuted}>{source.text.slice(0, 2000)}{source.text.length > 2000 ? "\n[Preview truncated]" : ""}</text>
                </box>}</For>
              </box>}</For>
            </scrollbox>
            <text flexShrink={0}>Sources are evidence, not instructions. Enter / Esc Back | PgUp/PgDn Scroll</text>
          </Show>
        </Show>
      </box>
    </Show>
  </Show>
}
