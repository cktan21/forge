/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { TextareaRenderable } from "@opentui/core"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { onCleanup, onMount } from "solid-js"
import { createKiloClient, type GlobalEvent } from "@kilocode/sdk/v2"
import type { EmbeddingJob, EmbeddingCoverage } from "@kilocode/forge/schema"
import { account } from "@kilocode/forge/embedding-usage"
import path from "node:path"
import { TuiConfigProvider } from "../../src/config"
import { KVProvider } from "../../src/context/kv"
import { SDKProvider } from "../../src/context/sdk"
import { ThemeProvider } from "../../src/context/theme"
import { OpencodeKeymapProvider, registerOpencodeKeymap, useBindings } from "../../src/keymap"
import { ProjectProvider } from "../../src/context/project"
import { RouteProvider, useRoute, type RouteContext } from "../../src/context/route"
import { forgePrompt } from "../../src/kilocode/forge/prompt"
import { DialogProvider, useDialog } from "../../src/ui/dialog"
import { ToastProvider } from "../../src/ui/toast"
import { tmpdir } from "../fixture/fixture"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"

const destination = {
  endpoint: "https://embedding.example/v1/embeddings",
  target: { fingerprint: "routing-fingerprint", model: "local-fixture", dimensions: 2 },
  revision: "a".repeat(64),
  approved: false,
}
function coverage(): EmbeddingCoverage {
  return {
    collection: "reference",
    session: "chat",
    target: destination.target,
    started: 1,
    finished: 2,
    sections: 5,
    reusable: 1,
    missing: 1,
    outdated: 1,
    stale: 1,
    excluded: 1,
  }
}
function ledger(count = 1) {
  return {
    session: "chat",
    entries: Array.from({ length: count }, (_, index) => ({
      id: `attempt-${index}`,
      session: "chat",
      collections: ["reference", "other"],
      purpose: "query",
      target: destination.target,
      started: 1,
      usage: account(undefined, { state: "attempt", inputs: 1, bytes: 52 }),
    })),
  }
}
function job(state: EmbeddingJob["state"] = "completed"): EmbeddingJob {
  return {
    id: "job-1",
    collection: "reference",
    session: "chat",
    revision: "revision",
    target: destination.target,
    state,
    started: 1,
    updated: 2,
    progressed: 2,
    progress: { phase: "validating", sections: 3, processed: 3, embedded: 2, reused: 1 },
    ...(state === "completed" ? { finished: 3, result: { sections: 3, embedded: 2, reused: 1 } } : {}),
  }
}

async function mount(
  root: string,
  late = false,
  backend?: { url: string; session: string; headers: Record<string, string> },
  navigation = false,
) {
  await Bun.write(`${root}/kv.json`, "{}")
  const calls: { request: Request; body: unknown }[] = []
  const held: { request: Request; release: ReturnType<typeof Promise.withResolvers<Response>> }[] = []
  let listener: ((event: GlobalEvent) => void) | undefined
  let approved = false
  let failure = ""
  let holding = ""
  let malformed = false
  let fingerprint = destination.target.fingerprint
  let route: RouteContext | undefined
  let rows: EmbeddingJob[] = []
  let history = ""
  let running = false
  let covered: unknown = coverage()
  let usage: unknown = ledger()
  const reads: Request[] = []
  async function respond(request: Request) {
    const url = new URL(request.url)
    if (url.pathname === "/forge/status")
      return Response.json({
        inventory: { root, generation: "fixture", indexed: true, files: 0, counts: {}, partial: false, warnings: [] },
        session: "chat",
        job: { id: "", state: "idle", started: 0, updated: 0, message: "Ready" },
      })
    if (url.pathname === "/forge/view")
      return Response.json({ root, generation: "fixture", sources: [], page: { offset: 0, limit: 25 }, warnings: [] })
    if (url.pathname === "/forge/knowledge" && holding === "knowledge") {
      const release = Promise.withResolvers<Response>()
      held.push({ request, release })
      return release.promise
    }
    if (url.pathname === "/forge/knowledge")
      return Response.json({
        collections: [
          {
            id: "reference",
            label: "Reference",
            location: "/docs",
            state: "ready",
            approved: true,
            chunks: 1,
            files: 1,
            session: "",
            providers: [],
            warnings: [],
          },
        ],
        provider: "",
        generation: "fixture",
        page: { offset: 0, limit: 10, total: 1 },
      })
    if (url.pathname.endsWith("/jobs") && request.method === "GET") {
      reads.push(request)
      if (history === "held") {
        const release = Promise.withResolvers<Response>()
        held.push({ request, release })
        return release.promise
      }
      if (history === "failed") return Response.json({ message: "History denied" }, { status: 403 })
      return Response.json(history === "foreign" ? [{ ...job(), session: "other" }] : rows)
    }
    calls.push({ request, body: request.method === "GET" ? undefined : await request.clone().json() })
    const action = url.pathname.split("/").at(-1)!
    if (action === holding) {
      const release = Promise.withResolvers<Response>()
      held.push({ request, release })
      return release.promise
    }
    if (failure && action !== "revoke") return Response.json({ message: failure }, { status: 403 })
    if (action === "coverage") return Response.json(covered)
    if (action === "usage") return Response.json(usage)
    if (action === "embeddings")
      return Response.json({
        ...destination,
        target: { ...destination.target, fingerprint },
        approved,
        ...(malformed ? { revision: "wrong" } : {}),
      })
    if (action === "approve") {
      approved = true
      return Response.json({ approved: true })
    }
    if (action === "revoke") {
      approved = false
      return Response.json({ revoked: true })
    }
    if (action === "jobs") {
      rows = [job(running ? "running" : "completed")]
      return Response.json(rows.at(0))
    }
    if (action === "cancel") {
      rows = rows.map((row) =>
        row.id === url.pathname.split("/").at(-2) ? { ...row, state: "cancelled", finished: 4 } : row,
      )
      return Response.json({ requested: true })
    }
    throw new Error(`Unexpected request ${request.method} ${url.pathname}`)
  }
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: respond })
  // Most tests use the real socket. Late-result cases deliberately ignore abort.
  const fetch = late
    ? Object.assign(
        (input: string | URL | Request, init?: RequestInit) =>
          respond(input instanceof Request ? input : new Request(input, init)),
        { preconnect: globalThis.fetch.preconnect.bind(globalThis.fetch) },
      )
    : undefined
  function Open() {
    const dialog = useDialog()
    route = useRoute()
    useBindings(() => ({
      enabled: navigation,
      bindings: [
        { key: "pagedown", cmd: () => dialog.clear(), desc: "Scroll conversation", group: "Session" },
        { key: "pageup", cmd: () => dialog.clear(), desc: "Scroll conversation", group: "Session" },
      ],
    }))
    onMount(() => {
      route!.navigate({ type: "session", sessionID: backend?.session ?? "chat" })
      forgePrompt("/overview", dialog)
    })
    return <text>Chat remains available</text>
  }
  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig()
    onCleanup(registerOpencodeKeymap(keymap, renderer, config))
    return (
      <TestTuiContexts directory={root} paths={{ home: root, state: root, worktree: root }}>
        <OpencodeKeymapProvider keymap={keymap}>
          <TuiConfigProvider config={config}>
            <SDKProvider
              url={backend?.url ?? server.url.toString()}
              directory={root}
              headers={backend?.headers}
              fetch={fetch}
              events={
                backend
                  ? undefined
                  : {
                      subscribe: async (fn) => {
                        listener = fn
                        return () => {
                          listener = undefined
                        }
                      },
                    }
              }
            >
              <ProjectProvider>
                <RouteProvider>
                  <KVProvider>
                    <ThemeProvider mode="dark" source={{ discover: async () => ({}) }}>
                      <ToastProvider>
                        <DialogProvider>
                          <Open />
                        </DialogProvider>
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
  const app = await testRender(() => <Harness />, { width: 120, height: 48 })
  async function until(check: () => boolean) {
    const deadline = performance.now() + 3000
    do {
      await app.renderOnce()
      if (check()) return
      await Bun.sleep(5)
    } while (performance.now() < deadline)
    throw new Error(`Rendered condition timed out\n${app.captureCharFrame()}`)
  }
  const frame = async (text: string, absent = "") => {
    await until(() => app.captureCharFrame().includes(text) && (!absent || !app.captureCharFrame().includes(absent)))
    return app.captureCharFrame()
  }
  try {
    await frame("Page 1")
    app.mockInput.pressKey("k")
    await frame("[e] Manage embeddings")
    app.mockInput.pressKey("e")
    await frame("Collection embeddings: Reference")
  } catch (err) {
    app.renderer.destroy()
    await server.stop(true)
    throw err
  }
  return {
    app,
    calls,
    held,
    reads,
    coverage(value: unknown) {
      covered = value
    },
    usage(value: unknown) {
      usage = value
    },
    history(value: string) {
      history = value
    },
    rows(value: EmbeddingJob[]) {
      rows = value
    },
    running() {
      running = true
    },
    until,
    frame,
    hold(value: string) {
      holding = value
    },
    approve() {
      approved = true
    },
    fail(value: string) {
      failure = value
    },
    malformed(value: boolean) {
      malformed = value
    },
    long() {
      fingerprint = "route-".repeat(250) + "END-ROUTE"
    },
    change(session = "", directory = root) {
      listener?.({
        directory,
        payload: {
          id: crypto.randomUUID(),
          type: "forge.changed",
          properties: { topic: "knowledge", session, revision: crypto.randomUUID() },
        },
      })
    },
    scope() {
      route!.navigate({ type: "session", sessionID: "other-chat" })
    },
    async confirm(value: string) {
      await until(() => app.renderer.currentFocusedEditor instanceof TextareaRenderable)
      const editor = app.renderer.currentFocusedEditor
      if (!(editor instanceof TextareaRenderable)) throw new Error("Expected embedding confirmation editor")
      editor.setText(value)
      app.mockInput.pressEnter()
    },
    async settled() {
      await Bun.sleep(40)
      await app.renderOnce()
      return app.captureCharFrame()
    },
    async [Symbol.asyncDispose]() {
      app.renderer.destroy()
      for (const item of held) item.release.resolve(Response.json({ ...destination, approved: true }))
      await server.stop(true)
    },
  }
}

for (const key of ["escape", "backspace"] as const) {
  for (const page of [
    { key: "s", title: "Embedding coverage: Reference" },
    { key: "j", title: "Embedding job history: Reference" },
    { key: "u", title: "Recorded embedding usage" },
  ]) {
    test(`${key} returns from ${page.title} through embeddings and library one level at a time`, async () => {
      await using root = await tmpdir()
      await using ui = await mount(root.path)
      ui.app.mockInput.pressKey(page.key)
      await ui.frame(page.title)
      ui.app.mockInput.pressKey(key === "escape" ? "\x1b" : "\x7f")
      await ui.frame("Collection embeddings: Reference", page.title)
      ui.app.mockInput.pressKey(key === "escape" ? "\x1b" : "\x7f")
      await ui.frame("Forge knowledge library", "Collection embeddings:")
      expect(ui.app.captureCharFrame()).toContain("> Reference")
      ui.app.mockInput.pressKey(key === "escape" ? "\x1b" : "\x7f")
      await ui.frame("Forge · overview", "Forge knowledge library")
      expect(ui.calls).toHaveLength(0)
    })
  }
}

test("Escape cancels embedding confirmation locally while Backspace remains text deletion", async () => {
  await using root = await tmpdir()
  await using ui = await mount(root.path)
  ui.app.mockInput.pressKey("r")
  await ui.frame("Not approved for this destination")
  ui.app.mockInput.pressKey("a")
  await ui.frame("Type ALLOW")
  await ui.until(() => ui.app.renderer.currentFocusedEditor instanceof TextareaRenderable)
  const input = ui.app.renderer.currentFocusedEditor
  if (!(input instanceof TextareaRenderable)) throw new Error("Expected embedding confirmation")
  input.setText("ALLOW")
  input.gotoBufferEnd()
  ui.app.mockInput.pressBackspace()
  await ui.until(() => input.plainText === "ALLO")
  input.clear()
  ui.app.mockInput.pressBackspace()
  expect(await ui.settled()).toContain("Type ALLOW")
  ui.app.mockInput.pressEscape()
  await ui.frame("Collection embeddings: Reference", "Type ALLOW")
  expect(ui.calls).toHaveLength(1)
  ui.app.mockInput.pressBackspace()
  await ui.frame("Forge knowledge library", "Collection embeddings:")
})

test("terminal opens the selected embedding controls while a background library refresh is held", async () => {
  await using root = await tmpdir()
  await using ui = await mount(root.path, true)
  ui.hold("knowledge")
  ui.change()
  await ui.until(() => ui.held.length === 1)
  ui.app.mockInput.pressKey("q")
  await ui.frame("Forge knowledge library")
  ui.app.mockInput.pressKey("e")
  await ui.frame("Collection embeddings: Reference")
  ui.app.mockInput.pressKey("s")
  await ui.frame("Embedding coverage: Reference")
  expect(ui.calls).toHaveLength(0)
  ui.app.mockInput.pressKey("r")
  await ui.frame("Reusable vectors: 1")
  expect(ui.calls).toHaveLength(1)
})

test("terminal usage is explicit, scoped and bounded with replacing pages and record inspection", async () => {
  await using root = await tmpdir()
  await using ui = await mount(root.path)
  ui.usage({ ...ledger(100), next: "10" })
  ui.app.mockInput.pressKey("u")
  await ui.frame("Recorded embedding usage across this session")
  expect(ui.app.captureCharFrame()).toContain("Not limited to Reference")
  expect(ui.calls).toHaveLength(0)
  ui.app.mockInput.pressKey("r")
  await ui.frame("100 observed attempts")
  await ui.frame("Prompt tokens: 0; reports: 0; unknown attempts: 100")
  const request = ui.calls.at(0)!.request
  const url = new URL(request.url)
  expect(request.method).toBe("GET")
  expect(url.pathname).toBe("/forge/embeddings/usage")
  expect(url.searchParams.get("session")).toBe("chat")
  expect(url.searchParams.get("limit")).toBe("100")
  expect(url.searchParams.get("directory")).toBe(root.path)
  expect(url.searchParams.has("id")).toBe(false)
  ui.app.mockInput.pressKey("d")
  await ui.frame("Attempt attempt-0: query; collections: reference, other")
  ui.app.mockInput.pressKey("d")
  await ui.frame("Prompt tokens: 0")
  ui.change("other-session")
  await ui.settled()
  expect(ui.app.captureCharFrame()).toContain("100 observed attempts")
  ui.change("", "/different-workspace")
  await ui.settled()
  expect(ui.app.captureCharFrame()).toContain("100 observed attempts")
  expect(ui.calls).toHaveLength(1)
  ui.usage(ledger(0))
  ui.app.mockInput.pressKey("n")
  await ui.frame("0 observed attempts", "100 observed attempts")
  expect(new URL(ui.calls.at(1)!.request.url).searchParams.get("after")).toBe("10")
  expect(ui.app.captureCharFrame()).not.toContain("[n] Next usage page")
  expect(ui.app.captureCharFrame()).toContain("does not prove complete historical usage")
  ui.app.mockInput.pressKey("q")
  await ui.frame("Collection embeddings: Reference")
  ui.app.mockInput.pressKey("u")
  await ui.frame("Recorded embedding usage", "0 observed attempts")
  expect(ui.calls).toHaveLength(2)
})

test("terminal usage displays revision and retained-history limits from the backend", async () => {
  await using root = await tmpdir()
  await using ui = await mount(root.path)
  ui.usage({
    ...ledger(0),
    observation: { revision: "a".repeat(32), since: 1, before: "unknown", deleted: true },
  })
  ui.app.mockInput.pressKey("u")
  await ui.frame("Recorded embedding usage")
  ui.app.mockInput.pressKey("r")
  await ui.frame("0 observed attempts")
  await ui.frame("Pages share one recorded ledger revision")
  await ui.frame("Recorded history has been deleted")
  expect(ui.app.captureCharFrame().replace(/\s+/g, " ")).toContain("Earlier coverage is unknown")
  expect(ui.calls).toHaveLength(1)
})

test("terminal usage clears denied or invalid pages and retains explicit unknown reports", async () => {
  await using root = await tmpdir()
  await using ui = await mount(root.path)
  ui.app.mockInput.pressKey("u")
  await ui.frame("Recorded embedding usage")
  const entry = ledger().entries.at(0)!
  for (const invalid of [
    { ...ledger(), session: "foreign" },
    { ...ledger(), entries: [{ ...entry, session: "foreign" }] },
    { ...ledger(), entries: [{ ...entry, usage: { ...entry.usage, pending: 0 } }] },
    { ...ledger(), entries: [entry, entry] },
    { ...ledger(), next: "wrong" },
    ledger(101),
  ]) {
    ui.usage(ledger())
    ui.app.mockInput.pressKey("r")
    await ui.frame("1 observed attempts")
    ui.usage(invalid)
    ui.app.mockInput.pressKey("r")
    await ui.frame("Usage unavailable:", "1 observed attempts")
    expect(ui.app.captureCharFrame()).not.toContain("[d] Show")
  }
  ui.fail("Usage denied")
  ui.app.mockInput.pressKey("r")
  await ui.frame("Usage denied")
  ui.fail("")
  ui.usage({
    ...ledger(),
    entries: [{ ...entry, finished: 2, usage: account(entry.usage, { state: "response", prompt: 0, total: 7 }) }],
  })
  ui.app.mockInput.pressKey("r")
  await ui.frame("Prompt tokens: 0; reports: 1; unknown attempts: 0")
  await ui.frame("Total tokens: 7; reports: 1; unknown attempts: 0")
  expect(ui.app.captureCharFrame().replace(/\s+/g, " ")).toContain(
    "Old or purged attempts are unavailable. Exhausting these pages does not prove complete historical usage.",
  )
  ui.change()
  await ui.frame("Inspect usage again", "1 observed attempts")
  expect(ui.calls.every((call) => call.request.method === "GET")).toBe(true)
})

for (const action of ["cancel", "back", "close", "event", "scope"] as const) {
  for (const failed of [false, true]) {
    test(`terminal usage ${action} rejects late ${failed ? "failure" : "success"}`, async () => {
      await using root = await tmpdir()
      await using ui = await mount(root.path, true)
      ui.hold("usage")
      ui.app.mockInput.pressKey("u")
      await ui.frame("Recorded embedding usage")
      ui.app.mockInput.pressKey("r")
      await ui.until(() => ui.held.length === 1)
      if (action === "cancel") ui.app.mockInput.pressKey("c")
      if (action === "back") ui.app.mockInput.pressKey("q")
      if (action === "close") ui.app.mockInput.pressEscape()
      if (action === "event") ui.change()
      if (action === "scope") ui.scope()
      await ui.until(() => ui.held.at(0)!.request.signal.aborted)
      ui.held.at(0)!.release.resolve(
        failed
          ? Response.json({ message: "late-private-usage" }, { status: 403 })
          : Response.json({
              ...ledger(),
              entries: ledger().entries.map((entry) => ({ ...entry, id: "late-private-usage" })),
            }),
      )
      const frame = await ui.settled()
      expect(frame).not.toContain("late-private-usage")
      expect(frame).not.toContain("1 observed attempts")
      expect(ui.calls).toHaveLength(1)
      if (action === "close" || action === "scope") expect(frame).not.toContain("Recorded embedding usage")
      if (action === "cancel") expect(frame).toContain("No embedding job was cancelled")
    })
  }
}

for (const page of [
  { key: "", title: "Collection embeddings: Reference" },
  { key: "s", title: "Embedding coverage: Reference" },
  { key: "j", title: "Embedding job history: Reference" },
  { key: "u", title: "Recorded embedding usage" },
]) {
  test(`terminal ${page.title} owns paging over conversation shortcuts`, async () => {
    await using root = await tmpdir()
    await using ui = await mount(root.path, false, undefined, true)
    if (page.key) ui.app.mockInput.pressKey(page.key)
    await ui.frame(page.title)
    for (const key of ["\x1b[6~", "\x1b[5~"]) {
      ui.app.mockInput.pressKey(key)
      expect(await ui.settled()).toContain(page.title)
    }
  })
}

test("terminal usage scrolls long destinations with reachable controls", async () => {
  await using root = await tmpdir()
  await using ui = await mount(root.path)
  ui.usage({
    ...ledger(),
    entries: ledger().entries.map((entry) => ({
      ...entry,
      target: { ...entry.target, fingerprint: "route-".repeat(600) + "END-USAGE" },
    })),
  })
  ui.app.mockInput.pressKey("u")
  await ui.frame("Recorded embedding usage")
  ui.app.mockInput.pressKey("r")
  await ui.frame("1 observed attempts")
  expect(ui.app.captureCharFrame()).not.toContain("END-USAGE")
  for (let index = 0; index < 6 && !ui.app.captureCharFrame().includes("END-USAGE"); index++) {
    ui.app.mockInput.pressKey("\x1b[6~")
    await ui.settled()
  }
  await ui.frame("END-USAGE")
  expect(ui.app.captureCharFrame()).toContain("[r] Inspect latest usage")
  expect(ui.app.captureCharFrame()).toContain("[q] Back to embeddings")
})

test("terminal usage deadline cancels a held read independently of jobs", async () => {
  await using root = await tmpdir()
  await using ui = await mount(root.path, true)
  ui.hold("usage")
  ui.app.mockInput.pressKey("u")
  await ui.frame("Recorded embedding usage")
  ui.app.mockInput.pressKey("r")
  await ui.until(() => ui.held.length === 1)
  const request = ui.held.at(0)!.request
  await new Promise<void>((resolve) => request.signal.addEventListener("abort", () => resolve(), { once: true }))
  await ui.frame("Usage inspection timed out")
  expect(ui.app.captureCharFrame()).toContain("No embedding job was cancelled")
  expect(ui.calls).toHaveLength(1)
  ui.hold("")
  ui.app.mockInput.pressKey("r")
  await ui.frame("1 observed attempts")
}, 40_000)

test("terminal coverage requires an explicit read and displays scoped partitioned observations", async () => {
  await using root = await tmpdir()
  await using ui = await mount(root.path)
  ui.app.mockInput.pressKey("s")
  await ui.frame("Embedding coverage: Reference")
  expect(ui.calls).toHaveLength(0)
  for (const key of ["a", "i", "v", "j"]) ui.app.mockInput.pressKey(key)
  await ui.settled()
  expect(ui.calls).toHaveLength(0)
  ui.app.mockInput.pressKey("r")
  await ui.frame("Reusable vectors: 1")
  await ui.frame("Stored nonblank sections: 5")
  const frame = ui.app.captureCharFrame()
  for (const text of [
    "Stored nonblank sections: 5",
    "Missing vectors: 1",
    "Outdated vectors: 1",
    "Stale or unavailable originals: 1",
    "Excluded sections: 1",
    "1970-01-01T00:00:00.002Z",
    destination.target.model,
    destination.target.fingerprint,
  ])
    expect(frame).toContain(text)
  expect(ui.calls).toHaveLength(1)
  const request = ui.calls.at(0)!.request
  expect(request.method).toBe("GET")
  expect(new URL(request.url).pathname).toBe("/forge/knowledge/reference/embeddings/coverage")
  expect(new URL(request.url).searchParams.get("directory")).toBe(root.path)
  expect(new URL(request.url).searchParams.get("session")).toBe("chat")
  ui.change("other-chat")
  ui.change("", `${root.path}/foreign`)
  await ui.settled()
  expect(ui.app.captureCharFrame()).toContain("Reusable vectors: 1")
  ui.change()
  await ui.frame("Check coverage again", "Reusable vectors:")
  expect(ui.calls).toHaveLength(1)
  ui.coverage({ ...coverage(), sections: 0, reusable: 0, missing: 0, outdated: 0, stale: 0, excluded: 0 })
  ui.app.mockInput.pressKey("r")
  await ui.frame("Stored nonblank sections: 0")
  expect(ui.app.captureCharFrame()).not.toContain("100%")
  ui.app.mockInput.pressKey("q")
  await ui.frame("Collection embeddings: Reference")
  ui.app.mockInput.pressKey("s")
  await ui.frame("Embedding coverage: Reference", "Stored nonblank sections:")
  expect(ui.calls).toHaveLength(2)
  expect(ui.reads).toHaveLength(0)
})

test("terminal coverage rejects malformed or denied observations and clears previous counts", async () => {
  await using root = await tmpdir()
  await using ui = await mount(root.path)
  ui.app.mockInput.pressKey("s")
  await ui.frame("Embedding coverage: Reference")
  for (const invalid of [
    { ...coverage(), collection: "other" },
    { ...coverage(), session: "other" },
    { ...coverage(), missing: -1 },
    { ...coverage(), sections: 6 },
    { ...coverage(), sections: 10_001, reusable: 9997 },
    { ...coverage(), finished: 0 },
    { ...coverage(), started: 8_640_000_000_000_001, finished: 8_640_000_000_000_001 },
    { ...coverage(), target: { ...destination.target, dimensions: 0 } },
    null,
  ]) {
    ui.coverage(coverage())
    ui.app.mockInput.pressKey("r")
    await ui.frame("Reusable vectors: 1")
    ui.coverage(invalid)
    ui.app.mockInput.pressKey("r")
    await ui.frame("Coverage unavailable:", "Reusable vectors:")
    expect(ui.app.captureCharFrame()).not.toContain(destination.target.fingerprint)
  }
  ui.fail("Embeddings not configured")
  ui.app.mockInput.pressKey("r")
  await ui.frame("Coverage unavailable: Embeddings not configured")
  ui.fail("")
  ui.coverage(coverage())
  ui.app.mockInput.pressKey("r")
  await ui.frame("Reusable vectors: 1", "Coverage unavailable:")
})

for (const action of ["cancel", "back", "close", "event", "scope"] as const) {
  for (const failed of [false, true]) {
    test(`terminal coverage ${action} rejects late ${failed ? "failure" : "success"} from an uncooperative read`, async () => {
      await using root = await tmpdir()
      await using ui = await mount(root.path, true)
      ui.hold("coverage")
      ui.app.mockInput.pressKey("s")
      await ui.frame("Embedding coverage: Reference")
      ui.app.mockInput.pressKey("r")
      await ui.frame("Checking originals")
      await ui.until(() => ui.held.length === 1)
      if (action === "cancel") ui.app.mockInput.pressKey("c")
      if (action === "back") ui.app.mockInput.pressKey("q")
      if (action === "close") ui.app.mockInput.pressEscape()
      if (action === "event") ui.change()
      if (action === "scope") ui.scope()
      await ui.until(() => ui.held.at(0)!.request.signal.aborted)
      if (action === "cancel" || action === "event") {
        ui.hold("")
        ui.app.mockInput.pressKey("r")
        await ui.frame("Reusable vectors: 1")
      }
      ui.held
        .at(0)!
        .release.resolve(
          failed
            ? Response.json({ message: "late-private-canary" }, { status: 403 })
            : Response.json({ ...coverage(), target: { ...destination.target, model: "late-private-canary" } }),
        )
      await ui.settled()
      expect(ui.app.captureCharFrame()).not.toContain("late-private-canary")
      if (action === "cancel" || action === "event") expect(ui.app.captureCharFrame()).toContain("Reusable vectors: 1")
      if (action === "back") expect(ui.app.captureCharFrame()).toContain("Collection embeddings: Reference")
      if (action === "close" || action === "scope")
        expect(ui.app.captureCharFrame()).not.toContain("Embedding coverage:")
      expect(ui.calls.every((call) => call.request.method === "GET")).toBe(true)
    })
  }
}

test("terminal coverage scrolls through long destinations and restores controls after cancellation", async () => {
  await using root = await tmpdir()
  await using ui = await mount(root.path)
  ui.coverage({ ...coverage(), target: { ...destination.target, fingerprint: "route-".repeat(600) + "END-COVERAGE" } })
  ui.app.mockInput.pressKey("s")
  await ui.frame("Embedding coverage: Reference")
  ui.app.mockInput.pressKey("r")
  await ui.frame("Stored nonblank sections: 5")
  for (let step = 0; step < 6 && !ui.app.captureCharFrame().includes("END-COVERAGE"); step++) {
    ui.app.mockInput.pressKey("\x1b[6~")
    await ui.settled()
  }
  expect(ui.app.captureCharFrame()).toContain("END-COVERAGE")
  ui.hold("coverage")
  ui.app.mockInput.pressKey("r")
  await ui.frame("Checking originals")
  await ui.until(() => ui.held.length === 1)
  ui.app.mockInput.pressKey("c")
  await ui.frame("Coverage check cancelled. No embedding job was cancelled.", "END-COVERAGE")
  expect(ui.app.captureCharFrame()).toContain("[r] Check embedding coverage")
  ui.hold("")
  ui.fail("Permission denied. ".repeat(200) + "END-DENIAL")
  ui.app.mockInput.pressKey("r")
  await ui.frame("Coverage unavailable:")
  expect(ui.app.captureCharFrame()).toContain("[r] Check embedding coverage")
  expect(ui.app.captureCharFrame()).toContain("[q] Back to embeddings")
  for (let step = 0; step < 6 && !ui.app.captureCharFrame().includes("END-DENIAL"); step++) {
    ui.app.mockInput.pressKey("\x1b[6~")
    await ui.settled()
  }
  expect(ui.app.captureCharFrame()).toContain("END-DENIAL")
})

test("terminal embedding flow requires typed consent and separate indexing with active-session SDK scope", async () => {
  await using root = await tmpdir()
  await using ui = await mount(root.path)
  expect(ui.calls).toHaveLength(0)
  for (const key of ["a", "i"]) ui.app.mockInput.pressKey(key)
  await ui.settled()
  expect(ui.calls).toHaveLength(0)
  ui.app.mockInput.pressKey("r")
  await ui.frame("Not approved for this destination")
  expect(ui.app.captureCharFrame()).toContain(destination.endpoint)
  ui.app.mockInput.pressKey("a")
  await ui.frame("Type ALLOW")
  await ui.confirm("YES")
  await ui.frame("Type ALLOW to approve the reviewed")
  expect(ui.calls).toHaveLength(1)
  await ui.confirm("ALLOW")
  await ui.frame("No indexing was started", "Type ALLOW")
  expect(ui.calls).toHaveLength(2)
  expect(ui.calls.at(1)?.body).toEqual({ session: "chat", revision: destination.revision })
  ui.app.mockInput.pressKey("i")
  await ui.settled()
  expect(ui.calls).toHaveLength(2)
  ui.app.mockInput.pressKey("r")
  await ui.frame("[i] Index embeddings")
  ui.app.mockInput.pressKey("i")
  await ui.frame("Embedding job admitted")
  ui.app.mockInput.pressKey("j")
  await ui.frame("3 sections, 2 newly embedded, 1 reused")
  expect(ui.app.captureCharFrame()).toContain("not a guarantee of current coverage")
  ui.app.mockInput.pressKey("q")
  await ui.frame("Collection embeddings: Reference")
  ui.app.mockInput.pressKey("v")
  await ui.frame("Embedding consent revoked")
  expect(ui.calls.map((call) => new URL(call.request.url).pathname.split("/").at(-1))).toEqual([
    "embeddings",
    "approve",
    "embeddings",
    "jobs",
    "revoke",
  ])
  for (const call of ui.calls) {
    expect(new URL(call.request.url).searchParams.get("directory")).toBe(root.path)
    if (call.request.method === "GET") expect(new URL(call.request.url).searchParams.get("session")).toBe("chat")
    else expect(call.body).toMatchObject({ session: "chat" })
  }
  ui.app.mockInput.pressKey("q")
  await ui.frame("Forge knowledge library", "Collection embeddings:")
})

test("terminal invalidates typed approval only for matching knowledge events", async () => {
  await using root = await tmpdir()
  await using ui = await mount(root.path)
  ui.app.mockInput.pressKey("r")
  await ui.frame("Not approved for this destination")
  ui.app.mockInput.pressKey("a")
  await ui.frame("Type ALLOW")
  ui.change("other-chat")
  ui.change("", `${root.path}/foreign`)
  expect(await ui.settled()).toContain("Type ALLOW")
  ui.change()
  await ui.frame("Collection embeddings: Reference", "Type ALLOW")
  ui.app.mockInput.pressKey("a")
  ui.app.mockInput.pressEnter()
  expect(await ui.settled()).not.toContain(destination.endpoint)
  expect(ui.calls).toHaveLength(1)
})

test("long embedding routing details remain keyboard-scrollable during typed confirmation", async () => {
  await using root = await tmpdir()
  await using ui = await mount(root.path)
  ui.long()
  ui.app.mockInput.pressKey("r")
  await ui.frame("[a] Approve embedding destination")
  ui.app.mockInput.pressKey("a")
  await ui.frame("Type ALLOW")
  expect(ui.app.captureCharFrame()).not.toContain("END-ROUTE")
  for (let index = 0; index < 4; index++) {
    ui.app.mockInput.pressKey("\x1b[6~")
    await ui.app.renderOnce()
  }
  await ui.frame("END-ROUTE")
  expect(ui.calls).toHaveLength(1)
  await ui.confirm("ALLOW")
  await ui.frame("No indexing was started")
  expect(ui.calls).toHaveLength(2)
})

test("terminal errors and malformed reviews cannot enable indexing and offline revocation stays available", async () => {
  await using root = await tmpdir()
  await using ui = await mount(root.path)
  ui.approve()
  ui.app.mockInput.pressKey("r")
  await ui.frame("[i] Index embeddings")
  ui.fail("Embedding permission denied")
  ui.app.mockInput.pressKey("i")
  await ui.frame("Embedding permission denied", "[i] Index embeddings")
  ui.fail("")
  ui.malformed(true)
  ui.app.mockInput.pressKey("r")
  await ui.until(() => ui.calls.length === 3)
  expect(await ui.settled()).not.toContain("[i] Index embeddings")
  ui.fail("Embeddings not configured")
  ui.app.mockInput.pressKey("r")
  await ui.frame("Embeddings not configured")
  ui.app.mockInput.pressKey("v")
  await ui.frame("Embedding consent revoked", "Embeddings not configured")
})

for (const action of ["cancel", "back", "escape", "scope", "event"]) {
  for (const failure of [false, true]) {
    test(`terminal ${action} releases a review and discards late ${failure ? "failure" : "approval"}`, async () => {
      await using root = await tmpdir()
      await using ui = await mount(root.path, true)
      ui.hold("embeddings")
      ui.app.mockInput.pressKey("r")
      await ui.until(() => ui.held.length === 1)
      await ui.frame("Waiting for embedding review")
      if (action === "scope") ui.scope()
      if (action === "event") ui.change()
      if (action === "escape") ui.app.mockInput.pressEscape()
      if (action === "cancel") ui.app.mockInput.pressKey("c")
      if (action === "back") ui.app.mockInput.pressKey("q")
      await ui.until(() => ui.held.at(0)!.request.signal.aborted)
      const visible =
        action === "escape"
          ? "Chat remains available"
          : action === "back"
            ? "Forge knowledge library"
            : action === "scope"
              ? "Workspace or session changed"
              : "Collection embeddings: Reference"
      await ui.frame(visible, "Waiting for embedding review")
      ui.held
        .at(0)!
        .release.resolve(
          failure
            ? Response.json({ message: "Late failure canary" }, { status: 503 })
            : Response.json({ ...destination, approved: true }),
        )
      const frame = await ui.settled()
      expect(frame).not.toContain("[i] Index embeddings")
      expect(frame).not.toContain("Late failure canary")
      expect(frame).not.toContain(destination.endpoint)
      if (action !== "cancel") return
      ui.hold("")
      ui.app.mockInput.pressKey("r")
      await ui.frame("Not approved for this destination")
    })
  }
}

test("terminal event does not cancel admission and cancelling its request permits history inspection and retry", async () => {
  await using root = await tmpdir()
  await using ui = await mount(root.path, true)
  ui.approve()
  ui.app.mockInput.pressKey("r")
  await ui.frame("[i] Index embeddings")
  ui.hold("jobs")
  ui.app.mockInput.pressKey("i")
  await ui.until(() => ui.held.length === 1)
  ui.change()
  await ui.frame("waiting for admission")
  expect(ui.held.at(0)!.request.signal.aborted).toBe(false)
  ui.app.mockInput.pressKey("c")
  await ui.frame("An admitted job may still be running", "waiting for admission")
  expect(ui.held.at(0)!.request.signal.aborted).toBe(true)
  ui.app.mockInput.pressKey("r")
  await ui.frame("[i] Index embeddings")
  ui.hold("")
  ui.app.mockInput.pressKey("i")
  await ui.frame("Embedding job admitted")
  ui.app.mockInput.pressKey("j")
  await ui.frame("3 sections, 2 newly embedded, 1 reused")
  ui.held.at(0)!.release.resolve(Response.json({ ...job(), id: "late-999" }))
  expect(await ui.settled()).not.toContain("999")
})

test("terminal history persists across reopening and explicitly cancels only the selected scoped job", async () => {
  await using root = await tmpdir()
  await using ui = await mount(root.path)
  ui.approve()
  ui.running()
  ui.app.mockInput.pressKey("r")
  await ui.frame("[i] Index embeddings")
  ui.app.mockInput.pressKey("i")
  await ui.frame("Embedding job admitted")
  ui.app.mockInput.pressKey("q")
  await ui.frame("Forge knowledge library")
  expect(ui.calls.some((call) => new URL(call.request.url).pathname.endsWith("/cancel"))).toBe(false)
  ui.app.mockInput.pressKey("e")
  await ui.frame("Collection embeddings: Reference")
  ui.app.mockInput.pressKey("j")
  await ui.frame("State: running")
  expect(ui.reads.at(0)?.url).toContain("session=chat")
  expect(ui.reads.at(0)?.url).toContain(encodeURIComponent(root.path))
  ui.app.mockInput.pressKey("c")
  await ui.frame("State: cancelled")
  expect(new URL(ui.calls.at(-1)!.request.url).pathname).toBe("/forge/knowledge/reference/embeddings/jobs/job-1/cancel")
  expect(ui.calls.at(-1)?.body).toEqual({ session: "chat" })
})

test("terminal job usage distinguishes partial reports and unavailable legacy records", async () => {
  await using root = await tmpdir()
  await using ui = await mount(root.path)
  ui.rows([job()])
  ui.app.mockInput.pressKey("j")
  await ui.frame("State: completed")
  ui.app.mockInput.pressKey("\x1b[6~")
  await ui.frame("Usage accounting unavailable for this job.")
  const usage = {
    attempts: 3,
    inputs: 33,
    bytes: 2048,
    responses: 1,
    failed: 1,
    pending: 1,
    promptTokens: 42,
    promptReports: 1,
    totalTokens: 0,
    totalReports: 0,
  }
  ui.rows([{ ...job("failed"), usage }])
  ui.app.mockInput.pressKey("r")
  await ui.frame("State: failed")
  ui.app.mockInput.pressKey("\x1b[6~")
  await ui.frame("Monetary cost")
  expect(ui.app.captureCharFrame().replace(/\s+/g, " ")).toContain("Monetary cost unknown.")
  expect(ui.app.captureCharFrame()).toContain("prompt-token subtotal: 42 from 1 reports; 2 attempts unknown")
  expect(ui.app.captureCharFrame()).toContain("total-token subtotal: 0 from 0 reports; 3 attempts unknown")
  ui.rows([{ ...job("failed"), usage: { ...usage, attempts: 4 } }])
  ui.app.mockInput.pressKey("r")
  await ui.frame("inconsistent counters")
  expect(ui.calls).toEqual([])
})

test("terminal history retains selection by ID across events and navigates bounded older and newer records", async () => {
  await using root = await tmpdir()
  await using ui = await mount(root.path)
  ui.rows([job("running"), { ...job(), id: "older" }])
  ui.app.mockInput.pressKey("j")
  await ui.frame("Job 1 of 2: job-1")
  ui.app.mockInput.pressKey("o")
  await ui.frame("Job 2 of 2: older")
  ui.rows([{ ...job("running"), id: "newest" }, job("running"), { ...job(), id: "older" }])
  ui.change()
  await ui.frame("Job 3 of 3: older")
  ui.app.mockInput.pressKey("c")
  await ui.settled()
  expect(ui.calls).toEqual([])
  ui.app.mockInput.pressKey("u")
  await ui.frame("Job 2 of 3: job-1")
  ui.app.mockInput.pressKey("c")
  await ui.frame("State: cancelled")
  expect(new URL(ui.calls.at(-1)!.request.url).pathname).toContain("/job-1/cancel")
})

test("terminal history failures clear stale records and local retry needs no configured embedding provider", async () => {
  await using root = await tmpdir()
  await using ui = await mount(root.path)
  ui.rows([job("running")])
  ui.app.mockInput.pressKey("j")
  await ui.frame("State: running")
  ui.history("failed")
  ui.app.mockInput.pressKey("r")
  await ui.frame("History denied", "State: running")
  ui.history("foreign")
  ui.app.mockInput.pressKey("r")
  await ui.frame("does not match", "job-1")
  ui.history("")
  ui.app.mockInput.pressKey("r")
  await ui.frame("State: running")
  ui.fail("Cancellation denied")
  ui.app.mockInput.pressKey("c")
  await ui.frame("Cancellation denied")
  expect(ui.app.captureCharFrame()).toContain("State: running")
  ui.fail("")
  ui.app.mockInput.pressKey("c")
  await ui.frame("State: cancelled", "Cancellation denied")
})

for (const action of ["back", "escape", "scope", "refresh"]) {
  test(`terminal ${action} cancels a history read and ignores its late result`, async () => {
    await using root = await tmpdir()
    await using ui = await mount(root.path, true)
    ui.history("held")
    ui.app.mockInput.pressKey("j")
    await ui.until(() => ui.held.length === 1)
    if (action === "back") ui.app.mockInput.pressKey("q")
    if (action === "escape") ui.app.mockInput.pressEscape()
    if (action === "scope") ui.scope()
    if (action === "refresh") {
      ui.history("")
      ui.app.mockInput.pressKey("r")
      await ui.frame("No retained embedding jobs")
    }
    await ui.until(() => ui.held.at(0)!.request.signal.aborted)
    ui.held.at(0)!.release.resolve(Response.json([{ ...job(), id: "late-history-canary" }]))
    expect(await ui.settled()).not.toContain("late-history-canary")
  })
}

test("terminal cancellation remains usable during a held heartbeat refresh", async () => {
  await using root = await tmpdir()
  await using ui = await mount(root.path, true)
  ui.rows([job("running")])
  ui.app.mockInput.pressKey("j")
  await ui.frame("State: running")
  ui.history("held")
  ui.change()
  await ui.until(() => ui.held.length === 1)
  await ui.frame("Refreshing embedding jobs")
  ui.history("")
  ui.app.mockInput.pressKey("c")
  await ui.frame("State: cancelled")
  expect(ui.held.at(0)!.request.signal.aborted).toBe(true)
  ui.held.at(0)!.release.resolve(Response.json([job("running")]))
  expect(await ui.settled()).toContain("State: cancelled")
})

test("closing a pending cancellation aborts only its client request and ignores a late error", async () => {
  await using root = await tmpdir()
  await using ui = await mount(root.path, true)
  ui.rows([job("running")])
  ui.app.mockInput.pressKey("j")
  await ui.frame("State: running")
  ui.hold("cancel")
  ui.app.mockInput.pressKey("c")
  await ui.until(() => ui.held.length === 1)
  await ui.frame("Requesting job cancellation")
  ui.app.mockInput.pressKey("q")
  await ui.frame("Collection embeddings: Reference")
  expect(ui.held.at(0)!.request.signal.aborted).toBe(true)
  ui.held.at(0)!.release.resolve(Response.json({ message: "late-cancel-canary" }, { status: 500 }))
  expect(await ui.settled()).not.toContain("late-cancel-canary")
  expect(ui.reads).toHaveLength(1)
})

test("terminal validates history dates and bounds and scrolls long destination details", async () => {
  await using root = await tmpdir()
  await using ui = await mount(root.path)
  ui.rows([{ ...job(), updated: 8_640_000_000_000_001 }])
  ui.app.mockInput.pressKey("j")
  await ui.frame("invalid identifiers or timestamps")
  ui.rows(Array.from({ length: 17 }, (_, index) => ({ ...job(), id: String(index) })))
  ui.app.mockInput.pressKey("r")
  await ui.frame("does not match")
  ui.rows([
    { ...job("interrupted"), error: "END-OF-JOB", target: { ...job().target, fingerprint: "routing-".repeat(300) } },
  ])
  ui.app.mockInput.pressKey("r")
  await ui.frame("State: interrupted")
  expect(ui.app.captureCharFrame()).not.toContain("END-OF-JOB")
  for (let index = 0; index < 6; index++) {
    ui.app.mockInput.pressKey("\x1b[6~")
    await ui.app.renderOnce()
  }
  await ui.frame("END-OF-JOB")
  expect(ui.app.captureCharFrame()).not.toContain("[c] Cancel selected")
})

test.skipIf(process.env.FORGE_EMBEDDING_SOURCE !== "1" && !process.env.FORGE_EMBEDDING_BINARY)(
  "terminal controls compose with actual backend consent, extraction, events and transport",
  async () => {
    await using root = await tmpdir()
    const directory = root.path
    const repo = path.resolve(import.meta.dir, "../../../..")
    const binary = process.env.FORGE_EMBEDDING_BINARY
    const inputs: unknown[] = []
    let coding = 0
    let held = true
    const entered = Promise.withResolvers<void>()
    const released = Promise.withResolvers<void>()
    const closed = Promise.withResolvers<void>()
    const fixture = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        if (new URL(request.url).pathname !== "/v1/embeddings") {
          coding++
          return new Response("Unexpected coding request", { status: 500 })
        }
        expect(request.headers.get("authorization")).toBe("Bearer local-embedding-key")
        const body: unknown = await request.json()
        if (!body || typeof body !== "object" || !("input" in body) || !Array.isArray(body.input))
          throw new Error("Expected embedding inputs")
        inputs.push(body.input)
        if (held) {
          request.signal.addEventListener("abort", () => closed.resolve(), { once: true })
          entered.resolve()
          await released.promise
        }
        return Response.json({
          data: body.input.map((_, index) => ({ index, embedding: [1, 0] })),
          usage: { prompt_tokens: 7, total_tokens: 7 },
        })
      },
    })
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
    const port = probe.port
    await probe.stop(true)
    const origin = `http://127.0.0.1:${port}`
    const headers = { authorization: `Basic ${Buffer.from("kilo:local-terminal-fixture").toString("base64")}` }
    const config = {
      plugin: [],
      model: "fixture/model",
      small_model: "fixture/model",
      enabled_providers: ["fixture"],
      provider: {
        fixture: {
          npm: "@ai-sdk/openai-compatible",
          api: `${fixture.url}v1`,
          options: { apiKey: "local-coding-key" },
          models: { model: { name: "Local fixture", limit: { context: 32000, output: 1000 } } },
        },
      },
      indexing: { enabled: false },
      snapshot: false,
      formatter: false,
      lsp: false,
    }
    const proc = Bun.spawn(
      [
        ...(binary
          ? [binary]
          : [process.execPath, "run", "--conditions=node", path.join(repo, "packages/opencode/src/index.ts")]),
        "serve",
        "--hostname",
        "127.0.0.1",
        "--port",
        String(port),
      ],
      {
        cwd: directory,
        env: {
          ...process.env,
          HOME: directory,
          XDG_DATA_HOME: path.join(directory, "data"),
          XDG_CONFIG_HOME: path.join(directory, "config"),
          XDG_STATE_HOME: path.join(directory, "state"),
          XDG_CACHE_HOME: path.join(directory, "cache"),
          KILO_TEST_HOME: directory,
          KILO_AUTH_CONTENT: "{}",
          KILO_CONFIG_CONTENT: JSON.stringify(config),
          KILO_DISABLE_PROJECT_CONFIG: "1",
          KILO_DISABLE_MODELS_FETCH: "1",
          MODELS_DEV_API_JSON: path.join(repo, "packages/opencode/node_modules/.cache/models-dev-api.json"),
          KILO_DISABLE_AUTOUPDATE: "1",
          KILO_TELEMETRY_LEVEL: "off",
          KILO_SERVER_PASSWORD: "local-terminal-fixture",
          KILO_CLIENT: "cli",
          KILO_NO_DAEMON: "1",
          KILO_FORGE_EMBEDDING_ENDPOINT: `${fixture.url}v1/embeddings`,
          KILO_FORGE_EMBEDDING_MODEL: "fixture",
          KILO_FORGE_EMBEDDING_DIMENSIONS: "2",
          KILO_FORGE_EMBEDDING_KEY: "local-embedding-key",
          KILO_FORGE_EMBEDDING_AUTHENTICATION: "bearer",
          KILO_FORGE_EMBEDDING_ORGANIZATION: "",
          KILO_FORGE_EMBEDDING_PROJECT: "",
        },
        stdout: Bun.file(path.join(directory, "backend.stdout.log")),
        stderr: Bun.file(path.join(directory, "backend.stderr.log")),
      },
    )
    try {
      const deadline = performance.now() + 60000
      while (
        !(await fetch(`${origin}/global/health`, { headers, signal: AbortSignal.timeout(1000) }).then(
          (value) => value.ok,
          () => false,
        ))
      ) {
        if (performance.now() > deadline) throw new Error("Backend did not start")
        await Bun.sleep(25)
      }
      const client = createKiloClient({ baseUrl: origin, directory, headers })
      const options = { throwOnError: true as const }
      const session = (await client.session.create({ directory }, options)).data.id
      const text = "Release ownership only after the signed receipt arrives."
      const collection = (
        await client.forge.register(
          { directory, kind: "text", label: "Reference", location: "", content: text, session: "" },
          options,
        )
      ).data
      await client.forge.collection(
        { directory, id: collection.id, session, action: "approve", providers: [] },
        options,
      )
      await client.forge.collection({ directory, id: collection.id, session, action: "index" }, options)
      await using ui = await mount(directory, false, { url: origin, session, headers })
      async function review(text: string) {
        for (let attempt = 0; attempt < 3; attempt++) {
          ui.app.mockInput.pressKey("r")
          await ui.until(() => {
            const frame = ui.app.captureCharFrame()
            return frame.includes(text) || frame.includes("Knowledge changed. Review")
          })
          if (ui.app.captureCharFrame().includes(text)) return
        }
        throw new Error("Consent review kept changing during source-backend test")
      }
      async function inspect(text: string) {
        ui.app.mockInput.pressKey("s")
        await ui.frame("Embedding coverage: Reference")
        for (let attempt = 0; attempt < 3; attempt++) {
          ui.app.mockInput.pressKey("r")
          await ui.until(() => {
            const frame = ui.app.captureCharFrame()
            return frame.includes(text) || frame.includes("Knowledge changed. Check coverage")
          })
          if (ui.app.captureCharFrame().includes(text)) return
        }
        throw new Error("Coverage kept changing during source-backend test")
      }
      async function usage() {
        ui.app.mockInput.pressKey("u")
        await ui.frame("Recorded embedding usage")
        expect(ui.app.captureCharFrame()).not.toContain("observed attempts in this page")
        for (let attempt = 0; attempt < 3; attempt++) {
          ui.app.mockInput.pressKey("r")
          await ui.until(() => {
            const frame = ui.app.captureCharFrame()
            return frame.includes("2 observed attempts") || frame.includes("Knowledge changed. Inspect usage")
          })
          if (!ui.app.captureCharFrame().includes("2 observed attempts")) continue
          await ui.frame("Admitted attempts: 2; inputs: 2; request-body bytes: 258")
          await ui.frame("Prompt tokens: 7; reports: 1; unknown attempts: 1")
          await ui.frame("Total tokens: 7; reports: 1; unknown attempts: 1")
          expect(inputs).toHaveLength(2)
          return
        }
        throw new Error("Usage kept changing during source-backend test")
      }
      expect(inputs).toHaveLength(0)
      await inspect("has not been approved")
      expect(inputs).toHaveLength(0)
      ui.app.mockInput.pressKey("q")
      await ui.frame("Collection embeddings: Reference")
      await review("Not approved for this destination")
      expect(ui.app.captureCharFrame()).toContain(`${fixture.url}v1/embeddings`)
      ui.app.mockInput.pressKey("a")
      await ui.frame("Type ALLOW")
      await ui.confirm("ALLOW")
      await ui.frame("No indexing was started")
      expect(inputs).toHaveLength(0)
      // Let the real consent publication event reach the UI before reviewing again.
      await ui.settled()
      await inspect("Missing vectors: 1")
      expect(inputs).toHaveLength(0)
      ui.app.mockInput.pressKey("q")
      await ui.frame("Collection embeddings: Reference")
      await review("[i] Index embeddings")
      ui.app.mockInput.pressKey("i")
      await ui.frame("Embedding job admitted")
      await entered.promise
      ui.app.mockInput.pressKey("q")
      await ui.frame("Forge knowledge library")
      ui.app.mockInput.pressKey("e")
      await ui.frame("Collection embeddings: Reference")
      ui.app.mockInput.pressKey("j")
      await ui.frame("State: running")
      expect(inputs).toHaveLength(1)
      ui.app.mockInput.pressKey("c")
      await ui.frame("State: cancelled")
      await closed.promise
      ui.app.mockInput.pressKey("\x1b[6~")
      await ui.frame("prompt-token subtotal: 0 from 0 reports; 1 attempts unknown")
      held = false
      ui.app.mockInput.pressKey("q")
      await ui.frame("Collection embeddings: Reference")
      await ui.settled()
      await review("[i] Index embeddings")
      ui.app.mockInput.pressKey("i")
      await ui.frame("Embedding job admitted")
      ui.app.mockInput.pressKey("j")
      await ui.frame("1 sections, 1 newly embedded, 0 reused")
      ui.app.mockInput.pressKey("\x1b[6~")
      await ui.frame("prompt-token subtotal: 7 from 1 reports; 0 attempts unknown")
      await ui.frame("total-token subtotal: 7 from 1 reports; 0 attempts unknown")
      if (process.env.FORGE_TERMINAL_OUTPUT)
        await Bun.write(`${process.env.FORGE_TERMINAL_OUTPUT}.usage`, ui.app.captureCharFrame())
      released.resolve()
      expect(inputs).toEqual([[text], [text]])
      ui.app.mockInput.pressKey("q")
      await ui.frame("Collection embeddings: Reference")
      await inspect("Reusable vectors: 1")
      expect(inputs).toHaveLength(2)
      await ui.frame("Stored nonblank sections: 1")
      if (process.env.FORGE_TERMINAL_OUTPUT)
        await Bun.write(process.env.FORGE_TERMINAL_OUTPUT, ui.app.captureCharFrame())
      ui.app.mockInput.pressKey("q")
      await ui.frame("Collection embeddings: Reference")
      ui.app.mockInput.pressKey("q")
      await ui.frame("Forge knowledge library")
      ui.app.mockInput.pressKey("e")
      await ui.frame("Collection embeddings: Reference")
      await review("[i] Index embeddings")
      ui.app.mockInput.pressKey("i")
      await ui.frame("Embedding job admitted")
      ui.app.mockInput.pressKey("j")
      await ui.frame("1 sections, 0 newly embedded, 1 reused")
      ui.app.mockInput.pressKey("\x1b[6~")
      await ui.frame("Locally admitted attempts: 0; inputs: 0; request-body bytes: 0.")
      await ui.frame("prompt-token subtotal: 0 from 0 reports; 0 attempts unknown")
      expect(inputs).toHaveLength(2)
      ui.app.mockInput.pressKey("q")
      await ui.frame("Collection embeddings: Reference")
      await inspect("Reusable vectors: 1")
      expect(inputs).toHaveLength(2)
      ui.app.mockInput.pressKey("q")
      await ui.frame("Collection embeddings: Reference")
      await usage()
      if (process.env.FORGE_TERMINAL_OUTPUT)
        await Bun.write(`${process.env.FORGE_TERMINAL_OUTPUT}.ledger`, ui.app.captureCharFrame())
      ui.app.mockInput.pressKey("q")
      await ui.frame("Collection embeddings: Reference")
      ui.app.mockInput.pressKey("v")
      await ui.frame("Embedding consent revoked")
      await ui.settled()
      await usage()
      ui.app.mockInput.pressKey("q")
      await ui.frame("Collection embeddings: Reference")
      await inspect("has not been approved")
      expect(inputs).toHaveLength(2)
      ui.app.mockInput.pressKey("q")
      await ui.frame("Collection embeddings: Reference")
      await review("Not approved for this destination")
      expect(ui.app.captureCharFrame()).not.toContain("[i] Index embeddings")
      expect(
        (await client.forge.embeddingReview({ directory, id: collection.id, session }, options)).data.approved,
      ).toBe(false)
      const jobs = (await client.forge.embeddingJobs({ directory, id: collection.id, session }, options)).data
      const request = { directory, session, before: Date.now() + 1000, keep: 1 }
      await usage()
      const preview = (await client.forge.embeddingRetention(request, options)).data
      expect(preview.selected).toBe(1)
      expect(preview.more).toBe(false)
      await ui.settled()
      expect(ui.app.captureCharFrame()).toContain("2 observed attempts")
      const result = (
        await client.forge.embeddingPrune({ ...request, revision: preview.revision, confirmation: "DELETE" }, options)
      ).data
      expect(result).toEqual({ deleted: 1, more: false })
      await ui.frame("Knowledge changed. Inspect usage again.")
      expect(ui.app.captureCharFrame()).not.toContain("2 observed attempts")
      ui.app.mockInput.pressKey("r")
      await ui.frame("1 observed attempts")
      await ui.frame("Admitted attempts: 1; inputs: 1; request-body bytes: 129")
      await ui.frame("Prompt tokens: 7; reports: 1; unknown attempts: 0")
      ui.app.mockInput.pressKey("\x1b[6~")
      await ui.frame("Recorded history has been deleted.")
      if (process.env.FORGE_TERMINAL_OUTPUT)
        await Bun.write(`${process.env.FORGE_TERMINAL_OUTPUT}.retention`, ui.app.captureCharFrame())
      expect((await client.forge.embeddingJobs({ directory, id: collection.id, session }, options)).data).toEqual(jobs)
      expect(inputs).toHaveLength(2)
      expect(coding).toBe(0)
      console.log(
        JSON.stringify({
          backend: binary ? "native" : "source",
          binary,
          authenticated: true,
          activeSession: true,
          sharedCollection: true,
          embeddingRequests: inputs.length,
          exactOriginal: true,
          reused: true,
          revoked: true,
          closeReopen: true,
          explicitCancellation: true,
          explicitCoverage: true,
          coverageNoEgress: true,
          providerUsage: true,
          cancelledUsageUnknown: true,
          reuseWithoutAttempts: true,
          sessionUsage: true,
          usageNoEgress: true,
          retentionInvalidatesObservation: true,
          retentionPreservesJobs: true,
          codingCalls: coding,
        }),
      )
    } catch (err) {
      console.error(await Bun.file(path.join(directory, "backend.stdout.log")).text())
      console.error(await Bun.file(path.join(directory, "backend.stderr.log")).text())
      throw err
    } finally {
      released.resolve()
      proc.kill("SIGTERM")
      const timer = setTimeout(() => proc.kill("SIGKILL"), 8000)
      await proc.exited
      clearTimeout(timer)
      await fixture.stop(true)
    }
  },
  90000,
)
