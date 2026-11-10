/** @jsxImportSource @opentui/solid */
/** @jsxImportSource @opentui/solid */
import { TextareaRenderable } from "@opentui/core"
import { expect, test } from "bun:test"
import { unwrap } from "solid-js/store"
import { wait } from "../cli/cmd/tui/sync-fixture"
import { tmpdir } from "../fixture/fixture"
import { workshop, mount } from "./forge-composer-fixture"

test.each(["OpenCode HTTP/CLI", "VS Code backend"])(
  "the %s branch is answered locally before the batch is submitted",
  async (choice) => {
    await using root = await tmpdir()
    const state = workshop(root.path)
    state.investigation = {
      ...state.investigation,
      state: "needs_input",
      questions: [
        {
          id: "target",
          question: "Which backend?",
          impact: "Choose a subsystem.",
          options: ["OpenCode HTTP/CLI", "VS Code backend"],
          optional: false,
        },
        {
          id: "http",
          question: "Which HTTP endpoint fails?",
          impact: "Narrow the HTTP server.",
          options: ["Session creation", "SSE streaming"],
          optional: false,
          when: { question: "target", options: ["OpenCode HTTP/CLI"] },
        },
        {
          id: "vscode",
          question: "When does the VS Code backend disconnect?",
          impact: "Narrow the extension backend.",
          options: ["Extension startup", "After a backend restart"],
          optional: false,
          when: { question: "target", options: ["VS Code backend"] },
        },
        {
          id: "platform",
          question: "Which platform?",
          impact: "Optional context for either subsystem.",
          options: ["macOS", "Linux"],
          optional: true,
        },
      ],
    }
    let calls = 0
    using ui = await mount(
      root.path,
      true,
      [],
      [],
      async (path) => {
        if (path !== "/forge/investigations/stream" || ++calls !== 2) return undefined
        state.investigation = { ...state.investigation, state: "findings_ready", questions: [] }
        return undefined
      },
      undefined,
      () => root.path,
      undefined,
      state,
    )
    ui.prompt.set({ input: "/enhance Make the backend durable", parts: [] })
    await ui.press("\r")
    await ui.frame("Which backend?")
    expect(ui.app.captureCharFrame()).not.toContain("Which HTTP endpoint fails?")
    if (choice === "VS Code backend") await ui.press("\x1b[B")
    await ui.press(" ")
    expect(ui.requests).toHaveLength(1)
    await ui.press("\r")
    await ui.frame(
      choice === "OpenCode HTTP/CLI" ? "Which HTTP endpoint fails?" : "When does the VS Code backend disconnect?",
    )
    await ui.frame(`Based on your answer: ${choice}`)
    expect(ui.requests).toHaveLength(1)
    expect(ui.app.captureCharFrame()).not.toContain("Understanding the request")
    await ui.press(" ")
    await ui.press("\r")
    await ui.frame("Which platform?")
    expect(ui.requests).toHaveLength(1)
    await ui.press("s")
    await ui.frame("Choose what to include")
    expect(ui.requests).toHaveLength(2)
    expect(ui.requests.at(-1)?.body.answers).toContain(`"option":"${choice}"`)
    expect(ui.requests.at(-1)?.body.answers).toContain(`"id":"${choice === "OpenCode HTTP/CLI" ? "http" : "vscode"}"`)
    expect(ui.requests.at(-1)?.body.answers).not.toContain(`"id":"${choice === "OpenCode HTTP/CLI" ? "vscode" : "http"}"`)
    expect(ui.requests.at(-1)?.body.answers).toContain('"skipped":true')
    expect(ui.requests.some((item) => item.path.startsWith("/session/"))).toBe(false)
  },
)

test("changing a parent clears nested answers and hidden branches never submit", async () => {
  await using root = await tmpdir()
  const state = workshop(root.path)
  const question = { impact: "Narrow the scope.", optional: false }
  state.investigation = {
    ...state.investigation,
    state: "needs_input",
    questions: [
      { ...question, id: "target", question: "Which backend?", options: ["HTTP", "VS Code"] },
      {
        ...question, id: "http", question: "Which HTTP operation?", options: ["Streaming", "Creation"],
        when: { question: "target", options: ["HTTP"] },
      },
      {
        ...question, id: "timing", question: "When does streaming fail?", options: ["On connect", "After reconnect"],
        when: { question: "http", options: ["Streaming"] },
      },
      {
        ...question, id: "vscode", question: "Which extension behavior?", options: ["Startup", "Shutdown"],
        when: { question: "target", options: ["VS Code"] },
      },
    ],
  }
  let calls = 0
  using ui = await mount(root.path, true, [], [], async (path) => {
    if (path === "/forge/investigations/stream" && ++calls === 2)
      state.investigation = { ...state.investigation, state: "findings_ready", questions: [] }
    return undefined
  }, undefined, () => root.path, undefined, state)
  ui.prompt.set({ input: "/enhance fix the backend", parts: [] })
  await ui.press("\r")
  await ui.frame("Which backend?")
  await ui.press(" ")
  await ui.press("\r")
  await ui.frame("Which HTTP operation?")
  await ui.press(" ")
  await ui.press("\r")
  await ui.frame("When does streaming fail?")
  await ui.press(" ")
  await ui.press("\x1b[D")
  await ui.press("\x1b[D")
  await ui.frame("Which backend?")
  await ui.press("\x1b[B")
  await ui.press(" ")
  await ui.press("\r")
  await ui.frame("Which extension behavior?")
  await ui.press(" ")
  await ui.press("\x1b[D")
  await ui.press(" ")
  await ui.press("\r")
  await ui.frame("Which HTTP operation?")
  await ui.frame("Selected: None")
  await ui.press(" ")
  await ui.press("\r")
  await ui.frame("When does streaming fail?")
  await ui.frame("Selected: None")
  expect(ui.requests).toHaveLength(1)
  await ui.press("\x1b[B")
  await ui.press(" ")
  await ui.press("\r")
  await ui.frame("Choose what to include")
  expect(ui.requests).toHaveLength(2)
  const answers = ui.requests.at(-1)?.body.answers
  expect(answers).toContain('"option":"After reconnect"')
  expect(answers).not.toContain('"option":"On connect"')
  expect(answers).not.toContain('"id":"vscode"')
})

test("a standalone custom answer submits without guessing an option branch", async () => {
  await using root = await tmpdir()
  const state = workshop(root.path)
  state.investigation = {
    ...state.investigation,
    state: "needs_input",
    questions: [
      { id: "target", question: "Which backend?", impact: "Choose scope.", options: ["HTTP", "VS Code"], optional: false },
      {
        id: "http", question: "Which HTTP operation?", impact: "Narrow scope.", options: ["Streaming", "Creation"],
        optional: false, when: { question: "target", options: ["HTTP"] },
      },
    ],
  }
  let calls = 0
  using ui = await mount(root.path, true, [], [], async (path) => {
    if (path === "/forge/investigations/stream" && ++calls === 2)
      state.investigation = { ...state.investigation, state: "findings_ready", questions: [] }
    return undefined
  }, undefined, () => root.path, undefined, state)
  ui.prompt.set({ input: "/enhance fix the backend", parts: [] })
  await ui.press("\r")
  await ui.frame("Which backend?")
  await ui.press("c")
  await ui.frame("Your answer or additional details.")
  const editor = ui.app.renderer.currentFocusedEditor
  if (!(editor instanceof TextareaRenderable)) throw new Error("Expected clarification input")
  editor.setText("The database worker")
  await ui.press("\r")
  await ui.frame("Enter Submit answers")
  expect(ui.requests).toHaveLength(1)
  await ui.press("\r")
  await ui.frame("Choose what to include")
  expect(ui.requests).toHaveLength(2)
  expect(ui.requests.at(-1)?.body.answers).toContain('"comment":"The database worker"')
  expect(ui.requests.at(-1)?.body.answers).not.toContain('"id":"http"')
})

test("investigative clarification after a bare slash command progresses with Enter and keeps controls visible", async () => {
  await using root = await tmpdir()
  const state = workshop(root.path)
  state.investigation = {
    ...state.investigation,
    state: "needs_input",
    summary: "Detailed analysis canary. ".repeat(100),
    findings: state.investigation.findings.map((item) => ({
      ...item,
      explanation: "Long supporting explanation. ".repeat(100),
    })),
    questions: [
      {
        id: "target",
        question: "Which backend do you mean?",
        impact: "The repository has multiple backends.",
        options: ["Sandbox", "HTTP API", "Other"],
        optional: false,
      },
    ],
  }
  let calls = 0
  using ui = await mount(
    root.path,
    true,
    [],
    [],
    async (path) => {
      if (path === "/forge/investigations/stream" && ++calls === 2) {
        state.investigation = { ...state.investigation, state: "findings_ready", questions: [] }
      }
      return undefined
    },
    undefined,
    () => root.path,
    undefined,
    state,
  )
  ui.app.renderer.resize(80, 24)
  for (const key of "/enhance") await ui.press(key)
  await ui.press("\r")
  await ui.frame("What should the agent investigate?")
  const draft = structuredClone(unwrap(ui.prompt.current))
  expect(ui.requests).toHaveLength(0)
  const input = ui.app.renderer.currentFocusedEditor
  if (!(input instanceof TextareaRenderable)) throw new Error("Expected investigation input")
  input.setText("fix the backend")
  await ui.press("\r")
  await ui.frame("Which backend do you mean?")
  await ui.frame("Clarification 1 |")
  await ui.frame("Space Select")
  expect(ui.requests.at(0)?.body.text).toBe("fix the backend")
  expect(ui.app.captureCharFrame()).toContain("Forge /enhance")
  expect(ui.app.captureCharFrame()).not.toContain("Detailed analysis canary")
  await ui.press("\r")
  await ui.frame("Select an option with Space")
  expect(ui.requests).toHaveLength(1)
  await ui.press("\x1b")
  await ui.frame("Enter / [c] Answer questions")
  await ui.press("d")
  await ui.press("\x1b[6~")
  await ui.frame("Detailed analysis canary")
  await ui.frame("Enter / [c] Answer questions")
  ui.app.renderer.resize(60, 20)
  await ui.frame("Enter / [c] Answer questions")
  expect(ui.app.captureCharFrame()).toContain("Forge /enhance")
  ui.app.renderer.resize(80, 24)
  await ui.press("\r")
  await ui.frame("Clarification 1 |")
  await ui.frame("Which backend do you mean?")
  expect(ui.requests).toHaveLength(1)
  await ui.press("\x1b[B")
  await ui.press(" ")
  await ui.frame("[x] HTTP API")
  await ui.press("c")
  await ui.frame("Your answer or additional details.")
  const editor = ui.app.renderer.currentFocusedEditor
  if (!(editor instanceof TextareaRenderable)) throw new Error("Expected clarification input")
  editor.setText("HTTP API: duplicate queue items")
  await ui.press("\r")
  await ui.frame("Clarification 1 |")
  expect(ui.requests).toHaveLength(1)
  await ui.press("\r")
  await ui.frame("Choose what to include")
  expect(ui.requests).toHaveLength(2)
  expect(ui.requests.at(-1)?.body.text).toBe("fix the backend")
  expect(ui.requests.at(-1)?.body.answers).toContain('"option":"HTTP API"')
  expect(ui.requests.at(-1)?.body.answers).toContain('"comment":"HTTP API: duplicate queue items"')
  expect(ui.requests.every((item) => item.path === "/forge/investigations/stream")).toBe(true)
  expect(ui.prompt.current).toEqual(draft)
  await ui.press("\x1b")
  await wait(() => ui.prompt.focused)
  expect(ui.requests).toHaveLength(2)
})

test.each(["empty", "contradicted"] as const)(
  "investigative %s findings continue assessment instead of requiring refinement",
  async (kind) => {
    await using root = await tmpdir()
    const state = workshop(root.path)
    const findings = state.investigation.findings
    state.investigation = {
      ...state.investigation,
      summary: "No additional candidate was established in this assessment.",
      findings:
        kind === "empty" ? [] : state.investigation.findings.map((item) => ({ ...item, support: "contradicted" })),
    }
    let calls = 0
    using ui = await mount(root.path, true, [], [], async (path) => {
      if (path === "/forge/investigations/stream" && ++calls === 2)
        state.investigation = { ...state.investigation, findings }
      return undefined
    }, undefined, () => root.path, undefined, state)
    ui.prompt.set({ input: "/enhance Fix duplicate queue items", parts: [] })
    await ui.press("\r")
    await ui.frame("Continue assessment with saved answers")
    expect(ui.app.captureCharFrame()).not.toContain("Refine request")
    if (kind === "empty") await ui.frame("No additional candidate was established")
    expect(ui.requests).toHaveLength(1)
    await ui.press("\r")
    await ui.frame("Choose what to include")
    expect(ui.app.captureCharFrame()).not.toContain("Your answers or feedback.")
    expect(ui.requests.map((item) => item.path)).toEqual(["/forge/investigations/stream", "/forge/investigations/stream"])
  },
)

test("a public clarification response is visible without approving findings or retrying", async () => {
  await using root = await tmpdir()
  const state = workshop(root.path)
  state.investigation = {
    ...state.investigation,
    state: "unstructured",
    findings: [],
    questions: [],
    observations: [],
    summary: "Which backend behavior should change?",
    limitations: ["The public response is not an evidence-backed finding."],
  }
  using ui = await mount(root.path, true, [], [], undefined, undefined, () => root.path, undefined, state)
  ui.prompt.set({ input: "/enhance i want you to improve the ba", parts: [] })
  const draft = structuredClone(unwrap(ui.prompt.current))
  await ui.press("\r")
  await ui.frame("Model response (not validated findings)")
  await ui.frame("Which backend behavior should change?")
  await ui.press("f")
  await ui.frame("Your answers or feedback.")
  expect(ui.requests).toHaveLength(1)
  expect(ui.prompt.current).toEqual(draft)
})

test.each([false, true])("a rejected proposal offers Enter recovery with saved answers, legacy=%s", async (legacy) => {
  await using root = await tmpdir()
  const state = workshop(root.path)
  const findings = state.investigation.findings
  state.investigation = {
    ...state.investigation,
    state: "needs_input",
    findings: [],
    questions: [{
      id: "scope", question: "Which scope should be assessed?", impact: "Select the scope.",
      options: ["API/request handling", "Background jobs"], optional: false,
    }],
  }
  let calls = 0
  using ui = await mount(root.path, true, [], [], async (path) => {
    if (path !== "/forge/investigations/stream") return undefined
    calls++
    if (calls === 2) state.investigation = {
      ...state.investigation,
      state: legacy ? "findings_ready" : "unstructured",
      failure: legacy ? undefined : { code: "schema", schema: "forge-enhancement-v2", issues: [], stage: "response" },
      questions: [],
      summary: "Consider centralized request lifecycle telemetry.",
      limitations: ["Model proposal 1 was discarded: invalid action format. No change was approved for it."],
    }
    if (calls === 3) state.investigation = {
      ...state.investigation, state: "findings_ready", failure: undefined, findings, limitations: [],
    }
    return undefined
  }, undefined, () => root.path, undefined, state)
  ui.prompt.set({ input: "/enhance Proactively assess backend observability", parts: [] })
  await ui.press("\r")
  await ui.frame("Which scope should be assessed?")
  await ui.press(" ")
  await ui.press("\r")
  await ui.frame("The model's suggestions could not be validated")
  await ui.frame("Consider centralized request")
  await ui.frame("telemetry.")
  await ui.frame("Retry suggestions (saved evidence")
  expect(ui.app.captureCharFrame()).not.toContain("Refine request")
  expect(ui.app.captureCharFrame()).not.toContain("No supported change selected")
  expect(ui.requests).toHaveLength(2)
  await ui.press("\r")
  await ui.frame("Choose what to include")
  expect(ui.requests).toHaveLength(3)
  expect(ui.requests.at(-1)?.body.resume).toMatchObject({ id: ui.requests.at(1)?.body.key })
  expect(ui.requests.at(-1)?.body.answers).toBe(ui.requests.at(1)?.body.answers)
  expect(ui.requests.at(-1)?.body.answers).toContain('"option":"API/request handling"')
  expect(ui.requests.some((item) => item.path.startsWith("/session/"))).toBe(false)
})

test("investigative writing stays blocked on questions and answers survive returning to review", async () => {
  await using root = await tmpdir()
  const state = workshop(root.path)
  state.investigation = {
    ...state.investigation,
    state: "needs_input",
    questions: [
      {
        id: "target",
        question: "Which backend?",
        impact: "Different code paths.",
        options: ["Sandbox", "HTTP API"],
        optional: false,
      },
    ],
  }
  using ui = await mount(root.path, true, [], [], undefined, undefined, () => root.path, undefined, state)
  ui.prompt.set({ input: "/enhance fix the backend", parts: [] })
  await ui.press("\r")
  await ui.frame("Clarification 1 |")
  await ui.press("\x1b[B")
  await ui.press(" ")
  await ui.frame("[x] HTTP API")
  await ui.press("w")
  expect(ui.requests).toHaveLength(1)
  await ui.press("c")
  await ui.frame("Your answer or additional details.")
  await wait(() => !!ui.app.renderer.currentFocusedEditor?.focused && ui.app.renderer.currentFocusedEditor !== ui.input)
  const editor = ui.app.renderer.currentFocusedEditor
  if (!(editor instanceof TextareaRenderable)) throw new Error("Expected clarification input")
  editor.setText("Duplicate queue items")
  await ui.press("\x1b")
  await ui.frame("Space Select")
  await ui.press("\x1b")
  await ui.frame("Answer questions")
  await ui.press("w")
  await ui.frame("Clarification 1 |")
  await ui.frame("[x] HTTP API")
  await ui.press("c")
  await ui.frame("Your answer or additional details.")
  await wait(() => !!ui.app.renderer.currentFocusedEditor?.focused && ui.app.renderer.currentFocusedEditor !== ui.input)
  const saved = ui.app.renderer.currentFocusedEditor
  if (!(saved instanceof TextareaRenderable)) throw new Error("Expected preserved clarification")
  expect(saved.plainText).toBe("Duplicate queue items")
  expect(ui.requests.map((item) => item.path)).toEqual(["/forge/investigations/stream"])
})

test("investigative batches support custom answers, optional skips, and accumulated history", async () => {
  await using root = await tmpdir()
  const state = workshop(root.path)
  state.investigation = {
    ...state.investigation,
    state: "needs_input",
    questions: [
      {
        id: "target",
        question: "Which backend?",
        impact: "Choose the code path.",
        options: ["Sandbox", "HTTP API"],
        optional: false,
      },
      {
        id: "symptom",
        question: "Which HTTP API operation fails?",
        impact: "Describe the failure.",
        options: ["Session creation", "Streaming responses"],
        optional: false,
        when: { question: "target", options: ["HTTP API"] },
      },
      {
        id: "platform",
        question: "Which platform?",
        impact: "Optional context.",
        options: ["macOS", "Linux"],
        optional: true,
      },
    ],
  }
  let calls = 0
  using ui = await mount(
    root.path,
    true,
    [],
    [],
    async (path) => {
      if (path !== "/forge/investigations/stream") return undefined
      calls++
      if (calls === 2)
        state.investigation = {
          ...state.investigation,
          questions: [
            {
              id: "target",
              question: "Which environment?",
              impact: "Reused ID is a different question.",
              options: ["Development", "Production"],
              optional: false,
            },
          ],
        }
      if (calls === 3) state.investigation = { ...state.investigation, state: "findings_ready", questions: [] }
      return undefined
    },
    undefined,
    () => root.path,
    undefined,
    state,
  )
  ui.prompt.set({ input: "/enhance fix the backend", parts: [] })
  await ui.press("\r")
  await ui.frame("Clarification 1 |")
  expect(ui.app.captureCharFrame()).not.toContain("Which HTTP API operation fails?")
  await ui.press("s")
  await ui.frame("This question needs an answer")
  await ui.press("\x1b[B")
  await ui.press(" ")
  await ui.press("\r")
  await ui.frame("Which HTTP API operation fails?")
  await ui.frame("Based on your answer: HTTP API")
  expect(ui.requests).toHaveLength(1)
  expect(ui.requests.at(-1)?.body.answers).toBeUndefined()
  await ui.press("c")
  await ui.frame("Your answer or additional details.")
  const editor = ui.app.renderer.currentFocusedEditor
  if (!(editor instanceof TextareaRenderable)) throw new Error("Expected custom answer input")
  editor.setText("Queue entries appear twice")
  await ui.press("\r")
  expect(ui.requests).toHaveLength(1)
  await ui.press("\r")
  await ui.frame("Clarification 3 |")
  await ui.frame("Which platform?")
  expect(ui.requests).toHaveLength(1)
  await ui.press("s")
  await ui.frame("Which environment?")
  await ui.frame("Selected: None")
  expect(ui.requests).toHaveLength(2)
  const first = ui.requests.at(-1)?.body.answers
  expect(first).toContain('"option":"HTTP API"')
  expect(first).toContain('"option":null,"comment":"Queue entries appear twice","skipped":false')
  expect(first).toContain('"id":"platform","question":"Which platform?","option":null,"comment":"","skipped":true')
  await ui.press("\x1b[B")
  await ui.press(" ")
  await ui.press("\r")
  await ui.frame("Choose what to include")
  expect(ui.requests).toHaveLength(3)
  expect(ui.requests.at(-1)?.body.answers).toContain(String(first))
  expect(ui.requests.at(-1)?.body.answers).toContain('"question":"Which environment?","option":"Production"')
  expect(ui.requests.every((item) => item.path === "/forge/investigations/stream")).toBe(true)
})

test.each(["failure", "cancellation"] as const)(
  "investigative answers survive %s without automatic retries",
  async (mode) => {
    await using root = await tmpdir()
    const state = workshop(root.path)
    state.investigation = {
      ...state.investigation,
      state: "needs_input",
      questions: [
        {
          id: "target",
          question: "Which backend?",
          impact: "Choose a target.",
          options: ["Sandbox", "HTTP API"],
          optional: false,
        },
      ],
    }
    const done = Promise.withResolvers<void>()
    const aborted = Promise.withResolvers<void>()
    let calls = 0
    using ui = await mount(
      root.path,
      true,
      [],
      [],
      async (path, request) => {
        if (path !== "/forge/investigations/stream") return undefined
        calls++
        if (calls === 2) {
          if (mode === "cancellation") {
            request.signal.addEventListener("abort", () => aborted.resolve(), { once: true })
            await done.promise
          }
          return new Response(
            `data: ${JSON.stringify({ type: "error", message: "Provider unavailable; answers preserved." })}\n\n`,
            { headers: { "content-type": "text/event-stream" } },
          )
        }
        if (calls === 3) state.investigation = { ...state.investigation, state: "findings_ready", questions: [] }
        return undefined
      },
      undefined,
      () => root.path,
      undefined,
      state,
    )
    ui.prompt.set({ input: "/enhance fix the backend", parts: [] })
    await ui.press("\r")
    await ui.frame("Clarification 1 |")
    await ui.press(" ")
    await ui.press("\r")
    await wait(() => ui.requests.length === 2)
    if (mode === "cancellation") {
      await ui.press("\x1b")
      await aborted.promise
      done.resolve()
    }
    if (mode === "failure") await ui.frame("Provider unavailable")
    await ui.frame("Your answers were kept.")
    expect(ui.requests).toHaveLength(2)
    await ui.press("c")
    await ui.frame("[x] Sandbox")
    await ui.press("\x1b[B")
    await ui.press(" ")
    await ui.frame("[x] HTTP API")
    await ui.press("\r")
    await ui.frame("Choose what to include")
    expect(ui.requests).toHaveLength(3)
    expect(ui.requests.at(-1)?.body.answers).toContain('"option":"HTTP API"')
    expect(ui.requests.at(-1)?.body.answers).not.toContain('"option":"Sandbox"')
    expect(String(ui.requests.at(-1)?.body.answers).match(/Clarification responses:/g)).toHaveLength(1)
    expect(ui.prompt.current.input).toBe("/enhance fix the backend")
  },
)

test("long investigative questions scroll while answer controls stay visible", async () => {
  await using root = await tmpdir()
  const state = workshop(root.path)
  state.investigation = {
    ...state.investigation,
    state: "needs_input",
    questions: [
      {
        id: "target",
        question: "Which backend behavior should change? ".repeat(25),
        impact: "Choose the relevant behavior.",
        options: Array.from({ length: 8 }, (_, index) => `Option ${index + 1}: ${"Detailed choice text. ".repeat(4)}`),
        optional: false,
      },
    ],
  }
  using ui = await mount(root.path, true, [], [], undefined, undefined, () => root.path, undefined, state)
  ui.app.renderer.resize(60, 20)
  ui.prompt.set({ input: "/enhance fix the backend", parts: [] })
  await ui.press("\r")
  await ui.frame("Clarification 1 |")
  await ui.frame("Space Select")
  await ui.press("\x1b[6~")
  await ui.frame("Space Select")
  expect(ui.app.captureCharFrame()).toContain("Forge /enhance")
  for (let index = 0; index < 7; index++) await ui.press("\x1b[B")
  await ui.press(" ")
  await ui.frame("[x] Option 8")
  await ui.frame("Space Select")
  await ui.press("c")
  await ui.frame("Enter saves;")
  expect(ui.requests).toHaveLength(1)
})
