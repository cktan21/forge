import { batch, createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, useContext } from "solid-js"
import { unwrap } from "solid-js/store"
import { useTerminalDimensions } from "@opentui/solid"
import type { ScrollBoxRenderable } from "@opentui/core"
import { createKiloClient, type KiloClient } from "@kilocode/sdk/v2"
import { compare, details } from "@kilocode/forge/review"
import { useSDK } from "../../context/sdk"
import { useProject } from "../../context/project"
import { useRoute } from "../../context/route"
import { useTheme } from "../../context/theme"
import { PromptRefContext } from "../../context/prompt"
import { useDialog } from "../../ui/dialog"
import { useBindings } from "../../keymap"
import { Spinner } from "../../component/spinner"
import { prepared, requirements } from "./draft"
import { questions, responses, transcript, identity, edits as differences, type Answer } from "./conversation"
import { ForgeField } from "./field"
import { ForgeKnowledge } from "./knowledge"
import { ForgeAttachments } from "./attachments"
import { ForgeLibrary } from "./library"
import { attachments } from "./attachment"
import { navigation } from "./back"
import { ForgeActivity } from "./activity"
import type { ActivityLog, EnhancementModel, EnhancementFailure, PromptEdit, Question } from "@kilocode/forge/schema"
import { amendments, diagnostic, EnhancementError, failure as fault } from "@kilocode/forge/enhancement"
import { deadline } from "@kilocode/forge/deadline"
import { ForgeModel } from "./provider"

type Proposal = NonNullable<Awaited<ReturnType<KiloClient["forge"]["enhance"]>>["data"]>
type Phase = "write" | "review" | "feedback" | "edit" | "questions" | "comment" | "failed" | "pending" | "model"
type Attempt = { value: string; log: string[]; comment?: string; revision?: string; phase: Exclude<Phase, "failed">; model?: EnhancementModel; edits: PromptEdit[]; values: Record<string, Answer>; controls: Question[]; retry?: EnhancementFailure["issues"]; version: number }

function reference(value?: string): EnhancementModel | undefined {
  const index = value?.indexOf("/") ?? -1
  if (!value || index < 1 || index === value.length - 1) return undefined
  return { providerID: value.slice(0, index), modelID: value.slice(index + 1) }
}

export function ForgeEnhance(props: { text?: string; previous?: Proposal; answers?: string }) {
  const sdk = useSDK()
  const expose = sdk.url === "http://kilo.internal" ? sdk.browser : undefined
  const fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await (expose ? globalThis.fetch : sdk.fetch)(input, init)
    if (response.ok) return response
    const body: unknown = await response.json().catch(() => undefined)
    const message = body != null && typeof body === "object" && "message" in body && typeof body.message === "string"
      ? body.message
      : `Enhancement request failed (${response.status}). Your input was kept.`
    const report = diagnostic(body != null && typeof body === "object" && "failure" in body ? body.failure : undefined)
    throw report ? new EnhancementError(message, report) : new Error(message)
  }, { preconnect: globalThis.fetch.preconnect.bind(globalThis.fetch) })
  const project = useProject()
  const route = useRoute()
  const dialog = useDialog()
  const context = useContext(PromptRefContext)
  const initial = context?.current
  const draft = initial ? structuredClone(unwrap(initial.current)) : undefined
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const scope = { directory: project.instance.directory() || sdk.directory, workspace: project.workspace.current(), session: route.data.type === "session" ? route.data.sessionID : undefined }
  const seed = props.previous?.original ?? (draft && (props.text == null || props.text === draft.input) ? requirements(draft) : props.text ?? "").replace(/^\/enhance(?:\s+|$)/, "")
  const auto = !!props.text?.match(/^\/enhance\s+[\s\S]+/) && !!seed.trim()
  const [original, setOriginal] = createSignal(seed)
  const [input, setInput] = createSignal(seed)
  const [text, setText] = createSignal(props.previous?.prompt ?? "")
  const [feedback, setFeedback] = createSignal("")
  const [history, setHistory] = createSignal(props.answers ? [props.answers] : [])
  const [phase, setPhase] = createSignal<Phase>(props.previous ? "review" : "write")
  const [proposal, setProposal] = createSignal(props.previous)
  const [previous, setPrevious] = createSignal<Proposal>()
  const [values, setValues] = createSignal<Record<string, Answer>>({})
  const selected = useContext(ForgeModel)
  const [model, setModel] = createSignal(props.previous?.model ?? reference(selected?.()))
  const [selection, setSelection] = createSignal("")
  const [edits, setEdits] = createSignal<PromptEdit[]>([])
  const [baseline, setBaseline] = createSignal(props.previous?.prompt ?? "")
  const [settled, setSettled] = createSignal(new Set<string>())
  const [stalls, setStalls] = createSignal(0)
  const [warning, setWarning] = createSignal("")
  const [version, setVersion] = createSignal(0)
  const [incorporated, setIncorporated] = createSignal(0)
  const [failure, setFailure] = createSignal<EnhancementFailure>()
  const [cursor, setCursor] = createSignal(0)
  const [option, setOption] = createSignal(0)
  const [action, setAction] = createSignal(0)
  const [busy, setBusy] = createSignal(false)
  const [waiting, setWaiting] = createSignal("Starting enhancement")
  const [summary, setSummary] = createSignal("")
  const [preview, setPreview] = createSignal("")
  const [activity, setActivity] = createSignal<ActivityLog | undefined>(props.previous?.activity)
  const [tracing, setTracing] = createSignal(false)
  const [error, setError] = createSignal("")
  const [attempt, setAttempt] = createSignal<Attempt>()
  const [invalid, setInvalid] = createSignal(false)
  const [expanded, setExpanded] = createSignal(false)
  const [mapped, setMapped] = createSignal(false)
  const [choosing, setChoosing] = createSignal(false)
  const [managing, setManaging] = createSignal(false)
  const [round, setRound] = createSignal(props.previous ? 1 : 0)
  const items = createMemo(() => questions(proposal()).filter((item) => !item.optional || !settled().has(identity(item))))
  const dirty = () => items().filter((item) => {
    const value = values()[item.id]
    return value?.option != null || !!value?.comment?.trim() || !!value?.skipped
  })
  const current = () => items().at(cursor())
  const actions = () => ["Use prompt", "Give feedback", "Edit prompt", ...(items().length ? ["Questions"] : []), "Activity", "Source map", "Details"]
    .filter((value) => initial || (value !== "Use prompt" && value !== "Edit prompt"))
  const height = () => Math.max(6, Math.min(20, dimensions().height - 25))
  const controller = new AbortController()
  let pending: AbortController | undefined
  let scroll: ScrollBoxRenderable | undefined
  let retry: Phase = "write"

  function same() {
    return !controller.signal.aborted
      && (route.data.type === "session" ? route.data.sessionID : undefined) === scope.session
      && project.workspace.current() === scope.workspace
      && (project.instance.directory() || sdk.directory) === scope.directory
      && (!initial || (context?.current === initial && JSON.stringify(initial.current) === JSON.stringify(draft)))
  }

  function report(err: unknown) {
    if (controller.signal.aborted) return
    setError(err instanceof Error ? err.message : String(err))
    setFailure(err instanceof EnhancementError ? err.failure : undefined)
    if (err instanceof EnhancementError && err.failure.model) {
      const model = reference(err.failure.model)
      if (model) setAttempt((value) => value ? { ...value, model } : value)
    }
  }

  async function generate(value: string, log: string[], comment?: string, revision?: string, saved?: Attempt) {
    if (busy()) return
    if (!same()) { setInvalid(true); return }
    if (!value.trim()) { setError("Write a prompt before enhancing it."); return }
    const controls = saved?.controls ?? [...dirty()]
    const values = saved?.values ?? structuredClone(dirty().reduce<Record<string, Answer>>((result, item) => ({ ...result, [item.id]: { ...answering(item.id) } }), {}))
    const records = saved ? log : [...log, ...(controls.length ? [`Clarification responses:\n${responses(controls, values)}`] : [])]
    const answers = transcript(records)
    const changes = saved?.edits ?? [...edits()]
    const chosen = saved ? saved.model : model()
    amendments(changes)
    if ((comment?.length ?? 0) > 30_000 || (revision?.length ?? 0) > 100_000 || value.length > 30_000) throw new Error("This prompt or feedback exceeds the enhancement size limit.")
    const origin = phase()
    retry = saved?.phase ?? (origin === "failed" ? attempt()?.phase ?? "write" : origin === "pending" ? "questions" : origin)
    const snapshot: Attempt = { value, log: [...records], comment, revision, phase: retry, edits: changes, model: chosen, controls, values, retry: saved?.retry, version: saved?.version ?? version() }
    setAttempt(snapshot)
    pending?.abort()
    const request = new AbortController()
    pending = request
    setWaiting("Starting enhancement")
    setSummary("")
    setPreview("")
    setActivity(undefined)
    setBusy(true)
    setError("")
    setFailure(undefined)
    try {
      const result = await deadline(async (signal) => {
      let failure: unknown
      // The worker RPC buffers bodies. Its authenticated HTTP listener streams
      // the same backend without opening a browser or creating another engine.
      const client = expose ? createKiloClient({
        baseUrl: await expose(), directory: sdk.directory, headers: sdk.headers,
      }) : sdk.client
      if (!same() || request.signal.aborted || pending !== request) return undefined
      const response = await client.forge.enhanceStream({ ...scope, text: value, answers: answers || undefined, feedback: comment, revision, model: chosen, edits: changes.length ? changes : undefined, retry: saved?.retry?.map((issue) => ({ ...issue, path: [...issue.path] })) }, {
        throwOnError: true, signal, fetch,
        // Reconnecting a POST would start another paid generation.
        sseMaxRetryAttempts: 0,
        onSseError: (err) => { failure = err },
      })
      let result: Proposal | undefined
      for await (const frame of response.stream) {
        if (!same() || signal.aborted || pending !== request) return undefined
        if (frame.type === "error") {
          const report = diagnostic(frame.failure)
          throw report ? new EnhancementError(frame.message, report) : new Error(frame.message)
        }
        if (frame.type === "result") { result = frame.proposal; break }
        if (frame.type !== "progress") continue
        batch(() => {
          setWaiting(frame.stage)
          if (frame.summary != null) setSummary(frame.summary)
          if (frame.preview != null) setPreview(frame.preview)
          if (frame.activity != null) setActivity(frame.activity)
        })
      }
      if (!same() || request.signal.aborted || pending !== request) return undefined
      if (failure) throw failure
      if (!result) throw new Error("The enhancement stream ended before a complete prompt arrived. Your input was kept; press Enter to retry.")
      return result
      }, AbortSignal.any([controller.signal, request.signal]), 180_000, new EnhancementError("Enhancement exceeded its three-minute deadline. Your prompt and answers were kept; retry explicitly.", fault("timeout")))
      if (!same() || request.signal.aborted || pending !== request || !result) return
      if (result.original !== value || (result.session != null && result.session !== (scope.session ?? ""))) throw new Error("The enhancement response belongs to a different prompt or session.")
      if (chosen && result.model && (chosen.providerID !== result.model.providerID || chosen.modelID !== result.model.modelID)) throw new Error("The enhancement response used a different model. Your input was kept; choose the model explicitly before retrying.")
      const resolved = new Set(settled())
      for (const item of controls) if (item.optional) resolved.add(identity(item))
      const asked = questions(result)
      const repeated = asked.filter((item) => item.optional && resolved.has(identity(item))).length
      const stalled = controls.length && controls.every((item) => !values[item.id]?.option && !values[item.id]?.comment?.trim()) && asked.length ? stalls() + 1 : 0
      batch(() => {
        setSettled(resolved)
        setStalls(stalled)
        setWarning(repeated ? "Previously answered or skipped optional questions were repeated. Their responses are retained; review or give feedback instead of repeating them." : stalled >= 3 ? "Three clarification rounds made no progress. Review, give feedback, or explicitly reopen questions. Consequential decisions still block acceptance." : "")
        setValues({})
        setIncorporated(snapshot.version)
        setModel(result.model ?? chosen)
        setPrevious(proposal())
        setProposal(result)
        setOriginal(value)
        setText(result.prompt)
        setSummary(result.summary ?? "")
        setActivity(result.activity ?? activity())
        setHistory([...records, ...(comment?.trim() ? [`Developer feedback:\n${comment}`] : [])])
        setFeedback("")
        setRound((value) => value + 1)
        setCursor(0)
        setOption(0)
        setAction(0)
        setAttempt(undefined)
        setPhase(asked.some((item) => !item.optional || !resolved.has(identity(item))) && stalled < 3 ? "questions" : "review")
      })
    } catch (err) {
      if (!request.signal.aborted && pending === request) {
        setSummary(proposal()?.summary ?? "")
        setPreview("")
        report(err)
        setPhase("failed")
      }
    } finally {
      if (pending === request) { pending = undefined; setBusy(false) }
    }
  }

  function answering(key: string) { return values()[key] ?? {} }

  function fresh() {
    batch(() => {
      setOriginal("")
      setInput("")
      setText("")
      setHistory([])
      setEdits([])
      setBaseline("")
      setValues({})
      setSettled(new Set<string>())
      setStalls(0)
      setWarning("")
      setVersion(0)
      setIncorporated(0)
      setProposal(undefined)
      setPrevious(undefined)
      setAttempt(undefined)
      setFeedback("")
      setFailure(undefined)
      setError("")
      setSummary("")
      setPreview("")
      setRound(0)
      setActivity(undefined)
      setCursor(0)
      setOption(0)
      setAction(0)
      setExpanded(false)
      setPhase("write")
    })
  }

  function start(value: string) {
    setInput(value)
    if (attachments(draft?.parts ?? []).some((item) => item.registration) && !choosing()) {
      setChoosing(true)
      return
    }
    void generate(value, history()).catch(report)
  }

  async function accept(value = text()) {
    const item = proposal()
    if (!item || busy()) return
    if (!value.trim()) { setError("The improved prompt cannot be empty. Edit it before using it."); setPhase("edit"); return }
    if (dirty().length) { setPhase("pending"); return }
    if (item.status !== "ready") { setError("A consequential decision is still unresolved. Answer it or give feedback before using this prompt."); return }
    if (!initial || !draft) { setError("No chat input is available. Reopen /enhance from a chat to use this prompt."); return }
    if (!same()) { setInvalid(true); return }
    const request = new AbortController()
    pending = request
    retry = phase()
    setWaiting("Checking supporting context before returning the draft")
    setPreview("")
    setBusy(true)
    setError("")
    try {
      const result = await deadline((signal) => sdk.client.forge.validate({ ...item, ...scope }, {
        throwOnError: true, signal,
      }), AbortSignal.any([controller.signal, request.signal]), 30_000, new EnhancementError("Supporting-context validation exceeded its 30-second deadline. Your draft was kept.", fault("timeout")))
      if (!same() || request.signal.aborted || pending !== request) return
      if (!result.data.valid) throw new Error("Supporting files changed. Give feedback to regenerate the prompt with current context.")
      const edited = amendments(edits())
      initial.set(prepared(draft, edited ? `${value}\n\n${edited}` : value, item.context.text, item.id))
      dialog.clear()
      // Accept stages a draft only. The next, separate composer submission sends it.
    } catch (err) {
      if (!request.signal.aborted && pending === request) report(err)
    } finally {
      if (pending === request) { pending = undefined; setBusy(false) }
    }
  }

  function answer(value: Answer) {
    const item = current()
    if (!item) return
    setError("")
    setFailure(undefined)
    setAttempt(undefined)
    setValues((values) => ({ ...values, [item.id]: { ...values[item.id], ...value } }))
    setVersion((value) => value + 1)
  }

  function choose(index: number) {
    const item = current()
    const value = item?.options.at(index)
    if (!item || value == null) return
    answer({ option: values()[item.id]?.option === value ? undefined : value, skipped: false })
  }

  function next(skip = false) {
    if (skip) answer({ option: undefined, skipped: true })
    if (!answering(current()?.id ?? "").option && !answering(current()?.id ?? "").comment?.trim()) answer({ skipped: true })
    if (cursor() + 1 < items().length) { setCursor((value) => value + 1); setOption(0); return }
    for (const item of items()) if (!values()[item.id]) setValues((value) => ({ ...value, [item.id]: { skipped: true } }))
    void generate(original(), history(), undefined, text()).catch(report)
  }

  function recover() {
    setPhase(attempt()?.phase ?? "write")
  }

  function again() {
    const value = attempt()
    if (!value || phase() !== "failed") return
    void generate(value.value, value.log, value.comment, value.revision, { ...value, retry: failure()?.code === "schema" ? failure()?.issues : value.retry }).catch(report)
  }

  function save(value: string) {
    // Content-change notifications can arrive after the submit key.
    setText(value)
    if (value !== baseline()) setAttempt(undefined)
    if (!value.trim()) { setError("The improved prompt cannot be empty. Your editor remains open."); return }
    const added = differences(baseline(), value)
    const changes = [...edits(), ...added]
    amendments(changes)
    const log = [...history(), ...(added.length ? [amendments(added)] : [])]
    transcript(log)
    setEdits(changes)
    setHistory(log)
    setBaseline(value)
    setText(value)
    setError("")
    setPhase("review")
    setAction(0)
  }

  function models() {
    if (busy() || invalid()) return
    const item = model()
    setSelection(item ? `${item.providerID}/${item.modelID}` : "")
    setPhase("model")
  }

  function change(value: string) {
    const chosen = reference(value.trim())
    if (!chosen) { setError("Use provider/model, for example kilo/kilo-auto/small."); return }
    setModel(chosen)
    const saved = attempt()
    if (saved) { void generate(saved.value, saved.log, saved.comment, saved.revision, { ...saved, model: chosen, retry: failure()?.code === "schema" ? failure()?.issues : saved.retry }).catch(report); return }
    if (proposal()) { void generate(original(), history(), feedback().trim() ? feedback() : undefined, text()).catch(report); return }
    setPhase("write")
  }

  function discard() {
    setValues({})
    setVersion(incorporated())
    setPhase("review")
    void accept()
  }

  function back() {
    if (invalid()) { dialog.clear(); return }
    if (tracing()) { setTracing(false); return }
    if (phase() === "failed" && !busy()) { recover(); return }
    setError("")
    if (busy()) { pending?.abort(); pending = undefined; setBusy(false); setSummary(proposal()?.summary ?? ""); setPreview(""); setPhase(retry); return }
    if (phase() === "comment") { setPhase("questions"); return }
    if (phase() === "edit") { save(text()); return }
    if (phase() === "pending" || phase() === "model") { setPhase(proposal() ? "review" : "write"); return }
    if (phase() === "feedback" || phase() === "edit" || phase() === "questions") { setPhase("review"); return }
    if (phase() === "write" && proposal()) { setPhase("review"); return }
    dialog.clear()
  }

  function feedbacks() { setError(""); setPhase("feedback") }
  function edit() {
    if (!initial) { setError("No chat input is available. Reopen /enhance from a chat to edit and use this prompt."); return }
    setBaseline(text()); setError(""); setPhase("edit")
  }
  function map() { setMapped(true) }
  function activate() {
    const value = actions().at(action())
    if (value === "Use prompt") { void accept(); return }
    if (value === "Give feedback") { feedbacks(); return }
    if (value === "Edit prompt") { edit(); return }
    if (value === "Questions") { setPhase("questions"); return }
    if (value === "Activity") { setTracing(true); return }
    if (value === "Source map") { map(); return }
    setExpanded((value) => !value)
  }

  onMount(() => {
    dialog.setSize("large")
    initial?.blur()
    if (auto && !props.previous) start(seed)
    if (props.previous && props.answers) void generate(seed, [props.answers], undefined, props.previous.prompt).catch(report)
  })
  onCleanup(() => { controller.abort(); pending?.abort(); if (initial && context?.current === initial) initial.focus() })
  createEffect(() => {
    if (same()) return
    controller.abort()
    pending?.abort()
    setInvalid(true)
    setBusy(false)
    setProposal(undefined)
    setPrevious(undefined)
    setText("")
    setSummary("")
    setPreview("")
    setActivity(undefined)
    setAttempt(undefined)
    setError("")
    setTracing(false)
    setChoosing(false)
    setManaging(false)
    setMapped(false)
  })
  navigation(back, () => !mapped() && !choosing())
  useBindings(() => ({
    enabled: !mapped() && !choosing(),
    priority: 5,
    bindings: [{ key: "ctrl+c", desc: "Close enhancement without sending", group: "Forge Enhance", cmd: () => dialog.clear() }],
  }))
  useBindings(() => ({
    enabled: phase() === "failed" && !busy() && !invalid() && !mapped() && !choosing() && !tracing(),
    priority: 3,
    bindings: [
      { key: "return", desc: "Return to saved input", group: "Forge Enhance", cmd: recover },
      { key: "e", desc: "Edit saved input", group: "Forge Enhance", cmd: recover },
      { key: "r", desc: "Retry the failed enhancement", group: "Forge Enhance", cmd: again },
      { key: "t", desc: "Inspect file activity", group: "Forge Enhance", cmd: () => setTracing(true) },
      { key: "n", desc: "Start a new prompt", group: "Forge Enhance", cmd: fresh },
      { key: "v", desc: "Change enhancement model", group: "Forge Enhance", cmd: models },
      { key: "o", desc: "Review the previous draft", group: "Forge Enhance", cmd: () => { if (proposal()) { setError(""); setPhase("review") } } },
    ],
  }))
  useBindings(() => ({
    enabled: phase() === "pending" && !busy() && !invalid() && !mapped() && !tracing(),
    priority: 3,
    bindings: [
      { key: "g", desc: "Incorporate pending answers", group: "Forge Enhance", cmd: () => { void generate(original(), history(), undefined, text()).catch(report) } },
      { key: "x", desc: "Discard pending answers and use the prior draft", group: "Forge Enhance", cmd: discard },
      { key: "o", desc: "Return to review", group: "Forge Enhance", cmd: () => setPhase("review") },
    ],
  }))
  useBindings(() => ({
    enabled: !busy() && !invalid() && !mapped() && !choosing(),
    priority: 3,
    bindings: [{ key: "ctrl+t", desc: "Toggle file activity", group: "Forge Enhance", cmd: () => setTracing((value) => !value) }],
  }))
  useBindings(() => ({
    enabled: (busy() || tracing()) && !invalid(),
    priority: 2,
    bindings: [
      { key: "up", desc: "Scroll live enhancement up", group: "Forge Enhance", cmd: () => scroll?.scrollBy(-1) },
      { key: "down", desc: "Scroll live enhancement down", group: "Forge Enhance", cmd: () => scroll?.scrollBy(1) },
      { key: "pageup", desc: "Scroll live enhancement up", group: "Forge Enhance", cmd: () => scroll?.scrollBy(-10) },
      { key: "pagedown", desc: "Scroll live enhancement down", group: "Forge Enhance", cmd: () => scroll?.scrollBy(10) },
      { key: "t", desc: "Return from file activity", group: "Forge Enhance", cmd: () => { if (tracing()) setTracing(false) } },
    ],
  }))
  useBindings(() => ({
    enabled: !busy() && !invalid() && !mapped() && !choosing() && !tracing() && (phase() === "review" || phase() === "questions"),
    priority: 2,
    bindings: [
      { key: "return", desc: "Use prompt or continue questions", group: "Forge Enhance", cmd: () => { if (phase() === "questions") next(); else activate() } },
      { key: "tab", desc: "Next enhancement control", group: "Forge Enhance", cmd: () => { if (phase() === "questions") setOption((value) => (value + 1) % Math.max(1, current()?.options.length ?? 0)); else setAction((value) => (value + 1) % actions().length) } },
      { key: "shift+tab", desc: "Previous enhancement control", group: "Forge Enhance", cmd: () => { if (phase() === "questions") setOption((value) => Math.max(0, value - 1)); else setAction((value) => (value - 1 + actions().length) % actions().length) } },
      ...(["up", "down"] as const).map((key) => ({ key, desc: `${key} through prompt or options`, group: "Forge Enhance", cmd: () => {
        if (phase() === "questions") { setOption((value) => Math.max(0, Math.min((current()?.options.length ?? 1) - 1, value + (key === "up" ? -1 : 1)))); return }
        scroll?.scrollBy(key === "up" ? -1 : 1)
      } })),
      { key: "left", desc: "Previous question or control", group: "Forge Enhance", cmd: () => { if (phase() === "questions") { setCursor((value) => Math.max(0, value - 1)); setOption(0) } else setAction((value) => (value - 1 + actions().length) % actions().length) } },
      { key: "right", desc: "Next question or control", group: "Forge Enhance", cmd: () => { if (phase() === "questions") { setCursor((value) => Math.min(items().length - 1, value + 1)); setOption(0) } else setAction((value) => (value + 1) % actions().length) } },
      { key: "space", desc: "Select one optional answer", group: "Forge Enhance", cmd: () => { if (phase() === "questions") choose(option()) } },
      { key: "s", desc: "Skip selection", group: "Forge Enhance", cmd: () => { if (phase() === "questions") next(true) } },
      { key: "c", desc: "Feedback or answer comments", group: "Forge Enhance", cmd: () => { if (phase() === "questions") setPhase("comment"); else feedbacks() } },
      { key: "e", desc: "Edit improved prompt", group: "Forge Enhance", cmd: edit },
      { key: "v", desc: "Change enhancement model", group: "Forge Enhance", cmd: models },
      { key: "a", desc: "Use prompt without sending", group: "Forge Enhance", cmd: () => { void accept() } },
      { key: "q", desc: "Review clarification questions", group: "Forge Enhance", cmd: () => { if (items().length) setPhase("questions") } },
      { key: "o", desc: "Review the current draft", group: "Forge Enhance", cmd: () => setPhase("review") },
      { key: "m", desc: "Open terminal source map", group: "Forge Enhance", cmd: map },
      { key: "d", desc: "Toggle evidence details", group: "Forge Enhance", cmd: () => setExpanded((value) => !value) },
      { key: "t", desc: "Inspect file activity", group: "Forge Enhance", cmd: () => setTracing(true) },
      { key: "r", desc: "Close enhancement", group: "Forge Enhance", cmd: () => dialog.clear() },
      { key: "pageup", desc: "Scroll prompt up", group: "Forge Enhance", cmd: () => scroll?.scrollBy(-10) },
      { key: "pagedown", desc: "Scroll prompt down", group: "Forge Enhance", cmd: () => scroll?.scrollBy(10) },
    ],
  }))

  return <box><Show when={!mapped()} fallback={<ForgeKnowledge command="map" back={() => { setMapped(false); dialog.setSize("large"); initial?.blur() }} />}>
    <Show when={!choosing()} fallback={<Show when={!managing()} fallback={<ForgeLibrary scope={{ ...scope, session: scope.session ?? "" }} back={() => setManaging(false)} />}>
      <ForgeAttachments parts={draft?.parts ?? []} scope={scope} valid={same} back={() => setChoosing(false)} library={() => setManaging(true)} proceed={() => {
        setChoosing(false)
        void generate(input(), history()).catch(report)
      }} />
    </Show>}>
      <box padding={1} gap={1}>
        <text fg={theme.primary}>Forge · enhance · prompt workshop{round() ? ` · Revision ${round()}` : ""}</text>
        <text fg={theme.textMuted}>Improve the prompt here. Using it fills the chat draft; nothing is sent automatically.</text>
        <text fg={theme.textMuted} onMouseUp={models}>Enhancement model: {model() ? `${model()!.providerID}/${model()!.modelID}` : "Backend default/small model"} · [v] Change · Requests may incur model cost.</text>
        <Show when={warning()}><text fg={theme.warning}>{warning()}</text></Show>
        <Show when={error()}><text fg={theme.error}>{error()}{"\n"}Ctrl+T shows the recorded file activity; your input and answers remain available.</text></Show>
        <Show when={!invalid()} fallback={<text fg={theme.error}>Workspace or session changed, or the chat draft was edited. Close and reopen /enhance; your current chat draft was left untouched.</text>}>
          <Show when={!busy()} fallback={<box gap={1}>
            <Spinner>{waiting()}</Spinner>
            <scrollbox ref={(value: ScrollBoxRenderable) => { scroll = value }} height={height()} stickyScroll={true} stickyStart="bottom">
              <ForgeActivity log={activity()} active={true} scroll={() => scroll} />
              <Show when={summary()}><text fg={theme.textMuted}>Explanation{"\n"}{summary()}</text></Show>
              <Show when={preview()}><text>Draft in progress (not ready to use){"\n"}{preview()}</text></Show>
            </scrollbox>
            <text fg={theme.textMuted}>Arrows / Tab Choose section · Enter / Space Expand · Page Up / Down Scroll · Esc Cancel</text>
          </box>}>
            <Show when={!tracing()} fallback={<box gap={1}>
              <scrollbox ref={(value: ScrollBoxRenderable) => { scroll = value }} height={Math.max(6, Math.min(25, dimensions().height - 14))}>
                <ForgeActivity log={activity()} active={true} scroll={() => scroll} />
              </scrollbox>
              <text fg={theme.textMuted}>Arrows / Tab Choose section · Enter / Space Expand · Page Up / Down Scroll · t / Ctrl+T / Esc Back</text>
            </box>}>
            <Show when={phase() === "failed"}><box gap={1}>
              <text fg={theme.warning}>Enhancement failed. No new revision was applied.</text>
              <text>Your prompt, selections, comments, and feedback are saved. Retry makes another model request.</text>
              <text fg={theme.primary} onMouseUp={recover}>Enter / [e] {attempt()?.phase === "questions" ? "Edit saved answers" : attempt()?.phase === "feedback" ? "Edit saved feedback" : "Edit saved prompt"}</text>
              <text onMouseUp={again}>[r] Retry same request</text>
              <text onMouseUp={models}>[v] Change enhancement model and retry</text>
              <text onMouseUp={() => setTracing(true)}>[t] File activity</text>
              <text fg={theme.textMuted}>[n] New prompt{proposal() ? " · [o] Previous draft" : ""} · Esc Edit saved input · Ctrl+C Close</text>
            </box></Show>
            <Show when={phase() === "pending"}><box gap={1}>
              <text fg={theme.warning}>Your selected answers or comments have not been incorporated into this draft.</text>
              <text onMouseUp={() => { void generate(original(), history(), undefined, text()).catch(report) }}>[g] Revise with pending answers (another model request)</text>
              <text onMouseUp={discard}>[x] Discard pending answers and use the previous draft</text>
              <text onMouseUp={() => setPhase("review")}>[o] Return to review without discarding anything</text>
            </box></Show>
            <Show when={phase() === "model"}><ForgeField title="Enhancement model: provider/model. Enter starts a new request when a revision exists." value={selection()} change={setSelection} submit={change} back={back} /></Show>
            <Show when={phase() === "write"}><ForgeField title="Write your prompt" value={input()} change={(value) => { if (value !== input()) { setError(""); setAttempt(undefined) }; setInput(value) }} submit={start} back={back} /></Show>
            <Show when={phase() === "feedback"}><ForgeField title="Give feedback to improve this revision" value={feedback()} change={(value) => { if (value !== feedback()) { setError(""); setAttempt(undefined) }; setFeedback(value) }}
              submit={(value) => { setFeedback(value); if (!value.trim()) { setError("Enter feedback, or press Esc to keep the current revision."); return }; void generate(original(), history(), value, text()).catch(report) }} back={back} /></Show>
            <Show when={phase() === "edit"}><ForgeField title="Edit the improved prompt" value={text()} change={(value) => { if (value !== text()) { setError(""); setAttempt(undefined) }; setText(value) }} submit={(value) => { try { save(value) } catch (err) { report(err) } }} back={back} /></Show>
            <Show when={phase() === "comment"}><ForgeField title="Add comments to your answer" value={values()[current()?.id ?? ""]?.comment ?? ""}
              change={(value) => answer({ comment: value, skipped: false })} submit={(value) => { answer({ comment: value, skipped: false }); setPhase("questions") }} back={back} /></Show>
            <Show when={phase() === "questions"}><Show when={current()} fallback={<text>No clarification questions. Press o to review.</text>}>{(item) => <box gap={1}>
              <text fg={theme.primary}>Clarification {cursor() + 1}/{items().length}: {item().question}</text>
              <text fg={theme.textMuted}>{item().impact}{"\n"}{item().optional ? "Optional clarification. Select one and/or add comments, or skip." : "Select one and/or add comments. This consequential decision stays unresolved if skipped."}</text>
              <scrollbox height={Math.max(4, height() - 7)}>
                <For each={item().options}>{(value, index) => <text fg={option() === index() ? theme.primary : theme.text} onMouseUp={() => { setOption(index()); choose(index()) }}>
                  {option() === index() ? "> " : "  "}[{values()[item().id]?.option === value ? "x" : " "}] {value}
                </text>}</For>
              </scrollbox>
              <text fg={theme.textMuted}>Comment: {values()[item().id]?.comment || "None"}{"\n"}{values()[item().id]?.option ? `Selected: ${values()[item().id]?.option}` : "No option selected; comments alone can answer."}</text>
              <text fg={theme.primary} onMouseUp={() => next()}>Enter {cursor() + 1 === items().length ? "Revise with answers" : "Next question"}</text>
              <text fg={theme.textMuted}>Arrows / Tab Move · Space Select / clear · c Comment · s Skip · t Activity · o Review · Esc Back</text>
            </box>}</Show></Show>
            <Show when={phase() === "review"}><box gap={1}>
              <Show when={dirty().length}><text fg={theme.warning}>Pending answers/comments are saved but not yet incorporated. Acceptance will ask you to revise or explicitly discard them.</text></Show>
              <Show when={!initial}><text fg={theme.textMuted}>No chat input is available. Open /enhance from a chat to place this prompt in its composer.</text></Show>
              <Show when={proposal()?.status === "needs_clarification"}><text fg={theme.warning}>A consequential decision remains unresolved. [q] Answer questions or [c] Give feedback.</text></Show>
              <scrollbox ref={(value: ScrollBoxRenderable) => { scroll = value }} height={height()}>
                <Show when={summary()}><text fg={theme.textMuted}>{summary()}{"\n"}</text></Show>
                <text>{text()}</text>
                <Show when={expanded()}><Show when={proposal()}>{(item) => <box gap={1}>
                  <For each={compare(item().context, previous()?.context)}>{(line) => <text fg={theme.textMuted}>{line}</text>}</For>
                  <For each={details(item().context)}>{(line) => <text fg={theme.textMuted}>{line}</text>}</For>
                  <For each={item().warnings}>{(line) => <text fg={theme.warning}>{line}</text>}</For>
                  <text fg={theme.textMuted}>{item().context.text}</text>
                </box>}</Show></Show>
              </scrollbox>
              <For each={actions()}>{(value, index) => <text fg={action() === index() ? theme.primary : theme.text} onMouseUp={() => { setAction(index()); activate() }}>
                {action() === index() ? "> " : "  "}{value === "Use prompt" ? "Enter / [a] Use prompt (does not send)" : value === "Give feedback" ? "[c] Give feedback" : value === "Edit prompt" ? "[e] Edit prompt" : value === "Questions" ? "[q] Questions" : value === "Activity" ? "[t] File activity" : value === "Source map" ? "[m] Source map" : "[d] Details"}
              </text>}</For>
              <text fg={theme.textMuted}>Tab / Left / Right Choose action · Enter Activate · Arrows Scroll · Esc / r Close</text>
            </box></Show>
            </Show>
          </Show>
        </Show>
      </box>
    </Show>
  </Show></box>
}
