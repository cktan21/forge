/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { GlobalEvent } from "@kilocode/sdk/v2"
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

async function mount(root: string, command: "overview" | "map") {
  await Bun.write(`${root}/kv.json`, "{}")
  const calls: Request[] = []
  const pages: { request: Request; response: Response; deferred: ReturnType<typeof Promise.withResolvers<Response>> }[] = []
  let listener: ((event: GlobalEvent) => void) | undefined
  let route: RouteContext | undefined
  let held = false
  let generation = "old"
  let revision = 0
  // Deliberately ignore transport abort so late success/error guards are tested too.
  const fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init)
    calls.push(request)
    const url = new URL(request.url)
    if (url.pathname === "/forge/status") return Response.json({
      inventory: { root, generation, indexed: true, files: 2, counts: { code: 2 }, partial: false, warnings: [] },
      session: "", job: { id: "", state: "idle", started: 0, updated: revision, message: `Ready-${revision}` },
    })
    if (url.pathname === "/forge/view") {
      const offset = Number(url.searchParams.get("offset") ?? 0)
      const response = Response.json({
        root, generation, sources: [{ kind: "file", uri: `${generation}-${offset}.ts`, status: "current" }],
        page: { offset, limit: 25, ...(offset ? {} : { next: 25 }) }, warnings: [],
      })
      if (!held) return response
      const deferred = Promise.withResolvers<Response>()
      pages.push({ request, response, deferred })
      return deferred.promise
    }
    throw new Error(`Unexpected inspection request: ${request.method} ${url.pathname}`)
  }, { preconnect: globalThis.fetch.preconnect.bind(globalThis.fetch) })

  function Open() {
    const dialog = useDialog()
    route = useRoute()
    onMount(() => forgePrompt(`/${command}`, dialog))
    return <text>Chat remains available</text>
  }
  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig()
    onCleanup(registerOpencodeKeymap(keymap, renderer, config))
    return <TestTuiContexts directory={root} paths={{ home: root, state: root, worktree: root }}>
      <OpencodeKeymapProvider keymap={keymap}><TuiConfigProvider config={config}>
        <SDKProvider url="http://fixture.local" directory={root} fetch={fetch}
          browser={async () => { throw new Error("Browser listener unavailable") }}
          events={{ subscribe: async (fn) => { listener = fn; return () => { listener = undefined } } }}>
          <ProjectProvider><RouteProvider><KVProvider><ThemeProvider mode="dark" source={{ discover: async () => ({}) }}>
            <ToastProvider><DialogProvider><Open /></DialogProvider></ToastProvider>
          </ThemeProvider></KVProvider></RouteProvider></ProjectProvider>
        </SDKProvider>
      </TuiConfigProvider></OpencodeKeymapProvider>
    </TestTuiContexts>
  }
  const app = await testRender(() => <Harness />, { width: 120, height: 48 })
  async function until(check: () => boolean) {
    const deadline = performance.now() + 2000
    do {
      await app.renderOnce()
      if (check()) return
      await Bun.sleep(5)
    } while (performance.now() < deadline)
    throw new Error(`Rendered condition timed out\n${app.captureCharFrame()}`)
  }
  return {
    app, calls, pages, until,
    hold() { held = true },
    change(value = generation) {
      generation = value
      revision++
      listener?.({ directory: root, payload: { id: `change-${revision}`, type: "forge.changed", properties: { topic: "knowledge", session: "", revision: String(revision) } } })
    },
    release(index: number, failure = false) {
      const item = pages.at(index)!
      item.deferred.resolve(failure ? Response.json({ message: "Obsolete page failure" }, { status: 503 }) : item.response)
    },
    session() { route!.navigate({ type: "session", sessionID: "different-session" }) },
    async frame(text: string, absent = "") {
      await until(() => app.captureCharFrame().includes(text) && (!absent || !app.captureCharFrame().includes(absent)))
      return app.captureCharFrame()
    },
    async settled() {
      // A returned response must traverse the real SDK before checking absence.
      await Bun.sleep(30)
      await app.renderOnce()
      return app.captureCharFrame()
    },
    [Symbol.dispose]() {
      app.renderer.destroy()
      for (const item of pages) item.deferred.resolve(item.response)
    },
  }
}

for (const command of ["overview", "map"] as const) {
  test(`${command} a pending page advertises cancellation and clears its loading state`, async () => {
    await using root = await tmpdir()
    using ui = await mount(root.path, command)
    await ui.frame("old-0.ts")
    ui.hold()
    ui.app.mockInput.pressKey("n")
    await ui.until(() => ui.pages.length === 1)
    const frame = await ui.frame("Reading source page")
    expect(frame).toContain("[c] Cancel read")
    ui.app.mockInput.pressKey("c")
    await ui.frame("Status wait cancelled locally", "Reading source page")
    expect(ui.pages.at(0)!.request.signal.aborted).toBe(true)
    ui.release(0)
    expect(await ui.settled()).not.toContain("old-25.ts")
  })

  test(`${command} a returned inventory generation invalidates a different pending page`, async () => {
    await using root = await tmpdir()
    using ui = await mount(root.path, command)
    await ui.frame("old-0.ts")
    ui.hold()
    ui.change("new")
    await ui.until(() => ui.pages.length === 1)
    const request = ui.pages.at(0)!.request
    ui.change("old")
    await ui.frame("Ready-2")
    await ui.until(() => request.signal.aborted && ui.pages.length === 2)
    ui.release(1)
    await ui.frame("old-0.ts")
    ui.release(0)
    expect(await ui.settled()).not.toContain("new-0.ts")
  })

  test(`${command} current page failures remain visible and a retry clears them`, async () => {
    await using root = await tmpdir()
    using ui = await mount(root.path, command)
    await ui.frame("old-0.ts")
    ui.hold()
    ui.app.mockInput.pressKey("n")
    await ui.until(() => ui.pages.length === 1)
    ui.release(0, true)
    await ui.frame("Obsolete page failure")
    ui.app.mockInput.pressKey("n")
    await ui.until(() => ui.pages.length === 2)
    ui.release(1)
    await ui.frame("old-25.ts", "Obsolete page failure")
  })

  for (const action of ["cancel", "reload", "history", "close", "session"] as const) {
    for (const failure of [false, true]) {
      test(`${command} ${action} aborts a source page and ignores late ${failure ? "failure" : "success"}`, async () => {
        await using root = await tmpdir()
        using ui = await mount(root.path, command)
        await ui.frame("old-0.ts")
        ui.hold()
        ui.app.mockInput.pressKey("n")
        await ui.until(() => ui.pages.length === 1)
        const request = ui.pages.at(0)!.request
        expect(request.signal.aborted).toBe(false)
        if (action === "session") ui.session()
        else ui.app.mockInput.pressKey({ cancel: "c", reload: "u", history: "p", close: "r" }[action])
        const visible = action === "close" ? "Chat remains available" : action === "session" ? "Workspace or session changed" : action === "cancel" ? "Status wait cancelled locally" : action === "history" ? "Latest preparation" : "old-0.ts"
        await ui.frame(visible)
        await ui.until(() => request.signal.aborted)
        ui.release(0, failure)
        const frame = await ui.settled()
        expect(frame).not.toContain("old-25.ts")
        expect(frame).not.toContain("Obsolete page failure")
        if (action !== "close" && action !== "session") {
          ui.app.mockInput.pressKey("u")
          await ui.frame("old-0.ts", "Status wait cancelled locally")
          ui.app.mockInput.pressKey("n")
          await ui.until(() => ui.pages.length === 2)
          ui.release(1)
          await ui.frame("old-25.ts", "old-0.ts")
        }
        expect(ui.calls.every((call) => call.method === "GET")).toBe(true)
      })
    }
  }

  for (const initial of [false, true]) {
    for (const changed of [false, true]) {
      test(`${command} automatic ${changed ? "new" : "same"} generation handles a held ${initial ? "initial" : "next"} page`, async () => {
        await using root = await tmpdir()
        using ui = await mount(root.path, command)
        await ui.frame("old-0.ts")
        ui.hold()
        if (initial) {
          ui.change("initial")
          await ui.frame("Ready-1")
        } else ui.app.mockInput.pressKey("n")
        await ui.until(() => ui.pages.length === 1)
        const request = ui.pages.at(0)!.request
        ui.change(changed ? "new" : initial ? "initial" : "old")
        await ui.frame(initial ? "Ready-2" : "Ready-1")
        if (changed) {
          await ui.until(() => request.signal.aborted && ui.pages.length === 2)
          ui.release(1)
          await ui.frame("new-0.ts", "old-0.ts")
          ui.release(0, true)
          expect(await ui.settled()).not.toContain("Obsolete page failure")
        } else {
          expect(request.signal.aborted).toBe(false)
          expect(ui.pages).toHaveLength(1)
          ui.release(0)
          await ui.frame(initial ? "initial-0.ts" : "old-25.ts", "old-0.ts")
        }
        expect(ui.calls.every((call) => call.method === "GET")).toBe(true)
      })
    }
  }
}
