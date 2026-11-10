/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { unwrap } from "solid-js/store"
import { wait } from "../cli/cmd/tui/sync-fixture"
import { tmpdir } from "../fixture/fixture"
import { reference as binding } from "@kilocode/forge/handoff"
import { hash } from "@kilocode/forge/util"
import { workshop, mount } from "./forge-composer-fixture"
import { TextareaRenderable } from "@opentui/core"
import { createEventSource } from "../fixture/tui-sdk"

test("investigative workshop uses Enter to select, write, and stage without submitting", async () => {
  await using root = await tmpdir()
  const state = workshop(root.path)
  using ui = await mount(root.path, true, [], [], undefined, undefined, () => root.path, undefined, state)
  ui.prompt.set({ input: "/enhance Fix duplicate queue items", parts: [] })
  await ui.press("\r")
  await ui.frame("Guard duplicate queue identifiers")
  expect(ui.requests.map((item) => item.path)).toEqual(["/forge/investigations/stream"])
  await ui.press("\r")
  await ui.frame("1 selected")
  expect(ui.requests.map((item) => item.path)).toEqual(["/forge/investigations/stream"])
  await ui.press("\r")
  await ui.frame("[a] Use prompt")
  expect(ui.requests.find((item) => item.path === "/forge/preparations")?.body.selected).toEqual(["fix"])
  expect(ui.requests.some((item) => item.path.startsWith("/session/"))).toBe(false)
  await ui.press("\r")
  await wait(() => ui.prompt.focused)
  expect(ui.prompt.current.input).toContain("Fix duplicate queue items")
  expect(ui.prompt.current.input).not.toContain("rawEvidenceCanary")
  expect(ui.prompt.current.input).not.toContain("Unselected redesign")
  expect(ui.prompt.current.input).not.toContain("<forge-evidence>")
  const value = binding(ui.prompt.current.parts)
  expect(value?.hash).toBe(hash(ui.prompt.current.input))
  await ui.press("\r")
  await wait(() => ui.requests.some((item) => item.path === "/session/ses_forge/message"))
  const request = ui.requests.find((item) => item.path === "/session/ses_forge/message")!
  const parts = request.body.parts
  expect(Array.isArray(parts)).toBe(true)
  expect(binding(Array.isArray(parts) ? parts : [])?.id).toBe(value?.id)
  expect(ui.requests.some((item) => item.path === "/forge/enhance/stream")).toBe(false)
})

test("an unresolved improvement is visibly unverified and can be selected without another questionnaire", async () => {
  await using root = await tmpdir()
  const state = workshop(root.path)
  state.investigation = {
    ...state.investigation,
    findings: state.investigation.findings.slice(0, 1).map((item) => ({
      ...item,
      title: "Improve backend throughput",
      kind: "improvement",
      support: "unresolved",
      action: "Increase concurrency.",
      unknowns: ["The bottleneck is unknown."],
    })),
  }
  using ui = await mount(root.path, true, [], [], undefined, undefined, () => root.path, undefined, state)
  ui.prompt.set({ input: "/enhance Improve backend throughput", parts: [] })
  await ui.press("\r")
  await ui.frame("Unverified direction. Investigate before choosing a fix.")
  await ui.frame("Proposed work (verify first): Increase concurrency.")
  expect(ui.app.captureCharFrame()).not.toContain("Clarification needed")
  expect(ui.requests).toHaveLength(1)
  await ui.press("\r")
  await ui.frame("1 selected")
  expect(ui.requests).toHaveLength(1)
  await ui.press("\r")
  await ui.frame("[a] Use prompt")
  expect(ui.requests.filter((item) => item.path === "/forge/investigations/stream")).toHaveLength(1)
  expect(ui.requests.some((item) => item.path.startsWith("/session/"))).toBe(false)
})

test("investigative review scrolls long findings and sources without hiding its next action", async () => {
  await using root = await tmpdir()
  const state = workshop(root.path)
  state.investigation = {
    ...state.investigation,
    findings: state.investigation.findings.map((item) => ({
      ...item,
      action: "A long action that wraps within a small terminal. ".repeat(50),
    })),
  }
  using ui = await mount(root.path, true, [], [], undefined, undefined, () => root.path, undefined, state)
  ui.app.renderer.resize(80, 24)
  ui.prompt.set({ input: "/enhance Fix duplicate queue items", parts: [] })
  await ui.press("\r")
  await ui.frame("Guard duplicate queue identifiers")
  await ui.press("\x1b[B")
  await ui.frame("Unselected redesign canary")
  await ui.frame("Enter / Space Select highlighted finding")
  await ui.press("\r")
  await ui.frame("1 selected")
  await ui.press("\r")
  await ui.frame("[a] Use prompt")
  await ui.press("s")
  await ui.frame("rawEvidenceCanary")
  await ui.press("\r")
  await ui.frame("[a] Use prompt")
  expect(ui.requests.some((item) => item.path.startsWith("/session/"))).toBe(false)
})

test("stale investigative evidence blocks composer submission and preserves the draft", async () => {
  await using root = await tmpdir()
  const state = workshop(root.path)
  using ui = await mount(root.path, true, [], [], undefined, undefined, () => root.path, undefined, state)
  ui.prompt.set({ input: "/enhance Fix duplicate queue items", parts: [] })
  await ui.press("\r")
  await ui.frame("Guard duplicate queue identifiers")
  await ui.press(" ")
  await ui.press("w")
  await ui.frame("[a] Use prompt")
  await ui.press("a")
  await wait(() => ui.prompt.focused)
  const before = structuredClone(unwrap(ui.prompt.current))
  state.stale = true
  await ui.press("\r")
  await wait(() => ui.toast.currentToast?.title === "Prepared prompt not sent")
  expect(ui.prompt.current).toEqual(before)
  expect(ui.requests.some((item) => item.path.startsWith("/session/"))).toBe(false)
})

test("a transient evidence refresh preserves typed feedback and rechecks without a model call", async () => {
  await using root = await tmpdir()
  const state = workshop(root.path)
  const events = createEventSource()
  let unavailable = false
  using ui = await mount(
    root.path,
    true,
    [],
    [],
    undefined,
    undefined,
    () => root.path,
    {
      url: "http://test",
      headers: {},
      events: events.source,
      reads: async (path) => {
        if (unavailable && path.startsWith("/forge/investigations/") && path !== "/forge/investigations/status")
          throw new TypeError("fetch failed")
        return undefined
      },
    },
    state,
  )
  ui.prompt.set({ input: "/enhance Fix duplicate queue items", parts: [] })
  await ui.press("\r")
  await ui.frame("Guard duplicate queue identifiers")
  await ui.press("f")
  await ui.frame("Your answers or feedback")
  const editor = ui.app.renderer.currentFocusedEditor
  if (!(editor instanceof TextareaRenderable)) throw new Error("Expected the feedback editor")
  editor.setText("Keep insertion order while fixing duplicates.")
  await ui.app.flush()
  unavailable = true
  events.emit({
    directory: root.path,
    payload: {
      id: crypto.randomUUID(),
      type: "forge.changed",
      properties: {
        topic: "request",
        session: "ses_forge",
        revision: crypto.randomUUID(),
      },
    },
  })
  await ui.frame("Evidence access could not be checked")
  expect(ui.requests).toHaveLength(1)
  unavailable = false
  await ui.press("\x12")
  await ui.frame("Keep insertion order while fixing duplicates.")
  expect(ui.requests).toHaveLength(1)
  expect(ui.requests.some((item) => item.path.startsWith("/session/"))).toBe(false)
})
