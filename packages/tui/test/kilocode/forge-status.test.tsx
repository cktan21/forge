/** @jsxImportSource @opentui/solid */
import { expect, spyOn, test } from "bun:test"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { onCleanup, onMount } from "solid-js"
import { TuiConfigProvider } from "../../src/config"
import { KVProvider } from "../../src/context/kv"
import { ProjectProvider } from "../../src/context/project"
import { RouteProvider, useRoute, type RouteContext } from "../../src/context/route"
import { SDKProvider } from "../../src/context/sdk"
import { ThemeProvider } from "../../src/context/theme"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../src/keymap"
import { forgePrompt } from "../../src/kilocode/forge/prompt"
import { DialogProvider, useDialog } from "../../src/ui/dialog"
import { ToastProvider } from "../../src/ui/toast"
import { tmpdir } from "../fixture/fixture"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"

async function mount(root: string) {
  await Bun.write(`${root}/kv.json`, "{}")
  const calls: Request[] = []
  const pending: ReturnType<typeof Promise.withResolvers<Response>>[] = []
  const pages: { deferred: ReturnType<typeof Promise.withResolvers<Response>>; response: Response }[] = []
  let held = false
  let route: RouteContext | undefined
  let opened = 0
  let generation = "old"
  // The actual SDK awaits a controllable transport callback, including late
  // completions that deliberately ignore abort to exercise the UI's guards.
  const fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init)
    calls.push(request)
    const path = new URL(request.url).pathname
    if (path === "/forge/status") {
      const deferred = Promise.withResolvers<Response>()
      pending.push(deferred)
      return deferred.promise
    }
    if (path === "/forge/view") {
      const response = Response.json({
        root, generation, sources: [{ kind: "file", uri: `${generation}.ts`, status: "current" }],
        page: { offset: 0, limit: 25 }, warnings: [],
      })
      if (!held) return response
      const deferred = Promise.withResolvers<Response>()
      pages.push({ deferred, response })
      return deferred.promise
    }
    throw new Error(`Unexpected inspection request: ${request.method} ${path}`)
  }, { preconnect: globalThis.fetch.preconnect.bind(globalThis.fetch) })

  function Open() {
    const dialog = useDialog()
    route = useRoute()
    onMount(() => { opened = performance.now(); forgePrompt("/overview", dialog) })
    return <text>Chat remains available</text>
  }
  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig()
    onCleanup(registerOpencodeKeymap(keymap, renderer, config))
    return <TestTuiContexts directory={root} paths={{ home: root, state: root, worktree: root }}>
      <OpencodeKeymapProvider keymap={keymap}><TuiConfigProvider config={config}>
        <SDKProvider url="http://fixture.local" directory={root} fetch={fetch} events={{ subscribe: async () => () => {} }}>
          <ProjectProvider><RouteProvider><KVProvider><ThemeProvider mode="dark" source={{ discover: async () => ({}) }}>
            <ToastProvider><DialogProvider><Open /></DialogProvider></ToastProvider>
          </ThemeProvider></KVProvider></RouteProvider></ProjectProvider>
        </SDKProvider>
      </TuiConfigProvider></OpencodeKeymapProvider>
    </TestTuiContexts>
  }
  const app = await testRender(() => <Harness />, { width: 120, height: 42 })
  return {
    app, calls, pending,
    get elapsed() { return performance.now() - opened },
    hold() { held = true },
    page(index: number, error = false) {
      const item = pages.at(index)!
      item.deferred.resolve(error ? Response.json({ message: "Source page unavailable" }, { status: 503 }) : item.response)
    },
    session() { route!.navigate({ type: "session", sessionID: "different-session" }) },
    respond(index: number, value = "loaded", error = false) {
      generation = value
      pending.at(index)!.resolve(error ? Response.json({ message: value }, { status: 503 }) : Response.json({
        inventory: { root, generation: value, indexed: true, files: 17, counts: { code: 17 }, partial: false, warnings: [] },
        session: "", job: { id: "", state: "idle", started: 0, updated: 0, message: "Ready" },
      }))
    },
    async frame(text: string | RegExp, absent = "", timeout = 3000) {
      const deadline = performance.now() + timeout
      do {
        await app.renderOnce()
        const frame = app.captureCharFrame()
        if ((typeof text === "string" ? frame.includes(text) : text.test(frame)) && (!absent || !frame.includes(absent))) return frame
        await Bun.sleep(5)
      } while (performance.now() < deadline)
      throw new Error(`Missing ${text}\n${app.captureCharFrame()}`)
    },
    [Symbol.dispose]() {
      app.renderer.destroy()
      for (const deferred of pending) deferred.resolve(Response.json({ message: "Disposed" }, { status: 503 }))
      for (const item of pages) item.deferred.resolve(item.response)
    },
  }
}

test("held SDK status renders useful cold waiting within 500ms and success replaces it", async () => {
  await using root = await tmpdir()
  using ui = await mount(root.path)
  const frame = await ui.frame("Waiting for saved inventory status", "", 450)
  const elapsed = ui.elapsed
  expect(elapsed).toBeLessThan(500)
  console.log(`Task31 TUI cold useful wait: ${elapsed.toFixed(2)}ms`)
  expect(frame).toContain("0s elapsed")
  expect(frame).toContain("Saved inventory unknown")
  expect(frame).toContain("may include local initialization or recovery")
  expect(frame).toContain("Backend progress is not observed")
  expect(frame).toContain("Inspection starts no model call or scan")
  expect(frame).toContain("[c] Cancel wait")
  expect(frame).not.toContain("No inventory yet")
  await ui.frame(/\b[1-9]\d*s elapsed/)
  expect(ui.calls.map((call) => new URL(call.url).pathname)).toEqual(["/forge/status"])
  ui.respond(0)
  await ui.frame("loaded.ts", "Waiting for")
  expect(await ui.frame("17 files inspected")).not.toContain("Saved inventory unknown")
})

test("cancel and retry bypass a held callback; errors are retryable and old completions are ignored", async () => {
  await using root = await tmpdir()
  using ui = await mount(root.path)
  await ui.frame("Waiting for saved inventory status")
  const first = ui.calls.at(0)!
  ui.app.mockInput.pressKey("c")
  await ui.frame("Status wait cancelled locally", "Waiting for")
  expect(first.signal.aborted).toBe(true)
  ui.app.mockInput.pressKey("u")
  await ui.frame("Waiting for saved inventory status")
  expect(ui.pending).toHaveLength(2)
  ui.respond(1, "Status unavailable", true)
  await ui.frame("Status unavailable", "Waiting for")
  expect(await ui.frame("Saved inventory unknown")).not.toContain("No inventory yet")
  ui.app.mockInput.pressKey("u")
  await ui.frame("Waiting for saved inventory status")
  ui.respond(2, "new")
  await ui.frame("new.ts", "Status unavailable")
  ui.respond(0, "stale")
  await ui.frame("new.ts", "stale.ts")
  expect(ui.calls.every((call) => call.method === "GET")).toBe(true)
})

test("closing a held status aborts the request and clears its elapsed timer", async () => {
  const intervals = spyOn(globalThis, "setInterval")
  const cleared = spyOn(globalThis, "clearInterval")
  try {
    await using root = await tmpdir()
    using ui = await mount(root.path)
    await ui.frame(/\b[1-9]\d*s elapsed/)
    const timers = intervals.mock.calls.flatMap((call, index) => call.at(1) === 1000 ? [intervals.mock.results.at(index)!.value] : [])
    expect(timers.length).toBeGreaterThan(0)
    ui.app.mockInput.pressEscape()
    await ui.frame("Chat remains available", "Waiting for")
    expect(ui.calls.at(0)!.signal.aborted).toBe(true)
    for (const timer of timers) expect(cleared.mock.calls.some((call) => call.at(0) === timer)).toBe(true)
    ui.respond(0)
    await ui.frame("Chat remains available", "loaded.ts")
    expect(ui.calls).toHaveLength(1)
  } finally {
    intervals.mockRestore()
    cleared.mockRestore()
  }
})

test("session change clears known scope and rejects its held status completion", async () => {
  await using root = await tmpdir()
  using ui = await mount(root.path)
  await ui.frame("Waiting for saved inventory status")
  ui.respond(0, "old")
  await ui.frame("old.ts")
  ui.app.mockInput.pressKey("u")
  await ui.frame("Refreshing saved inventory status")
  ui.session()
  await ui.frame("Workspace or session changed", "old.ts")
  expect(ui.calls.filter((call) => new URL(call.url).pathname === "/forge/status").at(-1)!.signal.aborted).toBe(true)
  ui.respond(1, "foreign")
  await ui.frame("Saved inventory unknown", "foreign.ts")
  ui.app.mockInput.pressKey("u")
  await ui.frame("Workspace or session changed", "Waiting for")
  expect(ui.pending).toHaveLength(2)
})

test("warm refresh retains observed generation and sources until the new status arrives", async () => {
  await using root = await tmpdir()
  using ui = await mount(root.path)
  await ui.frame("Waiting for saved inventory status")
  ui.respond(0, "old")
  await ui.frame("old.ts")
  ui.app.mockInput.pressKey("u")
  const frame = await ui.frame("Refreshing saved inventory status")
  expect(frame).toContain("generation old; refreshing")
  expect(frame).toContain("17 files inspected")
  expect(frame).not.toContain("Saved inventory unknown")
  ui.app.mockInput.pressKey("\x1b[6~")
  expect(await ui.frame("old.ts")).toContain("last observed current; refreshing")
  ui.respond(1, "new")
  await ui.frame("new.ts", "old.ts")
  ui.app.mockInput.pressKey("\x1b[5~")
  await ui.frame("17 files inspected", "Refreshing saved")
})

test("new inventory retains the old source page as last observed through page loading and failure", async () => {
  await using root = await tmpdir()
  using ui = await mount(root.path)
  await ui.frame("Waiting for saved inventory status")
  ui.respond(0, "old")
  await ui.frame("old.ts")
  ui.hold()
  ui.app.mockInput.pressKey("u")
  await ui.frame("Refreshing saved inventory status")
  ui.respond(1, "new")
  await ui.frame("Source generation: old", "Refreshing saved")
  expect(await ui.frame("old.ts")).toContain("last observed current; refreshing")
  ui.page(0, true)
  expect(await ui.frame("Source page unavailable")).toContain("old.ts")
  await ui.frame("newer inventory observed")
  ui.app.mockInput.pressKey("u")
  await ui.frame("Refreshing saved inventory status")
  ui.respond(2, "new")
  await ui.frame("Source generation: old", "Refreshing saved")
  ui.page(1)
  await ui.frame("new.ts", "old.ts")
})
