/** @jsxImportSource @opentui/solid */
/** @jsxImportSource @opentui/solid */
import { TextareaRenderable } from "@opentui/core"
import { expect, test } from "bun:test"
import { unwrap } from "solid-js/store"
import { wait } from "../cli/cmd/tui/sync-fixture"
import { tmpdir } from "../fixture/fixture"
import { source } from "@kilocode/forge/parse"
import { usage } from "@kilocode/forge/schema"
import type { Round } from "@kilocode/forge/investigation"
import { workshop, mount } from "./forge-composer-fixture"

test("investigative provider errors remain visible without losing input or retrying automatically", async () => {
  await using root = await tmpdir()
  const state = workshop(root.path)
  const round: Round = {
    request: crypto.randomUUID(),
    number: 1,
    final: false,
    state: "failed",
    started: 1,
    updated: 2,
    summary: "Provider rate limit; no tool executed.",
    included: [],
    omitted: [],
    requested: 0,
    inspections: [],
  }
  using ui = await mount(
    root.path,
    true,
    [],
    [],
    async (path) => {
      if (path !== "/forge/investigations/stream") return undefined
      return new Response(
        `data: ${JSON.stringify({
          type: "progress",
          stage: "Investigation did not complete",
          turns: 0,
          calls: 0,
          journal: [round],
          observations: [],
        })}\n\ndata: ${JSON.stringify({
          type: "error",
          message:
            "Enhancement provider failure (HTTP 429): The provider rate-limited this request. Your prompt and answers were kept.",
        })}\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      )
    },
    undefined,
    () => root.path,
    undefined,
    state,
  )
  ui.prompt.set({ input: "/enhance fix the backend", parts: [] })
  await ui.press("\r")
  await ui.frame("HTTP 429")
  await ui.frame("rate-limited")
  expect(ui.requests.map((item) => item.path)).toEqual(["/forge/investigations/stream"])
  expect(ui.prompt.current.input).toBe("/enhance fix the backend")
  const editor = ui.app.renderer.currentFocusedEditor
  expect(editor).toBeInstanceOf(TextareaRenderable)
  if (!(editor instanceof TextareaRenderable)) throw new Error("Expected preserved investigation input")
  expect(editor.plainText).toBe("fix the backend")
  await ui.press("\x14")
  await ui.frame("Turn 1")
  await ui.frame("Provider rate limit; no tool executed.")
  expect(ui.requests).toHaveLength(1)
  await ui.press("\x1b")
  await ui.frame("What should the agent investigate?")
  await ui.press("\x1b")
  await wait(() => ui.prompt.focused)
  expect(ui.requests).toHaveLength(1)
  expect(ui.prompt.current.input).toBe("/enhance fix the backend")
})

test("investigation streams public activity by turn and preserves compact review controls", async () => {
  await using root = await tmpdir()
  const state = workshop(root.path)
  const first: Round = {
    request: crypto.randomUUID(),
    number: 1,
    final: false,
    state: "complete",
    started: 1,
    updated: 10,
    summary: "Parsed two tool requests",
    note: "Checking queue.ts and its caller before recommending changes.",
    usage: { ...usage(), input: 80, output: 20, cached: 10, measured: true },
    reasoning: 5,
    bytes: 500,
    included: [],
    omitted: [],
    requested: 2,
    inspections: [
      {
        id: "read",
        tool: "forge_read_file",
        input: '{"path":"queue.ts"}',
        state: "complete",
        activity: {
          total: 1,
          counts: { repository: 1 },
          entries: [{ action: "Scan complete", detail: "2 files seen; 2 files read; 2 parse attempts." }],
        },
      },
      { id: "caller", tool: "forge_read_file", input: '{"path":"caller.ts"}', state: "complete" },
    ],
  }
  state.investigation = {
    ...state.investigation,
    journal: [
      first,
      {
        ...first,
        request: crypto.randomUUID(),
        number: 2,
        final: true,
        summary: "Validated one finding",
        note: "The append implementation needs a duplicate guard.",
        included: ["read", "caller"],
        requested: 1,
        inspections: [
          {
            id: "finish",
            tool: "forge_finish",
            input: "Conclusion payload; see the validated review.",
            state: "complete",
          },
        ],
      },
    ],
    observations: [
      ...state.investigation.observations.map((item) => ({ ...item, turn: 1 })),
      {
        id: "caller",
        turn: 1,
        tool: "forge_read_file",
        input: { path: "caller.ts" },
        output: "caller feedback",
        observed: 2,
        sources: [],
      },
    ],
  }
  const updated = Promise.withResolvers<void>()
  const done = Promise.withResolvers<void>()
  using ui = await mount(
    root.path,
    true,
    [],
    [],
    async (path) => {
      if (path !== "/forge/investigations/stream") return undefined
      return new Response(
        new ReadableStream({
          start(controller) {
            const send = (value: unknown) =>
              controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`))
            send({
              type: "progress",
              stage: "Turn complete",
              turns: 1,
              calls: 2,
              journal: [first],
              observations: state.investigation.observations,
            })
            void updated.promise.then(() =>
              send({
                type: "progress",
                stage: "Turn complete",
                turns: 1,
                calls: 2,
                journal: [
                  {
                    ...first,
                    inspections: first.inspections.map((call) =>
                      call.id !== "read"
                        ? call
                        : {
                            ...call,
                            activity: {
                              total: 2,
                              counts: { repository: 2 },
                              entries: [
                                ...call.activity!.entries,
                                { action: "Read locally", detail: "Live activity update retained" },
                              ],
                            },
                          },
                    ),
                  },
                ],
                observations: state.investigation.observations,
              }),
            )
            void done.promise.then(() => {
              send({ type: "result", investigation: state.investigation })
              controller.close()
            })
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      )
    },
    undefined,
    () => root.path,
    undefined,
    state,
  )
  ui.app.renderer.resize(100, 45)
  ui.prompt.set({ input: "/enhance Fix duplicate queue items", parts: [] })
  await ui.press("\r")
  await ui.frame("Turn history")
  await ui.frame("Checking queue.ts and its caller")
  const frame = ui.app.captureCharFrame()
  expect(frame.split("\n").find((line) => line.includes("Turn 1"))).not.toContain("|")
  expect(frame).not.toContain("calls complete")
  expect(frame).not.toContain("Parsed two tool requests")
  expect(frame).not.toContain("Request ")
  expect(frame).not.toContain("Tokens (")
  expect(ui.app.captureCharFrame()).not.toContain("rawEvidenceCanary")
  await ui.frame("File Activity (1 recorded updates)")
  await ui.press("f")
  await ui.press("\r")
  await ui.frame("2 parse attempts")
  updated.resolve()
  await ui.frame("File Activity (2 recorded updates)")
  await ui.press("\x1b[6~")
  await ui.frame("Live activity update retained")
  expect(
    ui.app
      .captureCharFrame()
      .split("\n")
      .find((line) => line.includes("Arrows/Tab sections")),
  ).not.toContain("\u2502")
  expect(ui.app.captureCharFrame()).toContain("Forge /enhance: Prepare your prompt")
  await ui.press("\r")
  expect(ui.app.captureCharFrame()).not.toContain("Live activity update retained")
  await ui.press("f")
  await ui.press("r")
  await ui.frame("Tokens (provider-reported)")
  await ui.press("\x1b[6~")
  await ui.frame("rawEvidenceCanary")
  expect(ui.requests).toHaveLength(1)
  state.investigation = { ...state.investigation, id: String(ui.requests.at(0)?.body.key) }
  done.resolve()
  await ui.frame("Choose what to include")
  await ui.press("t")
  await ui.frame("Turn 2")
  await ui.frame("The append implementation needs a duplicate guard.")
  await ui.press("w")
  expect(ui.requests).toHaveLength(1)
  await ui.press("\x1b[A")
  await ui.press("\r")
  await ui.frame("Checking queue.ts and its caller")
  ui.app.renderer.resize(80, 24)
  await ui.frame("Turn history")
  await ui.frame("Enter/Space expand")
  await ui.press("\x1b")
  await ui.frame("Choose what to include")
  expect(ui.requests.some((item) => item.path.startsWith("/session/"))).toBe(false)
})

test("turn headings stay simple while public focus and real scan activity update live", async () => {
  await using root = await tmpdir()
  const state = workshop(root.path)
  const round: Round = {
    request: crypto.randomUUID(),
    number: 1,
    final: false,
    state: "tools",
    started: 1,
    updated: 2,
    summary: "Parsed one tool request",
    note: "Checking queue handling before following its callers.",
    included: [],
    omitted: [],
    requested: 1,
    inspections: [
      {
        id: "search",
        tool: "forge_search_code",
        input: '{"query":"queue retries"}',
        state: "running",
        activity: {
          total: 1,
          counts: { repository: 1 },
          entries: [{ action: "Scan repository", detail: "Read supported files" }],
        },
      },
    ],
  }
  const change = Promise.withResolvers<(value: Round) => void>()
  const done = Promise.withResolvers<void>()
  using ui = await mount(
    root.path,
    true,
    [],
    [],
    async (path) => {
      if (path !== "/forge/investigations/stream") return undefined
      return new Response(
        new ReadableStream({
          start(controller) {
            const send = (value: unknown) =>
              controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`))
            const update = (item: Round) =>
              send({
                type: "progress",
                stage: "Inspecting with forge_search_code",
                started: 1,
                elapsed: 4000,
                turns: 1,
                calls: 1,
                journal: [item],
                observations: [],
              })
            change.resolve(update)
            update(round)
            void done.promise.then(() => {
              send({ type: "result", investigation: state.investigation })
              controller.close()
            })
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      )
    },
    undefined,
    () => root.path,
    undefined,
    state,
  )
  ui.app.renderer.resize(100, 36)
  ui.prompt.set({ input: "/enhance Fix duplicate queue items", parts: [] })
  await ui.press("\r")
  await ui.frame("Scanning repository inventory (4s elapsed)")
  await ui.frame("Checking queue handling before following its callers.")
  const frame = ui.app.captureCharFrame()
  expect(frame.split("\n").find((line) => line.includes("Turn 1"))).not.toContain("|")
  expect(frame).not.toContain("calls complete")
  expect(frame).not.toContain("1 started")
  expect(frame).not.toContain("1 completed")
  expect(frame).not.toContain("Parsed one tool request")
  expect(frame).not.toContain("Inspecting with forge_search_code")
  const update = await change.promise
  update({
    ...round,
    inspections: round.inspections.map((item) => ({
      ...item,
      activity: {
        total: 2,
        counts: { repository: 2 },
        entries: [
          ...item.activity!.entries,
          { action: "Read locally", path: "src/queue.ts", detail: "Repository bytes read" },
        ],
      },
    })),
  })
  await ui.frame("Reading src/queue.ts")
  expect(ui.app.captureCharFrame()).not.toContain("Scanning repository inventory")
  expect(ui.requests).toHaveLength(1)
  state.investigation = { ...state.investigation, id: String(ui.requests.at(0)?.body.key) }
  done.resolve()
  await ui.frame("Choose what to include")
})

test("each investigation turn restores all five independently expandable File Activity sections", async () => {
  await using root = await tmpdir()
  const state = workshop(root.path)
  const first: Round = {
    request: crypto.randomUUID(),
    number: 1,
    final: false,
    state: "complete",
    started: 1,
    updated: 10,
    summary: "Search and selection completed",
    included: [],
    omitted: [],
    requested: 2,
    inspections: [
      {
        id: "search",
        tool: "forge_search_code",
        input: '{"query":"queue"}',
        state: "complete",
        activity: {
          total: 113,
          counts: { repository: 1, search: 8, retrieval: 104 },
          entries: [
            { action: "Use indexed inventory", detail: "5000 files in the existing snapshot; no new scan" },
            { action: "Search complete", detail: "BM25 search finished" },
            { action: "Retrieved candidate", path: "candidate.ts:10-20", detail: "BM25 path and content match" },
          ],
        },
      },
      {
        id: "read",
        tool: "forge_read_file",
        input: '{"path":"selected.ts"}',
        state: "complete",
        activity: {
          total: 49,
          counts: { context: 49 },
          entries: [{ action: "Selected for model", path: "selected.ts:10-20", detail: "Selected original excerpt" }],
        },
      },
    ],
  }
  state.investigation = {
    ...state.investigation,
    journal: [
      first,
      {
        ...first,
        request: crypto.randomUUID(),
        number: 2,
        summary: "Another file read",
        requested: 1,
        inspections: [
          {
            id: "other",
            tool: "forge_read_file",
            input: '{"path":"second-only.ts"}',
            state: "complete",
            activity: {
              total: 1,
              counts: { repository: 1 },
              entries: [{ action: "Read locally", path: "second-only.ts", detail: "Second turn only" }],
            },
          },
        ],
      },
    ],
  }
  using ui = await mount(root.path, true, [], [], undefined, undefined, () => root.path, undefined, state)
  ui.app.renderer.resize(110, 50)
  ui.prompt.set({ input: "/enhance Fix duplicate queue items", parts: [] })
  const draft = structuredClone(unwrap(ui.prompt.current))
  await ui.press("\r")
  await ui.frame("Choose what to include")
  await ui.press("t")
  await ui.frame("Turn 2")
  await ui.press("\x1b[A")
  await ui.press("\r")
  await ui.frame("File Activity (162 recorded updates)")
  const frame = ui.app.captureCharFrame()
  expect(frame).toContain("Repository reads (1 updates)")
  expect(frame).toContain("Search activity (8 updates)")
  expect(frame).toContain("Retrieved matches (104 updates)")
  expect(frame).toContain("Selected context (49 updates)")
  expect(frame).toContain("Evidence and citation checks (0 updates)")
  expect(frame).not.toContain("candidate.ts:10-20")
  await ui.press("f")
  await ui.press("\r")
  await ui.frame("5000 files in the existing snapshot; no new scan")
  await ui.press("\r")
  await ui.press("\t")
  await ui.press(" ")
  await ui.frame("BM25 search finished")
  await ui.press(" ")
  await ui.press("\t")
  await ui.press("\r")
  await ui.frame("candidate.ts:10-20")
  await ui.frame("Showing the latest 1 updates in this section")
  expect(ui.app.captureCharFrame()).not.toContain("selected.ts:10-20")
  await ui.press("\r")
  await ui.press("\t")
  await ui.press("\r")
  await ui.frame("selected.ts:10-20")
  expect(ui.app.captureCharFrame()).not.toContain("candidate.ts:10-20")
  await ui.press("\r")
  await ui.press("\t")
  await ui.press("\r")
  await ui.frame("No recorded operations in this section yet")
  await ui.press("\x1b")
  await ui.press("\r")
  await ui.press("\x1b[B")
  await ui.press("f")
  await ui.press("\r")
  await ui.frame("second-only.ts")
  expect(ui.app.captureCharFrame()).not.toContain("5000 files")
  expect(ui.prompt.current).toEqual(draft)
  expect(ui.requests).toHaveLength(1)
})

test("expanded turn resources scroll without drawing over the workshop header or controls", async () => {
  await using root = await tmpdir()
  const state = workshop(root.path)
  const item = source(
    "queue.ts",
    Array.from({ length: 120 }, (_, index) => `export const value${index} = ${index}`).join("\n"),
    "code",
  )
  state.investigation = {
    ...state.investigation,
    journal: [
      {
        request: crypto.randomUUID(),
        number: 1,
        final: false,
        state: "complete",
        started: 1,
        updated: 10,
        summary: "File read completed",
        note: "Inspect the queue implementation.",
        included: [],
        omitted: [],
        requested: 1,
        inspections: [{ id: "read", tool: "forge_read_file", input: '{"path":"queue.ts"}', state: "complete" }],
      },
    ],
    observations: [
      {
        id: "read",
        turn: 1,
        tool: "forge_read_file",
        input: { path: "queue.ts" },
        output: item.text,
        sources: [item],
        observed: 1,
      },
    ],
  }
  using ui = await mount(root.path, true, [], [], undefined, undefined, () => root.path, undefined, state)
  ui.app.renderer.resize(150, 50)
  ui.prompt.set({ input: "/enhance Fix duplicate queue items", parts: [] })
  await ui.press("\r")
  await ui.frame("Choose what to include")
  await ui.press("t")
  await ui.press("r")
  await ui.frame("export const value0")
  expect(
    ui.app
      .captureCharFrame()
      .split("\n")
      .find((line) => line.includes("forge_read_file")),
  ).not.toContain("\u2502")
  await ui.press("\x1b[6~")
  const frame = ui.app.captureCharFrame()
  expect(frame).toContain("Forge /enhance: Prepare your prompt")
  expect(frame).toContain("Turn history | test/test")
  expect(frame).toContain("Public updates and recorded evidence")
  expect(frame).toContain("Up/Down turns | Enter/Space expand")
  expect(frame).not.toContain("export const value0")
  expect(ui.requests).toHaveLength(1)
})

test("older investigations show resources without inventing turn boundaries", async () => {
  await using root = await tmpdir()
  const state = workshop(root.path)
  using ui = await mount(root.path, true, [], [], undefined, undefined, () => root.path, undefined, state)
  ui.prompt.set({ input: "/enhance Fix duplicate queue items", parts: [] })
  await ui.press("\r")
  await ui.frame("Choose what to include")
  await ui.press("t")
  await ui.frame("turn boundaries were not recorded")
  await ui.frame("queue.ts:1")
  expect(ui.app.captureCharFrame()).not.toContain("Turn 1")
  await ui.press("\x1b")
  await ui.frame("Choose what to include")
  expect(ui.requests).toHaveLength(1)
})
