/** @jsxImportSource @opentui/solid */
/** @jsxImportSource @opentui/solid */
import { TextareaRenderable } from "@opentui/core"
import { expect, test } from "bun:test"
import { unwrap } from "solid-js/store"
import { wait } from "../cli/cmd/tui/sync-fixture"
import { tmpdir } from "../fixture/fixture"
import { json } from "../fixture/tui-sdk"
import { source } from "@kilocode/forge/parse"
import { select } from "@kilocode/forge/context"
import { enhanced, mount } from "./forge-composer-fixture"

test("Ctrl+C still closes a ready review without clarification or submission", async () => {
  await using root = await tmpdir()
  using ui = await mount(root.path)
  ui.prompt.set({ input: "/enhance Preserve cancellation", parts: [] })
  const draft = structuredClone(unwrap(ui.prompt.current))
  await ui.press("\r")
  await ui.frame("[a] Use prompt")
  await ui.press("\x03")
  await wait(() => ui.prompt.focused)
  expect(ui.prompt.current).toEqual(draft)
  expect(ui.requests.map((item) => item.path)).toEqual(["/forge/enhance/stream"])
})

test("clarification preserves original requirements, accumulates answers, and compares the preceding selection", async () => {
  await using root = await tmpdir()
  const old = source("ownership.md", "Original lease evidence", "document")
  const updated = source("ownership.md", "Updated lease evidence", "document")
  const context = (value: typeof old) => ({
    ...select([{ source: value, score: 1, reason: "Pinned" }], 1000),
    provider: "local",
    destination: "review-route",
  })
  using ui = await mount(root.path, true, [], [context(old), context(updated), context(updated)])
  ui.prompt.set({ input: "/enhance Keep public API unchanged.", parts: [] })
  const draft = structuredClone(unwrap(ui.prompt.current))
  await ui.press("\r")
  await ui.frame("[a] Use prompt")
  await ui.press("d")
  await ui.frame("Prepared provider: local")
  await ui.frame("No previous selection in this review.")
  for (const [index, answer] of ["Use epoch leases.", "Keep retry behavior."].entries()) {
    await ui.press("c")
    await ui.frame("Give feedback to improve this revision")
    await wait(() => ui.app.renderer.currentFocusedEditor instanceof TextareaRenderable)
    const editor = ui.app.renderer.currentFocusedEditor
    if (!(editor instanceof TextareaRenderable)) throw new Error("Expected clarification editor")
    editor.setText(answer)
    await ui.press("\r")
    await ui.frame(index === 0 ? "1 versions changed" : "0 versions changed")
    expect(ui.prompt.current).toEqual(draft)
    expect(ui.requests.at(-1)?.body).toMatchObject({
      text: "Keep public API unchanged.",
      feedback: answer,
    })
    expect(ui.requests.at(-1)?.body.revision).toContain("Keep public API unchanged.")
    if (index) expect(ui.requests.at(-1)?.body.answers).toContain("Use epoch leases.")
  }
  expect(ui.requests.every((item) => item.path === "/forge/enhance/stream")).toBe(true)
  await ui.press("a")
  await wait(() => ui.prompt.focused)
  await ui.press("\r")
  await wait(() => ui.requests.some((item) => item.path === "/session/ses_forge/message"))
  const sent = ui.requests.find((item) => item.path === "/session/ses_forge/message")!
  expect(JSON.stringify(sent.body)).toContain("Keep public API unchanged.")
  expect(JSON.stringify(sent.body)).toContain("Use epoch leases.")
  expect(JSON.stringify(sent.body)).toContain("Keep retry behavior.")
  expect(JSON.stringify(sent.body)).toContain("Updated lease evidence")
  expect(JSON.stringify(sent.body)).not.toContain("Original lease evidence")
})

test("clarification options are single-choice and comments can answer without a selection", async () => {
  await using root = await tmpdir()
  let calls = 0
  const original = "Improve the documentation"
  using ui = await mount(root.path, true, [], [], async (path) => {
    if (path !== "/forge/enhance/stream") return undefined
    calls++
    return enhanced(
      original,
      calls === 1
        ? [
            {
              kind: "clarify",
              question: "Who is the audience?",
              impact: "Examples depend on the audience.",
              options: ["Developers", "End users"],
            },
            {
              kind: "clarify",
              question: "How detailed should it be?",
              impact: "This sets the scope.",
              options: ["Short", "Detailed"],
            },
          ]
        : [],
    )
  })
  ui.prompt.set({ input: `/enhance ${original}`, parts: [] })
  await ui.press("\r")
  await ui.frame("Who is the audience?")
  await ui.press("\x1b[B")
  await ui.press(" ")
  await ui.frame("[x] End users")
  await ui.press("\x1b[A")
  await ui.press(" ")
  const frame = ui.app.captureCharFrame()
  expect(frame.match(/\[x\]/g)).toHaveLength(1)
  await ui.press("c")
  await ui.frame("Add comments to your answer")
  await wait(() => ui.app.renderer.currentFocusedEditor instanceof TextareaRenderable)
  const editor = ui.app.renderer.currentFocusedEditor
  if (!(editor instanceof TextareaRenderable)) throw new Error("Expected answer comment editor")
  editor.setText("Use practical examples.")
  await ui.press("\r")
  await ui.frame("Who is the audience?")
  await ui.press("\r")
  await ui.frame("How detailed should it be?")
  await ui.press("c")
  await wait(() => ui.app.renderer.currentFocusedEditor instanceof TextareaRenderable)
  const comment = ui.app.renderer.currentFocusedEditor
  if (!(comment instanceof TextareaRenderable)) throw new Error("Expected answer comment editor")
  comment.setText("Keep it on one page.")
  await ui.press("\r")
  await ui.frame("No option selected")
  await ui.press("\r")
  await ui.frame("[a] Use prompt")
  const answers = ui.requests.at(-1)!.body.answers
  expect(answers).toContain('"option":"Developers"')
  expect(answers).toContain('"comment":"Use practical examples."')
  expect(answers).toContain('"option":null,"comment":"Keep it on one page."')
  expect(ui.requests.every((item) => item.path === "/forge/enhance/stream")).toBe(true)
})

test("skipping optional clarification does not select a default answer", async () => {
  await using root = await tmpdir()
  let calls = 0
  const original = "Improve the guide"
  using ui = await mount(root.path, true, [], [], async (path) => {
    if (path !== "/forge/enhance/stream") return undefined
    return enhanced(
      original,
      calls++ === 0
        ? [
            {
              kind: "clarify",
              question: "Which audience?",
              impact: "This changes the examples.",
              options: ["Developers", "Users"],
            },
          ]
        : [],
    )
  })
  ui.prompt.set({ input: `/enhance ${original}`, parts: [] })
  await ui.press("\r")
  await ui.frame("Which audience?")
  await ui.press("s")
  await ui.frame("[a] Use prompt")
  expect(ui.requests.at(-1)?.body.answers).toContain('"option":null')
  expect(ui.requests.at(-1)?.body.answers).toContain('"skipped":true')
  expect(ui.requests.some((item) => item.path.startsWith("/session/"))).toBe(false)
})

test("a skipped consequential question cannot authorize use of the prompt", async () => {
  await using root = await tmpdir()
  const original = "Clean up customer records"
  using ui = await mount(root.path, true, [], [], async (path) => {
    if (path !== "/forge/enhance/stream") return undefined
    return enhanced(original, [
      {
        kind: "blocking",
        question: "Is permanent deletion authorized?",
        impact: "Records cannot be recovered.",
        options: ["Retain records", "Delete with authorization"],
      },
    ])
  })
  ui.prompt.set({ input: `/enhance ${original}`, parts: [] })
  await ui.press("\r")
  await ui.frame("Is permanent deletion authorized?")
  await ui.press("s")
  await wait(() => ui.requests.length === 2)
  await ui.frame("Is permanent deletion authorized?")
  await ui.press("o")
  await ui.frame("[a] Use prompt")
  await ui.press("a")
  await ui.frame("A consequential decision is still unresolved")
  expect(ui.requests.every((item) => item.path === "/forge/enhance/stream")).toBe(true)
})

test("cancelling a feedback revision preserves typed feedback and ignores late completion", async () => {
  await using root = await tmpdir()
  const entered = Promise.withResolvers<Request>()
  const gate = Promise.withResolvers<void>()
  const original = "Preserve the API"
  let calls = 0
  using ui = await mount(root.path, true, [], [], async (path, request) => {
    if (path !== "/forge/enhance/stream") return undefined
    if (calls++ === 0) return enhanced(original)
    entered.resolve(request)
    await gate.promise
    return enhanced(original)
  })
  try {
    ui.prompt.set({ input: `/enhance ${original}`, parts: [] })
    const draft = structuredClone(unwrap(ui.prompt.current))
    await ui.press("\r")
    await ui.frame("[a] Use prompt")
    await ui.press("c")
    await wait(() => ui.app.renderer.currentFocusedEditor instanceof TextareaRenderable)
    const editor = ui.app.renderer.currentFocusedEditor
    if (!(editor instanceof TextareaRenderable)) throw new Error("Expected feedback editor")
    editor.setText("Add compatibility tests.")
    await ui.press("\r")
    const request = await entered.promise
    await ui.press("\x1b")
    await ui.frame("Give feedback to improve this revision")
    await wait(() => ui.app.renderer.currentFocusedEditor instanceof TextareaRenderable)
    const restored = ui.app.renderer.currentFocusedEditor
    if (!(restored instanceof TextareaRenderable)) throw new Error("Expected restored feedback editor")
    expect(restored.plainText).toBe("Add compatibility tests.")
    expect(request.signal.aborted).toBe(true)
    gate.resolve()
    await ui.app.flush()
    expect(ui.prompt.current).toEqual(draft)
    expect(ui.requests.some((item) => item.path === "/forge/validate")).toBe(false)
  } finally {
    gate.resolve()
  }
})

test("citation failure retains answers and grouped activity without sending a prompt", async () => {
  await using root = await tmpdir()
  const original = "Improve the codebase"
  let calls = 0
  using ui = await mount(root.path, true, [], [], async (path) => {
    if (path !== "/forge/enhance/stream") return undefined
    if (calls++ === 0)
      return enhanced(original, [
        {
          kind: "clarify",
          question: "What is the goal?",
          impact: "Sets the constraints.",
          options: ["Performance", "Architecture"],
        },
      ])
    const frames = [
      {
        type: "progress",
        stage: "Checking evidence",
        activity: {
          total: 1,
          counts: { context: 1 },
          entries: [{ action: "Selected for model", path: "src/core.ts:10-20", detail: "Keyword match" }],
        },
      },
      { type: "error", message: "The model cited evidence outside this revision. Your prompt and answers were kept." },
    ]
    return new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""), {
      headers: { "content-type": "text/event-stream" },
    })
  })
  ui.prompt.set({ input: `/enhance ${original}`, parts: [] })
  const draft = structuredClone(unwrap(ui.prompt.current))
  await ui.press("\r")
  await ui.frame("What is the goal?")
  await ui.press("\x1b[B")
  await ui.press(" ")
  await ui.press("\r")
  await ui.frame("evidence outside this revision")
  await ui.press("t")
  await ui.frame("Selected context (1 updates)")
  expect(ui.app.captureCharFrame()).not.toContain("src/core.ts:10-20")
  await ui.press("\t")
  await ui.press("\t")
  await ui.press("\t")
  await ui.press("\r")
  await ui.frame("src/core.ts:10-20")
  await ui.press("\x1b")
  await ui.frame("[r] Retry same request")
  await ui.press("\r")
  await ui.frame("[x] Architecture")
  await ui.frame("evidence outside this revision")
  expect(ui.prompt.current).toEqual(draft)
  expect(calls).toBe(2)
  expect(ui.requests.every((item) => item.path === "/forge/enhance/stream")).toBe(true)
})

test("failed clarification retries preserve selections and comments without replaying questions or sending", async () => {
  await using root = await tmpdir()
  const original = "Improve the build"
  const message =
    "The model returned an incomplete or invalid enhancement response (check: verification). Your prompt and answers were kept."
  let calls = 0
  using ui = await mount(root.path, true, [], [], async (path) => {
    if (path !== "/forge/enhance/stream") return undefined
    calls++
    if (calls === 1)
      return enhanced(original, [
        {
          kind: "clarify",
          question: "What is the build for?",
          impact: "Controls the build options.",
          options: ["Development", "Production"],
        },
      ])
    if (calls < 4)
      return new Response(`data: ${JSON.stringify({ type: "error", message })}\n\n`, {
        headers: { "content-type": "text/event-stream" },
      })
    return enhanced(original)
  })
  ui.prompt.set({ input: `/enhance ${original}`, parts: [] })
  const draft = structuredClone(unwrap(ui.prompt.current))
  await ui.press("\r")
  await ui.frame("What is the build for?")
  await ui.press("\x1b[B")
  await ui.press(" ")
  await ui.press("c")
  await wait(() => ui.app.renderer.currentFocusedEditor instanceof TextareaRenderable)
  const editor = ui.app.renderer.currentFocusedEditor
  if (!(editor instanceof TextareaRenderable)) throw new Error("Expected comment editor")
  editor.setText("Keep source maps for debugging.")
  await ui.press("\r")
  await ui.frame("[x] Production")
  await ui.press("\r")
  await ui.frame("[r] Retry same request")
  expect(ui.app.captureCharFrame()).not.toContain("Clarification 1/1")
  expect(calls).toBe(2)
  const failed = ui.requests.at(-1)!.body
  expect(failed.answers).toContain('"option":"Production"')
  expect(failed.answers).toContain('"comment":"Keep source maps for debugging."')
  await ui.press("a")
  expect(ui.requests).toHaveLength(2)
  await ui.press("r")
  await wait(() => calls === 3)
  await ui.frame("[r] Retry same request")
  expect(ui.requests.at(-1)!.body).toEqual(failed)
  await ui.press("\r")
  await ui.frame("[x] Production")
  await ui.frame("Keep source maps for debugging.")
  expect(calls).toBe(3)
  await ui.press("c")
  await wait(() => ui.app.renderer.currentFocusedEditor instanceof TextareaRenderable)
  const comment = ui.app.renderer.currentFocusedEditor
  if (!(comment instanceof TextareaRenderable)) throw new Error("Expected saved comment editor")
  expect(comment.plainText).toBe("Keep source maps for debugging.")
  comment.setText("Keep source maps and avoid publishing.")
  await ui.app.flush()
  expect(ui.app.captureCharFrame()).not.toContain("check: verification")
  await ui.press("\r")
  await ui.press("\r")
  await ui.frame("[a] Use prompt")
  expect(ui.requests.at(-1)!.body.answers).toContain('"option":"Production"')
  expect(ui.requests.at(-1)!.body.answers).toContain("Keep source maps and avoid publishing.")
  expect(String(ui.requests.at(-1)!.body.answers).match(/Clarification responses:/g) ?? []).toHaveLength(1)
  expect(ui.prompt.current).toEqual(draft)
  expect(ui.requests.every((item) => item.path === "/forge/enhance/stream")).toBe(true)
  await ui.press("\r")
  await wait(() => ui.prompt.focused)
  expect(ui.requests.at(-1)?.path).toBe("/forge/validate")
  expect(ui.requests.some((item) => item.path.startsWith("/session/"))).toBe(false)
})

test("cancelling an explicit retry restores saved feedback and ignores late completion", async () => {
  await using root = await tmpdir()
  const original = "Improve the guide"
  const entered = Promise.withResolvers<Request>()
  const gate = Promise.withResolvers<void>()
  let calls = 0
  using ui = await mount(root.path, true, [], [], async (path, request) => {
    if (path !== "/forge/enhance/stream") return undefined
    calls++
    if (calls === 1) return enhanced(original)
    if (calls === 2) return json({ message: "Incomplete model response" }, { status: 502 })
    entered.resolve(request)
    await gate.promise
    return enhanced(original)
  })
  try {
    ui.prompt.set({ input: `/enhance ${original}`, parts: [] })
    const draft = structuredClone(unwrap(ui.prompt.current))
    await ui.press("\r")
    await ui.frame("[a] Use prompt")
    await ui.press("c")
    await wait(() => ui.app.renderer.currentFocusedEditor instanceof TextareaRenderable)
    const editor = ui.app.renderer.currentFocusedEditor
    if (!(editor instanceof TextareaRenderable)) throw new Error("Expected feedback editor")
    editor.setText("Keep the examples concise.")
    await ui.press("\r")
    await ui.frame("[r] Retry same request")
    const failed = ui.requests.at(-1)!.body
    await ui.press("r")
    const request = await entered.promise
    expect(ui.requests.at(-1)!.body).toEqual(failed)
    await ui.press("\x1b")
    await ui.frame("Give feedback to improve this revision")
    await wait(() => ui.app.renderer.currentFocusedEditor instanceof TextareaRenderable)
    const saved = ui.app.renderer.currentFocusedEditor
    if (!(saved instanceof TextareaRenderable)) throw new Error("Expected saved feedback editor")
    expect(saved.plainText).toBe("Keep the examples concise.")
    expect(request.signal.aborted).toBe(true)
    gate.resolve()
    await ui.app.flush()
    expect(ui.app.captureCharFrame()).not.toContain("[a] Use prompt")
    expect(ui.app.captureCharFrame()).not.toContain("Incomplete model response")
    expect(ui.prompt.current).toEqual(draft)
    expect(calls).toBe(3)
    expect(ui.requests.every((item) => item.path === "/forge/enhance/stream")).toBe(true)
  } finally {
    gate.resolve()
  }
})

test.each(["option", "comment", "both"] as const)(
  "review cannot silently discard pending %s clarification input",
  async (mode) => {
    await using root = await tmpdir()
    const original = "Improve the documentation"
    const calls: string[] = []
    using ui = await mount(root.path, true, [], [], async (path) => {
      if (path !== "/forge/enhance/stream") return undefined
      calls.push(path)
      if (calls.length > 1) return undefined
      return enhanced(original, [
        {
          kind: "clarify",
          question: "Who is the audience?",
          impact: "Examples depend on the audience.",
          options: ["Developers", "Users"],
        },
      ])
    })
    ui.prompt.set({ input: `/enhance ${original}`, parts: [] })
    await ui.press("\r")
    await ui.frame("Who is the audience?")
    if (mode !== "comment") await ui.press(" ")
    if (mode !== "option") {
      await ui.press("c")
      await wait(() => ui.app.renderer.currentFocusedEditor instanceof TextareaRenderable)
      const editor = ui.app.renderer.currentFocusedEditor
      if (!(editor instanceof TextareaRenderable)) throw new Error("Expected comment editor")
      editor.setText("Require keyboard examples.")
      await ui.press("\r")
    }
    await ui.press("o")
    await ui.frame("[a] Use prompt")
    await ui.press("a")
    await ui.frame("have not been incorporated")
    expect(ui.requests).toHaveLength(1)
    await ui.press("o")
    await ui.press("a")
    await ui.press("g")
    await ui.frame("Revision 2")
    const body = ui.requests.at(-1)!.body
    expect(body.answers).toContain(mode !== "comment" ? '"option":"Developers"' : '"option":null')
    if (mode !== "option") expect(body.answers).toContain("Require keyboard examples.")
    await ui.press("a")
    await wait(() => ui.prompt.focused)
    expect(ui.requests.at(-1)?.path).toBe("/forge/validate")
    if (mode !== "option") expect(ui.prompt.current.input).toContain("Require keyboard examples.")
    expect(ui.requests.some((item) => item.path.startsWith("/session/"))).toBe(false)
  },
)

test("discarding pending answers requires an explicit choice and does not generate another revision", async () => {
  await using root = await tmpdir()
  const original = "Improve the documentation"
  using ui = await mount(root.path, true, [], [], async (path) =>
    path === "/forge/enhance/stream"
      ? enhanced(original, [
          {
            kind: "clarify",
            question: "Who is the audience?",
            impact: "Examples depend on the audience.",
            options: ["Developers", "Users"],
          },
        ])
      : undefined,
  )
  ui.prompt.set({ input: `/enhance ${original}`, parts: [] })
  await ui.press("\r")
  await ui.frame("Who is the audience?")
  await ui.press(" ")
  await ui.press("o")
  await ui.press("a")
  await ui.frame("[x] Discard pending answers")
  await ui.press("x")
  await wait(() => ui.prompt.focused)
  expect(ui.requests.map((item) => item.path)).toEqual(["/forge/enhance/stream", "/forge/validate"])
  expect(ui.prompt.current.input).not.toContain('"option":"Developers"')
})

test("human additions and removals are sent as authoritative edits during feedback", async () => {
  await using root = await tmpdir()
  using ui = await mount(root.path)
  ui.prompt.set({ input: "/enhance Include screenshots. Preserve compatibility.", parts: [] })
  await ui.press("\r")
  await ui.frame("[a] Use prompt")
  await ui.press("e")
  await wait(() => ui.app.renderer.currentFocusedEditor instanceof TextareaRenderable)
  const editor = ui.app.renderer.currentFocusedEditor
  if (!(editor instanceof TextareaRenderable)) throw new Error("Expected prompt editor")
  editor.setText(
    editor.plainText.replace("Include screenshots.", "Do not include screenshots.") + "\nAlways support offline usage.",
  )
  await ui.press("\r")
  await ui.press("c")
  await wait(() => ui.app.renderer.currentFocusedEditor instanceof TextareaRenderable)
  const feedback = ui.app.renderer.currentFocusedEditor
  if (!(feedback instanceof TextareaRenderable)) throw new Error("Expected feedback editor")
  feedback.setText("Make the wording clearer.")
  await ui.press("\r")
  await ui.frame("Revision 2")
  expect(JSON.stringify(ui.requests.at(-1)?.body.edits)).toContain("Always support offline usage.")
  expect(JSON.stringify(ui.requests.at(-1)?.body.edits)).toContain("Do not include screenshots.")
  expect(ui.requests.at(-1)?.body.feedback).toBe("Make the wording clearer.")
  expect(ui.requests.at(-1)?.body.text).toBe("Include screenshots. Preserve compatibility.")
  await ui.press("a")
  await wait(() => ui.prompt.focused)
  expect(ui.prompt.current.input).toContain("Explicit developer edits")
  expect(ui.prompt.current.input).toContain("Always support offline usage.")
})

test("repeated skipped optional questions return to review without another forced model request", async () => {
  await using root = await tmpdir()
  const original = "Improve the guide"
  using ui = await mount(root.path, true, [], [], async (path) =>
    path === "/forge/enhance/stream"
      ? enhanced(original, [
          {
            kind: "clarify",
            question: "Which audience?",
            impact: "This changes the examples.",
            options: ["Developers", "Users"],
          },
        ])
      : undefined,
  )
  ui.prompt.set({ input: `/enhance ${original}`, parts: [] })
  await ui.press("\r")
  await ui.frame("Which audience?")
  await ui.press("s")
  await ui.frame("Previously answered or skipped")
  await ui.frame("[a] Use prompt")
  expect(ui.requests).toHaveLength(2)
  expect(ui.requests.at(-1)?.body.answers).toContain('"skipped":true')
  await ui.press("s")
  expect(ui.requests).toHaveLength(2)
  await ui.press("a")
  await wait(() => ui.prompt.focused)
  expect(ui.requests.at(-1)?.path).toBe("/forge/validate")
})

test("pending answers and comments are incorporated when giving feedback directly from review", async () => {
  await using root = await tmpdir()
  const calls: string[] = []
  using ui = await mount(root.path, true, [], [], async (path) => {
    if (path !== "/forge/enhance/stream") return undefined
    calls.push(path)
    if (calls.length > 1) return undefined
    return enhanced("Improve the guide", [
      { kind: "clarify", question: "Which audience?", impact: "Examples vary.", options: ["Developers", "Users"] },
    ])
  })
  ui.prompt.set({ input: "/enhance Improve the guide", parts: [] })
  await ui.press("\r")
  await ui.frame("Which audience?")
  await ui.press(" ")
  await ui.press("c")
  await wait(() => ui.app.renderer.currentFocusedEditor instanceof TextareaRenderable)
  const comment = ui.app.renderer.currentFocusedEditor
  if (!(comment instanceof TextareaRenderable)) throw new Error("Expected comment editor")
  comment.setText("Include keyboard examples.")
  await ui.press("\r")
  await ui.press("o")
  await ui.press("c")
  await wait(() => ui.app.renderer.currentFocusedEditor instanceof TextareaRenderable)
  const feedback = ui.app.renderer.currentFocusedEditor
  if (!(feedback instanceof TextareaRenderable)) throw new Error("Expected feedback editor")
  feedback.setText("Keep it concise.")
  await ui.press("\r")
  await ui.frame("Revision 2")
  expect(ui.requests.at(-1)?.body.answers).toContain('"option":"Developers"')
  expect(ui.requests.at(-1)?.body.answers).toContain("Include keyboard examples.")
  expect(ui.requests.at(-1)?.body.feedback).toBe("Keep it concise.")
})

test("verification failure retains clarification input and explicit retry adds only bounded format guidance", async () => {
  await using root = await tmpdir()
  const calls: string[] = []
  const issues = [{ path: ["verification"], expected: "array", actual: "missing" }]
  using ui = await mount(root.path, true, [], [], async (path) => {
    if (path !== "/forge/enhance/stream") return undefined
    calls.push(path)
    if (calls.length === 1)
      return enhanced("Improve the guide", [
        { kind: "clarify", question: "Which audience?", impact: "Examples vary.", options: ["Developers", "Users"] },
      ])
    if (calls.length === 2)
      return json(
        {
          message: "verification: missing (required array). Your prompt and answers were kept.",
          failure: { code: "schema", schema: "forge-enhancement-v2", issues, model: "test/test" },
        },
        { status: 500 },
      )
    return undefined
  })
  ui.prompt.set({ input: "/enhance Improve the guide", parts: [] })
  await ui.press("\r")
  await ui.frame("Which audience?")
  await ui.press(" ")
  await ui.press("c")
  await wait(() => ui.app.renderer.currentFocusedEditor instanceof TextareaRenderable)
  const editor = ui.app.renderer.currentFocusedEditor
  if (!(editor instanceof TextareaRenderable)) throw new Error("Expected comment editor")
  editor.setText("Include keyboard examples.")
  await ui.press("\r")
  await ui.press("\r")
  await ui.frame("[r] Retry same request")
  await ui.frame("verification: missing")
  await ui.frame("Revision 1")
  const saved = ui.requests.at(-1)!.body
  expect(saved.answers).toContain("Include keyboard examples.")
  await ui.press("r")
  await ui.frame("Revision 2")
  const retried = ui.requests.at(-1)!.body
  expect(retried).toMatchObject({
    text: saved.text,
    answers: saved.answers,
    revision: saved.revision,
    model: saved.model,
    retry: issues,
  })
  expect(String(retried.answers).match(/Clarification responses:/g)).toHaveLength(1)
  expect(ui.requests).toHaveLength(3)
  await ui.press("a")
  await wait(() => ui.prompt.focused)
  expect(ui.prompt.current.input).toContain("Include keyboard examples.")
  expect(ui.requests.at(-1)?.path).toBe("/forge/validate")
  expect(ui.requests.some((item) => item.path.startsWith("/session/"))).toBe(false)
})

test("changing models after editing failed clarification input uses the new answers instead of the saved attempt", async () => {
  await using root = await tmpdir()
  let calls = 0
  using ui = await mount(root.path, true, [], [], async (path) => {
    if (path !== "/forge/enhance/stream") return undefined
    calls++
    if (calls === 1)
      return enhanced("Improve the guide", [
        { kind: "clarify", question: "Which audience?", impact: "Examples vary.", options: ["Developers", "Users"] },
      ])
    if (calls === 2) return json({ message: "Invalid response" }, { status: 502 })
    return undefined
  })
  ui.prompt.set({ input: "/enhance Improve the guide", parts: [] })
  await ui.press("\r")
  await ui.frame("Which audience?")
  await ui.press(" ")
  await ui.press("\r")
  await ui.frame("[r] Retry same request")
  const saved = ui.requests.at(-1)?.body.answers
  await ui.press("e")
  await ui.frame("[x] Developers")
  await ui.press("\x1b[B")
  await ui.press(" ")
  await ui.frame("[x] Users")
  await ui.press("v")
  await wait(() => ui.app.renderer.currentFocusedEditor instanceof TextareaRenderable)
  const editor = ui.app.renderer.currentFocusedEditor
  if (!(editor instanceof TextareaRenderable)) throw new Error("Expected model editor")
  editor.setText("test/another")
  await ui.press("\r")
  await ui.frame("[a] Use prompt")
  expect(ui.requests).toHaveLength(3)
  expect(ui.requests.at(-1)?.body.model).toEqual({ providerID: "test", modelID: "another" })
  expect(ui.requests.at(-1)?.body.answers).not.toBe(saved)
  expect(ui.requests.at(-1)?.body.answers).toContain('"option":"Users"')
  expect(ui.requests.at(-1)?.body.answers).not.toContain('"option":"Developers"')
})

test.each(["timeout", "transport"] as const)(
  "%s during a clarification revision keeps the previous draft and answers for explicit recovery",
  async (code) => {
    await using root = await tmpdir()
    let calls = 0
    using ui = await mount(root.path, true, [], [], async (path) => {
      if (path !== "/forge/enhance/stream") return undefined
      calls++
      if (calls === 1)
        return enhanced("Improve the guide", [
          { kind: "clarify", question: "Which audience?", impact: "Examples vary.", options: ["Developers", "Users"] },
        ])
      if (calls === 2)
        return new Response(
          `data: ${JSON.stringify({
            type: "error",
            message: "Generation did not complete. Your input was kept.",
            failure: { code, schema: "forge-enhancement-v2", issues: [], model: "test/test" },
          })}\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        )
      return undefined
    })
    ui.prompt.set({ input: "/enhance Improve the guide", parts: [] })
    await ui.press("\r")
    await ui.frame("Which audience?")
    await ui.press(" ")
    await ui.press("\r")
    await ui.frame("[r] Retry same request")
    expect(calls).toBe(2)
    const saved = ui.requests.at(-1)?.body
    await ui.press("r")
    await ui.frame("Revision 2")
    expect(calls).toBe(3)
    expect(ui.requests.at(-1)?.body).toEqual(saved)
    await ui.press("a")
    await wait(() => ui.prompt.focused)
    expect(ui.requests.some((item) => item.path.startsWith("/session/"))).toBe(false)
    expect(ui.prompt.current.input).toContain('"option":"Developers"')
  },
)
