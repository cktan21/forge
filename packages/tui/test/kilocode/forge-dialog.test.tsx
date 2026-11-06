/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { onCleanup, onMount } from "solid-js"
import { TuiConfigProvider } from "../../src/config"
import { KVProvider } from "../../src/context/kv"
import { PromptRefProvider } from "../../src/context/prompt"
import { ProjectProvider } from "../../src/context/project"
import { RouteProvider } from "../../src/context/route"
import { SDKProvider } from "../../src/context/sdk"
import { ThemeProvider } from "../../src/context/theme"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../src/keymap"
import type { Command } from "../../src/kilocode/forge/dialog"
import { forgePrompt } from "../../src/kilocode/forge/prompt"
import { DialogProvider, useDialog } from "../../src/ui/dialog"
import { ToastProvider } from "../../src/ui/toast"
import { tmpdir } from "../fixture/fixture"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import type { GlobalEvent } from "@kilocode/sdk/v2"
import { ScrollBoxRenderable, TextareaRenderable } from "@opentui/core"
import { stream } from "./forge-stream"

async function mount(root: string, command: Command, provider = false, state: "ready" | "empty" | "error" = "ready", history?: "hold" | "fail" | "mismatch" | "view-fail" | "view-hold" | "retry" | "selection" | "lookup" | "semantic" | "partial" | "populated") {
  await Bun.write(`${root}/kv.json`, "{}")
  const requests: string[] = []
  const offsets: number[] = []
  let listener: ((event: GlobalEvent) => void) | undefined
  let version = 0
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let failed = false
  // Keep the real SDK and UI; only replace the remote model-backed HTTP response.
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      requests.push(url.pathname)
      if (state === "error") return Response.json({ message: "Forge is unavailable. Try again." }, { status: 503 })
      if (url.pathname === "/forge/knowledge") {
        const query = url.searchParams.get("query") ?? ""
        const offset = Number(url.searchParams.get("offset") ?? 0)
        const values = Array.from({ length: 12 }, (_, index) => ({ id: `collection-${index}`, label: `Collection ${index}`, location: `/docs/${index}`, state: "registered", chunks: 0, session: "", providers: [], warnings: [] }))
          .filter((item) => item.label.includes(query))
        if (version && !offset && !query) values.unshift({ ...values.at(0)!, id: "new", label: "New collection", location: "/docs/new" })
        return Response.json({ collections: values.slice(offset, offset + 10), provider: "", generation: String(version), page: { offset, limit: 10, total: values.length, ...(offset + 10 < values.length ? { next: offset + 10 } : {}) } })
      }
      if (url.pathname.endsWith("/imports")) {
        const offset = Number(url.searchParams.get("offset") ?? 0)
        const limit = Number(url.searchParams.get("limit") ?? 10)
        const runs = [
          { id: "new", collection: "collection-0", session: "", started: 2, updated: 3, state: "interrupted", stage: "extract", count: 15, withheld: 1 },
          { id: "old", collection: "collection-0", session: "", started: 1, updated: 2, state: "published", stage: "publish", count: 15, withheld: 0 },
        ]
        const selected = runs.find((run) => run.id === url.searchParams.get("run")) ?? runs.at(0)!
        return Response.json({ runs, selected, documents: Array.from({ length: 15 }, (_, index) => ({ name: `${selected.id}-${index}.md`, state: selected.id === "old" ? "reused" : "processing", bytes: 20, chunks: 1 })).slice(offset, offset + limit), page: { offset, limit, total: 15, ...(offset + limit < 15 ? { next: offset + limit } : {}) } })
      }
      if (url.pathname === "/forge/status")
        return Response.json({
          inventory: { root, generation: `fixture-${version}`, indexed: state !== "empty", files: state === "empty" ? 0 : 1, counts: history === "populated" ? { directory: 1, code: 2, symbol: 1, summary: 1, document: 36 } : { code: 1 }, partial: false, warnings: ["Some files may be excluded by project settings."] },
          session: "", job: { id: "", state: "idle", started: 0, updated: 0, message: "Ready" },
          ...(history === "semantic" ? { semantic: { state: version ? "indexing" : "uninitialized", searchable: !!version } } : {}),
          ...(history && history !== "view-hold" && history !== "populated" ? { coding: { id: `coding-${history === "retry" ? 0 : version}`, model: `model-${history === "retry" ? 0 : version}`, state: "sent", observed: history === "retry" ? 0 : version, revision: String(version), sent: 1, entries: 1 } } : {}),
          ...(["selection", "partial"].includes(history ?? "") ? { preparation: { id: "preparation", model: "preparer", state: history === "partial" ? "failed" : "completed", observed: 0, sent: 0, entries: 0 } } : {}),
        })
      if (url.pathname === "/forge/requests") {
        if (history === "partial" && url.searchParams.get("purpose") === "enhance") return Response.json([{
          id: "preparation", operation: "preparation", entries: [], purpose: "enhance", session: "", state: "failed",
          retrieval: { started: 1, updated: 5, finished: 5, state: "cancelled", phase: "channels", channels: [
            { name: "keyword", state: "completed", started: 1, finished: 2 },
            { name: "semantic", state: "abandoned", started: 1, finished: 5 },
          ] },
        }])
        if (history === "selection" && url.searchParams.get("purpose") === "enhance") return Response.json([{
          id: "preparation", operation: "preparation", entries: [], purpose: "enhance", session: "",
          selection: {
            candidates: [{ source: "candidate", hash: "original", score: 1, retrieval: "Keyword match", state: "omitted", reason: "Excluded by developer", channels: [{ name: "keyword", rank: 2, score: 0.8, reason: "Lexical evidence" }] }],
            channels: [{ name: "keyword", state: "completed", candidates: 1, withheld: 2 }],
            total: 1, unrecorded: 0, withheld: 0, budget: 100, tokens: 0, estimator: "utf8-bytes-conservative",
          },
        }])
        const current = version
        if (current && history === "hold") { entered.resolve(); await release.promise }
        if (current && history === "fail" && !failed) {
          failed = true
          return Response.json({ message: "History unavailable" }, { status: 503 })
        }
        if (current && history === "mismatch" && !failed) {
          failed = true
          return Response.json([{ id: "wrong-request", entries: [{ source: "wrong-source", stage: "sent", label: "wrong-capture" }] }])
        }
        return Response.json([{ id: `coding-${history === "retry" ? 0 : current}`, preparation: `preparation-${current}`, session: "",
          ...(history === "lookup" ? { lookups: ["lookup"] } : {}),
          ...(history === "retry" ? { attempts: [{ id: `attempt-${current}`, sequence: current + 1, started: 0, finished: 10, state: "response", status: 200, membership: "matched", sent: ["source"] }], discarded: current } : {}),
          entries: [{ source: `source-${current}`, stage: "sent", label: `capture-${current}` }] }])
      }
      if (url.pathname === "/forge/requests/lookup") return Response.json({ request: {
        id: "lookup", session: "", purpose: "tool-retrieval", entries: [],
        lookup: { tool: "forge_search_code", call: "call", query: "queue canary" }, coverage: [],
        selection: { candidates: [], total: 0, unrecorded: 0, withheld: 0, budget: 100, tokens: 0, estimator: "test" },
      } })
      if (url.pathname === "/forge/view") {
        if (history === "view-hold") { entered.resolve(); await release.promise }
        if (version && history === "view-fail" && !failed) {
          failed = true
          return Response.json({ message: "Source page unavailable" }, { status: 503 })
        }
        const offset = Number(url.searchParams.get("offset") ?? 0)
        offsets.push(offset)
        return Response.json({
          root,
          generation: `fixture-${version}`,
          page: { offset, limit: 25, ...(offset || state === "empty" ? {} : { next: 25 }) },
          sources: history === "populated" ? Array.from({ length: 25 }, (_, index) => ({ kind: "document", uri: `manual-${index}.md`, status: "current" })) : state === "empty" ? [{ kind: "directory", uri: ".", status: "current" }] : [{ kind: "file", uri: offset ? "later.ts" : version ? "changed.ts" : "index.ts", status: "current" }],
          warnings: ["Some files may be excluded by project settings."],
        })
      }
      if (url.pathname === "/forge/index" || url.pathname === "/forge/index/cancel") {
        expect(request.method).toBe("POST")
        expect(await request.json()).toEqual({})
        return Response.json({ id: "fixture", state: "idle", started: 0, updated: 0, message: "Ready" })
      }
      if (url.pathname === "/forge/overview") {
        if (request.headers.get("content-type") !== "application/json" || await request.text() !== "{}")
          return new Response("Overview requires an empty JSON object", { status: 400 })
        return Response.json({ summary: state === "empty" ? " \n" : "Repository overview is available.", evidence: [], snapshot: { warnings: [] } })
      }
      if (url.pathname === "/forge/enhance/stream")
        return stream(Response.json({
          original: "Explain the code",
          prompt: "Prepared task",
          status: "ready",
          context: { text: "Local evidence", estimator: "test" },
        }))
      return new Response("Unexpected request", { status: 404 })
    },
  })
  function Open() {
    const dialog = useDialog()
    onMount(() => forgePrompt(`/${command}${command === "enhance" ? " Explain the code" : ""}`, dialog))
    return <text>Chat remains available</text>
  }
  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig()
    onCleanup(registerOpencodeKeymap(keymap, renderer, config))
    const content = () => <DialogProvider><Open /></DialogProvider>
    return (
      <TestTuiContexts directory={root} paths={{ home: root, state: root, worktree: root }}>
        <OpencodeKeymapProvider keymap={keymap}>
          <TuiConfigProvider config={config}>
            <SDKProvider url={server.url.toString()} directory={root} browser={async () => { throw new Error("Browser listener unavailable") }} events={{ subscribe: async (fn) => { listener = fn; return () => { listener = undefined } } }}>
              <ProjectProvider>
                <RouteProvider>
                  <KVProvider>
                    <ThemeProvider mode="dark" source={{ discover: async () => ({}) }}>
                      <ToastProvider>
                        {provider ? <PromptRefProvider>{content()}</PromptRefProvider> : content()}
                      </ToastProvider>
                    </ThemeProvider>
                  </KVProvider>
                </RouteProvider>
              </ProjectProvider>
            </SDKProvider>
          </TuiConfigProvider>
        </OpencodeKeymapProvider>
      </TestTuiContexts>
    )
  }
  const app = await testRender(() => <Harness />, { width: 120, height: 40 })
  return {
    app,
    requests,
    offsets,
    entered: entered.promise,
    release: release.resolve,
    change(directory = root, session = "") {
      version++
      listener?.({ directory, payload: { id: "event", type: "forge.changed", properties: { topic: "knowledge", session, revision: String(version) } } })
    },
    indexing() {
      version++
      listener?.({ directory: root, payload: { id: "indexing", type: "indexing.status", properties: { status: { state: "In Progress", message: "", processedFiles: 1, totalFiles: 2, percent: 50 } } } })
    },
    viewport(frame: string) {
      const nodes = app.renderer.root.getChildren()
      for (const node of nodes) {
        if (node instanceof ScrollBoxRenderable) {
          // Observe painted viewport cells, excluding sibling scrollbar chrome.
          const view = node.viewport
          return frame.split("\n").slice(Math.max(0, view.y), view.y + view.height)
            .map((line) => Array.from(line).slice(view.x, view.x + view.width).join("")).join("\n")
        }
        nodes.push(...node.getChildren())
      }
      throw new Error("Expected a rendered knowledge scroll viewport")
    },
    async frame(text: string, absent = "") {
      const deadline = Date.now() + 4000
      while (Date.now() < deadline) {
        await app.renderOnce()
        const frame = app.captureCharFrame()
        if (frame.includes(text) && (!absent || !frame.includes(absent))) return frame
        await Bun.sleep(10)
      }
      throw new Error(`Missing rendered text: ${text}\n${app.captureCharFrame()}`)
    },
    async [Symbol.asyncDispose]() {
      release.resolve()
      app.renderer.destroy()
      await server.stop(true)
    },
  }
}

test.each(["overview", "map"] as const)("%s shows semantic readiness and refreshes on indexing events without starting work", async (command) => {
  await using root = await tmpdir()
  await using ui = await mount(root.path, command, false, "ready", "semantic")
  if (command === "map") {
    await ui.frame("Terminal knowledge map")
    ui.app.mockInput.pressKey("o")
  }
  await ui.frame("Semantic index: not initialized; search unavailable")
  const frame = ui.viewport(await ui.frame("repository readiness does not describe collection coverage")).replace(/\s+/g, " ")
  expect(frame).toContain("Collection semantic search requires separate host configuration, destination approval and explicit indexing")
  expect(frame).toContain("Repository semantic search reuses Kilo's repository-file index.")
  expect(frame).toContain("repository readiness does not describe collection coverage")
  expect(frame).toContain("Semantic index: not initialized; search unavailable")
  ui.indexing()
  await ui.frame("Semantic index: indexing; search available", "not initialized")
  expect(ui.requests).not.toContain("/forge/index")
  expect(ui.requests).not.toContain("/forge/enhance/stream")
})

test.each(["overview", "map"] as const)("%s inspects cancelled execution without claiming selected or sent evidence", async (command) => {
  await using root = await tmpdir()
  await using ui = await mount(root.path, command, false, "ready", "partial")
  if (command === "map") {
    await ui.frame("Terminal knowledge map")
    ui.app.mockInput.pressKey("o")
  }
  await ui.frame("capture-0")
  ui.app.mockInput.pressKey("p")
  await ui.frame("preparer")
  ui.app.mockInput.pressKey("h")
  expect(await ui.frame("Retrieval execution: cancelled")).toContain("last phase: channels")
  const frame = await ui.frame("semantic: abandoned")
  expect(frame).toContain("keyword: completed")
  expect(frame.replace(/\s+/g, " ")).toContain("do not imply selected evidence or provider transmission")
  expect(frame).not.toContain("capture-0")
  ui.app.mockInput.pressKey("h")
  await ui.frame("Available knowledge")
  expect(ui.requests).not.toContain("/forge/index")
  expect(ui.requests).not.toContain("/forge/enhance/stream")
})

test("referenced search retrieval is inspectable and returns to the coding capture", async () => {
  await using dir = await tmpdir()
  await using ui = await mount(dir.path, "overview", false, "ready", "lookup")
  await ui.frame("capture-0")
  ui.app.mockInput.pressKey("l")
  await ui.frame("Lookup tool: forge_search_code", "capture-0")
  await ui.frame("Query / source ID: queue canary")
  ui.app.mockInput.pressKey("l")
  await ui.frame("capture-0", "queue canary")
  expect(ui.requests.filter((item) => item === "/forge/requests/lookup").length).toBeGreaterThan(0)
  expect(ui.requests).not.toContain("/forge/enhance/stream")
})

test("preparation lens displays selection decisions without replacing the coding request", async () => {
  await using root = await tmpdir()
  await using ui = await mount(root.path, "overview", false, "ready", "selection")
  await ui.frame("capture-0")
  ui.app.mockInput.pressKey("p")
  await ui.frame("Selection history: 1 scoped candidates", "capture-0")
  await ui.frame("keyword: completed; 1 scoped hits, 2 withheld")
  ui.app.mockInput.pressKey("\x1b[6~")
  await ui.frame("keyword rank 2")
  ui.app.mockInput.pressKey("\x1b[5~")
  await ui.frame("Available knowledge")
  ui.app.mockInput.pressKey("p")
  await ui.frame("capture-0", "Selection history:")
  expect(ui.requests.some((item) => item.startsWith("POST"))).toBe(false)
})

test("attempt revisions reload a capture even when request identity, state, and counts are unchanged", async () => {
  await using root = await tmpdir()
  await using ui = await mount(root.path, "overview", false, "ready", "retry")
  await ui.frame("Attempt 1: HTTP 200")
  ui.change()
  const frame = await ui.frame("Attempt 2: HTTP 200", "Attempt 1:")
  expect(frame).toContain("1 older attempts omitted")
})

test("new coding metadata never displays the previous request's excerpts while loading", async () => {
  await using root = await tmpdir()
  await using ui = await mount(root.path, "overview", false, "ready", "hold")
  await ui.frame("capture-0")
  expect(await ui.frame("Preparation reference: preparation-0")).toContain("not proof of approval")
  ui.change()
  await ui.entered
  const frame = await ui.frame("model-1")
  expect(frame).not.toContain("capture-0")
  expect(frame).not.toContain("preparation-0")
  ui.release()
  await ui.frame("capture-1", "capture-0")
})

test("failed coding capture is cleared and can be retried without another metadata change", async () => {
  await using root = await tmpdir()
  await using ui = await mount(root.path, "overview", false, "ready", "fail")
  await ui.frame("capture-0")
  ui.change()
  expect(await ui.frame("History unavailable")).not.toContain("capture-0")
  ui.app.mockInput.pressKey("u")
  await ui.frame("capture-1", "History unavailable")
})

test("capture response for a different request is withheld and retryable", async () => {
  await using root = await tmpdir()
  await using ui = await mount(root.path, "overview", false, "ready", "mismatch")
  await ui.frame("capture-0")
  ui.change()
  const frame = await ui.frame("Selected coding capture is unavailable")
  expect(frame).not.toContain("capture-0")
  expect(frame).not.toContain("wrong-capture")
  ui.app.mockInput.pressKey("u")
  await ui.frame("capture-1", "Selected coding capture is unavailable")
})

test("source-page failure does not prevent the latest coding capture from loading", async () => {
  await using root = await tmpdir()
  await using ui = await mount(root.path, "overview", false, "ready", "view-fail")
  await ui.frame("capture-0")
  ui.change()
  expect(await ui.frame("capture-1", "capture-0")).toContain("Source page unavailable")
  ui.app.mockInput.pressKey("u")
  await ui.frame("capture-1", "Source page unavailable")
  ui.app.mockInput.pressKey("\x1b[6~")
  await ui.frame("changed.ts", "Source page unavailable")
})

test("knowledge view stays idle, ignores foreign changes, and refreshes on its SDK stream", async () => {
  await using root = await tmpdir()
  await using ui = await mount(root.path, "overview")
  await ui.frame("index.ts")
  await Bun.sleep(1100)
  expect(ui.requests).toEqual(["/forge/status", "/forge/view"])
  ui.change(`${root.path}-foreign`)
  ui.change(root.path, "other-session")
  await Bun.sleep(100)
  expect(ui.requests).toHaveLength(2)
  ui.change()
  await ui.frame("changed.ts")
  expect(ui.requests).toEqual(["/forge/status", "/forge/view", "/forge/status", "/forge/view"])
  ui.app.mockInput.pressKey("r")
  await ui.frame("Chat remains available")
  ui.change()
  await Bun.sleep(100)
  expect(ui.requests).toHaveLength(4)
})

test("modified keys do not invoke unmodified dashboard actions", async () => {
  await using root = await tmpdir()
  await using ui = await mount(root.path, "overview")
  await ui.frame("index.ts")
  for (const name of ["i", "e", "x", "r"]) ui.app.mockInput.pressKey(name, { ctrl: true })
  await ui.frame("index.ts")
  await Bun.sleep(100)
  expect(ui.requests).toEqual(["/forge/status", "/forge/view"])
})

test("explicit dashboard shortcuts retain indexing, explanation, and cancellation", async () => {
  await using root = await tmpdir()
  await using ui = await mount(root.path, "overview")
  await ui.frame("index.ts")
  ui.app.mockInput.pressKey("i")
  ui.app.mockInput.pressKey("x")
  ui.app.mockInput.pressKey("e")
  await Bun.sleep(30)
  await ui.app.renderOnce()
  ui.app.mockInput.pressKey("\x1b[6~")
  await ui.frame("Repository overview is available.")
  expect(ui.requests.filter((route) => route === "/forge/index")).toHaveLength(1)
  expect(ui.requests.filter((route) => route === "/forge/index/cancel")).toHaveLength(1)
  expect(ui.requests.filter((route) => route === "/forge/overview")).toHaveLength(1)
})

test("library navigates pages, searches, and preserves selected identity across updates", async () => {
  await using root = await tmpdir()
  await using ui = await mount(root.path, "overview")
  await ui.frame("index.ts")
  ui.app.mockInput.pressKey("k")
  await ui.frame("Collection 0")
  for (let index = 1; index <= 10; index++) {
    ui.app.mockInput.pressKey("n")
    await ui.frame(`> Collection ${index} ·`)
  }
  await ui.frame("Page 2")
  ui.app.mockInput.pressKey("b")
  await ui.frame("> Collection 9 ·")
  for (let index = 8; index >= 1; index--) {
    ui.app.mockInput.pressKey("b")
    await ui.frame(`> Collection ${index} ·`)
  }
  ui.change()
  await ui.frame("New collection")
  await ui.frame("> Collection 1 ·")
  ui.app.mockInput.pressKey("/")
  await ui.frame("Find collections by label or path")
  const editor = ui.app.renderer.currentFocusedEditor
  if (!(editor instanceof TextareaRenderable)) throw new Error("Expected collection search")
  editor.setText("Collection 11")
  ui.app.mockInput.pressEnter()
  await ui.frame('1 matches for "Collection 11"')
  await ui.frame("> Collection 11 ·")
})

test("library import history navigates file pages and retained runs without inference", async () => {
  await using root = await tmpdir()
  await using ui = await mount(root.path, "overview")
  await ui.frame("index.ts")
  ui.app.mockInput.pressKey("k")
  await ui.frame("Collection 0")
  ui.app.mockInput.pressKey("j")
  await ui.frame("Import run interrupted")
  await ui.frame("new-0.md: unfinished")
  ui.app.mockInput.pressKey("n")
  await ui.frame("new-10.md: unfinished")
  ui.app.mockInput.pressKey("o")
  await ui.frame("Import run published")
  await ui.frame("old-0.md: reused")
  ui.app.mockInput.pressKey("u")
  await ui.frame("Import run interrupted")
  ui.app.mockInput.pressKey("q")
  await ui.frame("Forge knowledge library")
  expect(ui.requests).not.toContain("/forge/index")
  expect(ui.requests).not.toContain("/forge/enhance/stream")
})

test("knowledge source pages navigate without inference and restart after knowledge changes", async () => {
  await using root = await tmpdir()
  await using ui = await mount(root.path, "overview")
  await ui.frame("index.ts")
  ui.app.mockInput.pressKey("n")
  await ui.frame("later.ts", "index.ts")
  expect(await ui.frame("Page 2")).toContain("Last page")
  ui.app.mockInput.pressKey("n")
  ui.app.mockInput.pressKey("b")
  await ui.frame("index.ts", "later.ts")
  ui.app.mockInput.pressKey("n")
  await ui.frame("later.ts")
  ui.change()
  await ui.frame("changed.ts", "later.ts")
  expect(await ui.frame("Page 1")).toContain("More available")
  expect(ui.offsets).toEqual([0, 25, 0, 25, 0])
  expect(ui.requests.every((path) => path === "/forge/status" || path === "/forge/view")).toBe(true)
})

for (const provider of [false, true]) {
  test(`overview renders and closes with ${provider ? "an empty" : "no"} prompt provider`, async () => {
    await using root = await tmpdir()
    await using ui = await mount(root.path, "overview", provider)
    await ui.frame("index.ts")
    expect(ui.requests).toEqual(["/forge/status", "/forge/view"])
    expect(ui.requests).not.toContain("/forge/overview")
    ui.app.mockInput.pressKey("r")
    const frame = await ui.frame("Chat remains available")
    expect(frame).not.toContain("Available knowledge")
  })
}

test("empty overview keeps a visible dialog with guidance and a close action", async () => {
  await using root = await tmpdir()
  await using ui = await mount(root.path, "overview", false, "empty")
  const frame = await ui.frame("No inventory yet.")
  expect(frame).toContain("No coding request observed")
  expect(frame).toContain("[r] Reject / close")
  ui.app.mockInput.pressEscape()
  expect(await ui.frame("Chat remains available", "No inventory yet.")).not.toContain("No inventory yet.")
})

test("empty map stays inside the terminal without requiring a browser", async () => {
  await using root = await tmpdir()
  await using ui = await mount(root.path, "map", false, "empty")
  const frame = await ui.frame("No inventory yet.")
  expect(frame).toContain("Press i to index this workspace")
  expect(frame).toContain("Terminal knowledge map")
  expect(frame).not.toContain("Browser listener unavailable")
  // Status can render before the independent source request reaches the server.
  await ui.frame("Page 1")
  ui.app.mockInput.pressKey("\x1b[6~")
  expect(await ui.frame("Some files may be excluded")).toContain("Some files may be excluded")
  expect(ui.requests).toEqual(["/forge/status", "/forge/view"])
})

test("empty map remains usable while its source page is pending", async () => {
  await using root = await tmpdir()
  await using ui = await mount(root.path, "map", false, "empty", "view-hold")
  await ui.entered
  const frame = await ui.frame("No inventory yet.")
  expect(frame).toContain("Terminal knowledge map")
  expect(frame).not.toContain("Browser listener unavailable")
  expect(frame).not.toContain("Page 1")
  ui.release()
  expect(await ui.frame("Page 1")).toContain("Last page")
  expect(ui.requests.filter((route) => route === "/forge/view")).toHaveLength(1)
  ui.app.mockInput.pressEscape()
  await ui.frame("Forge · overview")
  ui.app.mockInput.pressEscape()
  await ui.frame("Chat remains available", "No inventory yet.")
})

test("map sources remain readable without opening a browser", async () => {
  await using root = await tmpdir()
  await using ui = await mount(root.path, "map")
  const frame = await ui.frame("index.ts")
  expect(frame).toContain("index.ts")
  expect(frame).toContain("current")
})

test("populated knowledge remains scrollable through terminal resizing", async () => {
  await using root = await tmpdir()
  await using ui = await mount(root.path, "overview", false, "ready", "populated")
  await ui.frame("document: 36")
  await ui.frame("Source generation:")
  expect(ui.app.captureCharFrame()).not.toContain("manual-0.md")
  ui.app.mockInput.pressKey("\x1b[6~")
  ui.app.renderer.resize(141, 48)
  await ui.frame("Page 1")
  await ui.frame("manual-0.md")
  expect(ui.app.captureCharFrame()).toContain("[r] Reject / close")
  expect(ui.requests).toEqual(["/forge/status", "/forge/view"])
})

for (const command of ["overview", "map"] as const) {
  test(`${command} shows request failures inside the dialog`, async () => {
    await using root = await tmpdir()
    await using ui = await mount(root.path, command, false, "error")
    const frame = await ui.frame("Forge is unavailable. Try again.")
    expect(frame).toContain("[r] Reject / close")
    expect(frame).not.toContain("No sources are available")
    expect(frame).not.toContain("No overview is available")
  })
}

test("prepared tasks remain readable without a composer and cannot run or silently discard edits", async () => {
  await using root = await tmpdir()
  await using ui = await mount(root.path, "enhance")
  const frame = await ui.frame("No chat input is available.")
  expect(frame).toContain("Prepared task")
  expect(frame).not.toContain("[a] Use prompt")
  expect(frame).not.toContain("[e] Edit prompt")
  for (const key of ["a", "e"]) {
    ui.app.mockInput.pressKey(key)
    await ui.frame("Reopen /enhance from a chat")
  }
  expect(ui.requests).toEqual(["/forge/enhance/stream"])
})
