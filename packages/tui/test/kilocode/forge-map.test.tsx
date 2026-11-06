/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { TextareaRenderable } from "@opentui/core"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { createSignal, onCleanup, onMount } from "solid-js"
import { engine } from "@kilocode/forge"
import { knowledge } from "@kilocode/forge/knowledge"
import { store } from "@kilocode/forge/store"
import { usage, type Manifest } from "@kilocode/forge/schema"
import { document } from "../../../opencode/src/kilocode/forge/documents"
import { TuiConfigProvider } from "../../src/config"
import { KVProvider } from "../../src/context/kv"
import { ProjectProvider } from "../../src/context/project"
import { RouteProvider } from "../../src/context/route"
import { SDKProvider } from "../../src/context/sdk"
import { ThemeProvider } from "../../src/context/theme"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../src/keymap"
import { forgePrompt } from "../../src/kilocode/forge/prompt"
import { ForgeModel } from "../../src/kilocode/forge/provider"
import { DialogProvider, useDialog } from "../../src/ui/dialog"
import { ToastProvider } from "../../src/ui/toast"
import { tmpdir } from "../fixture/fixture"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"

function pdf() {
  const text = "BT /F1 12 Tf 72 720 Td (PDF policy requires epoch validation.) Tj ET"
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
  ]
  let body = "%PDF-1.4\n"
  const offsets: number[] = []
  for (const [index, object] of objects.entries()) { offsets.push(body.length); body += `${index + 1} 0 obj\n${object}\nendobj\n` }
  const xref = body.length
  return body + `xref\n0 6\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
}

function docx() {
  const files = [
    ["[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'],
    ["_rels/.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'],
    ["word/document.xml", '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Word policy requires a durable journal.</w:t></w:r></w:p></w:body></w:document>'],
  ] as const
  const parts: Buffer[] = []
  const headers: Buffer[] = []
  let offset = 0
  // A minimal stored ZIP keeps the real DOCX parser under test without another TUI dependency.
  for (const [file, text] of files) {
    const name = Buffer.from(file)
    const bytes = Buffer.from(text)
    const crc = Bun.hash.crc32(bytes)
    const local = Buffer.alloc(30 + name.length)
    local.writeUInt32LE(0x04034b50)
    local.writeUInt16LE(20, 4)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(bytes.length, 18)
    local.writeUInt32LE(bytes.length, 22)
    local.writeUInt16LE(name.length, 26)
    name.copy(local, 30)
    const central = Buffer.alloc(46 + name.length)
    central.writeUInt32LE(0x02014b50)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(bytes.length, 20)
    central.writeUInt32LE(bytes.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    name.copy(central, 46)
    parts.push(local, bytes)
    headers.push(central)
    offset += local.length + bytes.length
  }
  const directory = Buffer.concat(headers)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...parts, directory, end])
}

async function mount(root: string, command: "overview" | "map" = "map", registered = true, capture = false) {
  await Bun.write(`${root}/kv.json`, "{}")
  await Bun.write(`${root}/main.ts`, "export function dispatch() { return 1 }\n")
  const db = new Database(":memory:")
  const storage = store({
    all: async (query) => db.query<Record<string, unknown>, (string | number | null)[]>(query.text).all(...query.values ?? []),
    batch: async (queries) => { db.transaction(() => { for (const query of queries) db.query(query.text).run(...query.values ?? []) })() },
  })
  const api = engine({ root, store: storage, docx: document, complete: async () => { throw new Error("Map and import actions must not call a model") } })
  const library = knowledge(root, storage, { docx: document })
  if (registered) {
    await Bun.write(`${root}/references/policy.pdf`, pdf())
    await Bun.write(`${root}/references/report.docx`, docx())
    await Bun.write(`${root}/references/guide.md`, "# Reference guide\nUse verified source passages.")
    const item = await api.register({ kind: "folder", label: "References", location: "references", watch: false })
    await api.approve(item.id)
    await library.index(item.id)
  }
  await api.refresh(true)
  if (capture) {
    const section = (await storage.knowledge(root)).find((source) => source.detail.document === "policy.pdf" && source.method === "collection-section")!
    const manifest: Manifest = {
      id: "captured-request", root, session: "", generation: "historical", purpose: "coding", model: "historical-model",
      observed: Date.now(), state: "sent", usage: usage(), coverage: [],
      entries: [{ source: section.id, kind: section.kind, label: section.label, uri: section.uri, hash: section.hash, text: "Previously sent PDF excerpt.", stage: "sent", tokens: 8 }],
    }
    await storage.manifest(manifest)
  }
  const calls: { method: string; path: string; category?: string; document?: string; body?: Record<string, unknown> }[] = []
  const gate = Promise.withResolvers<void>()
  let held = false
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const body = request.method === "GET" ? undefined : await request.json()
      calls.push({ method: request.method, path: url.pathname, category: url.searchParams.get("category") ?? undefined, document: url.searchParams.get("document") ?? undefined, body })
      try {
        if (url.pathname === "/forge/status") return Response.json(await api.status())
        if (url.pathname === "/forge/view") {
          if (held && url.searchParams.get("document")) await gate.promise
          return Response.json(await api.view({
            category: url.searchParams.get("category") ?? undefined, document: url.searchParams.get("document") ?? undefined,
            generation: url.searchParams.get("generation") ?? undefined, offset: Number(url.searchParams.get("offset") ?? 0), limit: 25,
          }))
        }
        if (url.pathname.startsWith("/forge/source/")) return Response.json(await api.symbol(decodeURIComponent(url.pathname.slice("/forge/source/".length))))
        if (url.pathname.endsWith("/imports")) return Response.json(await api.imports(decodeURIComponent(url.pathname.split("/").at(-2)!)))
        if (url.pathname === "/forge/requests") return Response.json(await api.manifests({ session: "", purpose: url.searchParams.get("purpose") ?? undefined }))
        if (url.pathname === "/forge/knowledge/preview") return Response.json(await api.preview(body))
        if (url.pathname === "/forge/knowledge" && request.method === "POST") return Response.json(await api.register(body))
        if (url.pathname === "/forge/knowledge") return Response.json({ ...await api.registry({
          query: url.searchParams.get("query") ?? "", limit: 10, offset: Number(url.searchParams.get("offset") ?? 0),
        }), provider: "" })
        if (url.pathname.startsWith("/forge/knowledge/") && request.method === "PUT") {
          const id = decodeURIComponent(url.pathname.slice("/forge/knowledge/".length))
          if (body.action === "approve") return Response.json({ collection: await api.approve(id, body.session, body.providers, body.grants) })
          if (body.action === "index") return Response.json({ collection: await api.index(id, body.session) })
          if (body.action === "pause") return Response.json({ collection: await api.stop(id, body.session) })
        }
        return Response.json({ message: `Unexpected ${request.method} ${url.pathname}` }, { status: 404 })
      } catch (err) { return Response.json({ message: String(err) }, { status: 500 }) }
    },
  })
  let select: ((value: string) => void) | undefined
  function Open() {
    const dialog = useDialog()
    onMount(() => forgePrompt(`/${command}`, dialog))
    return <text>Chat remains available</text>
  }
  function Model() {
    const [model, change] = createSignal("current-model")
    select = change
    return <ForgeModel.Provider value={model}><DialogProvider><Open /></DialogProvider></ForgeModel.Provider>
  }
  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig()
    onCleanup(registerOpencodeKeymap(keymap, renderer, config))
    return <TestTuiContexts directory={root} paths={{ home: root, state: root, worktree: root }}>
      <OpencodeKeymapProvider keymap={keymap}><TuiConfigProvider config={config}>
        <SDKProvider url={server.url.toString()} directory={root} browser={async () => { throw new Error("The terminal map must not launch a browser") }}
          events={{ subscribe: async (fn) => storage.subscribe(root, (event) => fn({ directory: root, payload: { id: crypto.randomUUID(), type: "forge.changed", properties: event } })) }}>
          <ProjectProvider><RouteProvider><KVProvider><ThemeProvider mode="dark" source={{ discover: async () => ({}) }}>
            <ToastProvider><Model /></ToastProvider>
          </ThemeProvider></KVProvider></RouteProvider></ProjectProvider>
        </SDKProvider>
      </TuiConfigProvider></OpencodeKeymapProvider>
    </TestTuiContexts>
  }
  const app = await testRender(() => <Harness />, { width: 120, height: 48 })
  async function until(check: () => boolean | Promise<boolean>) {
    const end = performance.now() + 5000
    while (performance.now() < end) {
      await app.renderOnce()
      if (await check()) return
      await Bun.sleep(5)
    }
    throw new Error(`Terminal condition timed out\n${app.captureCharFrame()}`)
  }
  return {
    app, calls, api, library, until,
    hold() { held = true },
    release() { held = false; gate.resolve() },
    model(value: string) { select!(value) },
    async frame(text: string, absent = "") {
      await until(() => app.captureCharFrame().includes(text) && (!absent || !app.captureCharFrame().includes(absent)))
      return app.captureCharFrame()
    },
    async choose(label: string) {
      await until(() => /Objects \d+-\d+ \/ [1-9]/.test(app.captureCharFrame()))
      for (let index = 0; index < 50; index++) {
        await app.renderOnce()
        if (app.captureCharFrame().includes(`Selected: ${label}`)) return
        app.mockInput.pressTab()
        await Bun.sleep(1)
      }
      throw new Error(`Object ${label} was not selectable\n${app.captureCharFrame()}`)
    },
    async enter(value: string) {
      await until(() => app.renderer.currentFocusedEditor instanceof TextareaRenderable)
      const editor = app.renderer.currentFocusedEditor
      if (!(editor instanceof TextareaRenderable)) throw new Error("Expected reference input")
      editor.setText(value)
      app.mockInput.pressEnter()
    },
    async click(text: string) {
      await until(() => app.captureCharFrame().includes(text))
      const lines = app.captureCharFrame().split("\n")
      const y = lines.findIndex((line) => line.includes(text))
      const x = lines.at(y)!.indexOf(text)
      await app.mockMouse.click(x + 1, y)
    },
    async [Symbol.asyncDispose]() {
      gate.resolve()
      app.renderer.destroy()
      await server.stop(true)
      await Promise.all([api.dispose(), library.dispose()])
      db.close()
    },
  }
}

test.each(["escape", "backspace"] as const)("native map returns one level at a time with %s after inspecting a PDF page", async (key) => {
  await using root = await tmpdir()
  await using ui = await mount(root.path)
  expect(await ui.frame("Terminal knowledge map")).toContain("Selected model: current-model")
  await ui.frame("Word Documents")
  await ui.choose("PDFs")
  ui.app.mockInput.pressKey("z")
  await ui.until(() => ui.calls.some((call) => call.category === "pdf") && !ui.app.captureCharFrame().includes("Reading source page"))
  await ui.frame("/ PDFs")
  ui.app.mockInput.pressArrow("left")
  await ui.frame("Selected: References: policy.pdf")
  ui.app.mockInput.pressKey("z")
  await ui.frame("/ Sections")
  await ui.choose("References: policy.pdf")
  ui.app.mockInput.pressEnter()
  await ui.until(() => ui.calls.some((call) => call.path.startsWith("/forge/source/")) && !ui.app.captureCharFrame().includes("Loading the permission-checked original"))
  expect(await ui.frame("PDF policy requires epoch validation.")).toContain("Page 1")
  expect(ui.calls.some((call) => call.path.startsWith("/forge/source/"))).toBe(true)
  ui.app.mockInput.pressKey(key === "escape" ? "\x1b" : "\x7f")
  await ui.frame("/ Sections", "Source inspector")
  ui.app.mockInput.pressKey(key === "escape" ? "\x1b" : "\x7f")
  await ui.frame("/ PDFs", "/ Sections")
  ui.app.mockInput.pressKey(key === "escape" ? "\x1b" : "\x7f")
  await ui.frame("Word Documents", "/ PDFs")
  ui.app.mockInput.pressKey(key === "escape" ? "\x1b" : "\x7f")
  await ui.frame("Forge · overview")
  ui.app.mockInput.pressKey(key === "escape" ? "\x1b" : "\x7f")
  await ui.frame("Chat remains available", "Forge · overview")
  expect(ui.calls.filter((call) => call.method !== "GET")).toEqual([])
})

test("mouse-selected map objects can be closed with Escape or the visible Back control", async () => {
  await using root = await tmpdir()
  await using ui = await mount(root.path)
  await ui.click("PDFs")
  await ui.frame("Selected: PDFs")
  ui.app.mockInput.pressEnter()
  await ui.frame("/ PDFs", "Reading source page")
  await ui.click("References: policy.pdf")
  await ui.frame("Selected: References: policy.pdf")
  ui.app.mockInput.pressEnter()
  await ui.frame("Source inspector")
  ui.app.mockInput.pressEscape()
  await ui.frame("/ PDFs", "Source inspector")
  await ui.click("[Esc / Backspace] Back one level")
  await ui.frame("Word Documents", "/ PDFs")
  expect(ui.calls.filter((call) => call.method !== "GET")).toEqual([])
})

test.each(["escape", "backspace"] as const)("import history returns to its selected collection with %s", async (key) => {
  await using root = await tmpdir()
  await using ui = await mount(root.path, "overview")
  await ui.frame("Available knowledge")
  ui.app.mockInput.pressKey("k")
  await ui.frame("> References")
  ui.app.mockInput.pressKey("j")
  await ui.frame("Import history · References")
  ui.app.mockInput.pressKey(key === "escape" ? "\x1b" : "\x7f")
  await ui.frame("Forge knowledge library", "Import history")
  expect(ui.app.captureCharFrame()).toContain("> References")
  ui.app.mockInput.pressKey(key === "escape" ? "\x1b" : "\x7f")
  await ui.frame("Forge · overview", "Forge knowledge library")
})

test("Backspace edits reference input and confirmation text while Escape cancels one panel", async () => {
  await using root = await tmpdir()
  await using ui = await mount(root.path, "overview", false)
  await ui.frame("Available knowledge")
  ui.app.mockInput.pressKey("t")
  await ui.frame("Add text to workspace knowledge")
  await ui.until(() => ui.app.renderer.currentFocusedEditor instanceof TextareaRenderable)
  const input = ui.app.renderer.currentFocusedEditor
  if (!(input instanceof TextareaRenderable)) throw new Error("Expected reference input")
  input.setText("Reference!")
  input.gotoBufferEnd()
  ui.app.mockInput.pressBackspace()
  await ui.until(() => input.plainText === "Reference")
  ui.app.mockInput.pressEnter()
  await ui.frame("Type ADD to parse locally")
  await ui.until(() => ui.app.renderer.currentFocusedEditor instanceof TextareaRenderable)
  const confirmation = ui.app.renderer.currentFocusedEditor
  if (!(confirmation instanceof TextareaRenderable)) throw new Error("Expected reference confirmation")
  confirmation.setText("ADD")
  confirmation.gotoBufferEnd()
  ui.app.mockInput.pressBackspace()
  await ui.until(() => confirmation.plainText === "AD")
  ui.app.mockInput.pressEscape()
  await ui.frame("Forge knowledge library", "Type ADD")
  ui.app.mockInput.pressBackspace()
  await ui.frame("Forge · overview", "Forge knowledge library")
  expect(ui.calls.some((call) => call.path === "/forge/knowledge" && call.method === "POST")).toBe(false)
})

test("selected and captured model names remain distinct and missing captures never show available sources", async () => {
  await using root = await tmpdir()
  await using ui = await mount(root.path)
  await ui.frame("Selected model: current-model")
  ui.model("next-model")
  await ui.frame("Selected model: next-model", "current-model")
  ui.app.mockInput.pressKey("v")
  await ui.frame("No captured request context available")
  expect(ui.app.captureCharFrame()).not.toContain("policy.pdf")
  expect(ui.app.captureCharFrame()).not.toContain("Word Documents")
})

test("a pending document zoom cannot expose the previous source page as document sections", async () => {
  await using root = await tmpdir()
  await using ui = await mount(root.path)
  await ui.choose("PDFs")
  ui.app.mockInput.pressKey("z")
  await ui.frame("/ PDFs", "Reading source page")
  await ui.choose("References: policy.pdf")
  ui.hold()
  ui.app.mockInput.pressKey("z")
  expect(await ui.frame("Reading source page")).toContain("Objects 0-0 / 0")
  ui.app.mockInput.pressTab()
  ui.app.mockInput.pressEnter()
  await ui.frame("Forge assembles relevant source passages")
  expect(ui.calls.some((call) => call.path.startsWith("/forge/source/"))).toBe(false)
  ui.app.mockInput.pressEscape()
  await ui.frame("/ Sections", "Source inspector")
  ui.app.mockInput.pressEscape()
  ui.release()
  await ui.frame("/ PDFs", "/ Sections")
  expect(await ui.frame("policy.pdf")).not.toContain("Source inspector")
})

test("request map inspects the historical excerpt and recorded model instead of current source content", async () => {
  await using root = await tmpdir()
  await using ui = await mount(root.path, "map", true, true)
  await ui.frame("Latest coding request: historical-model")
  ui.app.mockInput.pressKey("v")
  await ui.frame("Captured model: historical-model")
  await ui.choose("PDFs")
  ui.app.mockInput.pressEnter()
  await ui.choose("References: policy.pdf")
  ui.app.mockInput.pressEnter()
  const frame = await ui.frame("Previously sent PDF excerpt.")
  expect(frame).toContain("Request stage: sent")
  expect(frame).not.toContain("PDF policy requires epoch validation.")
  expect(ui.calls.some((call) => call.path.startsWith("/forge/source/"))).toBe(false)
  ui.app.mockInput.pressBackspace()
  await ui.frame("Captured request context / PDFs", "Source inspector")
  ui.app.mockInput.pressEscape()
  await ui.frame("Captured request context", "/ PDFs")
})

test("changed PDFs remain inspectable as unavailable placeholders without revealing stored excerpts", async () => {
  await using root = await tmpdir()
  await using ui = await mount(root.path)
  await ui.frame("Word Documents")
  await Bun.write(`${root.path}/references/policy.pdf`, "Changed document content.")
  await ui.choose("PDFs")
  ui.app.mockInput.pressKey("z")
  await ui.choose("Unavailable registered source")
  ui.app.mockInput.pressEnter()
  const frame = await ui.frame("withheld-document")
  expect(frame).toContain("unavailable")
  expect(frame).not.toContain("PDF policy requires epoch validation.")
  expect(frame).not.toContain("Changed document content.")
  expect(ui.calls.some((call) => call.path.startsWith("/forge/source/"))).toBe(false)
})

test("overview adds a DOCX from the default directory and automatically parses it without provider approval", async () => {
  await using root = await tmpdir()
  await using ui = await mount(root.path, "overview", false)
  await Bun.write(`${root.path}/references/report.docx`, docx())
  await ui.frame("Available knowledge")
  ui.app.mockInput.pressKey("a")
  await ui.frame("Add file to workspace knowledge")
  await ui.until(() => ui.app.renderer.currentFocusedEditor instanceof TextareaRenderable)
  const input = ui.app.renderer.currentFocusedEditor
  if (!(input instanceof TextareaRenderable)) throw new Error("Expected reference input")
  expect(input.plainText).toBe(`${root.path}/references/`)
  await ui.enter(`${root.path}/references/report.docx`)
  await ui.frame("Type ADD to parse locally")
  await ui.enter("ADD")
  await ui.until(async () => (await ui.api.collections()).some((item) => item.state === "ready"))
  const item = (await ui.api.collections()).find((item) => item.location.endsWith("report.docx"))!
  expect(item).toMatchObject({ approved: true, providers: [], state: "ready" })
  const page = await ui.api.view({ category: "word" })
  expect(page.categories?.word).toBe(1)
  const sections = await ui.api.view({ document: page.sources.at(0)!.id })
  expect(sections.sources.some((source) => source.text.includes("Word policy requires a durable journal."))).toBe(true)
  expect(ui.calls.filter((call) => call.path.startsWith("/forge/knowledge/") && call.method === "PUT").map((call) => call.body?.action)).toEqual(["approve", "index"])
  ui.app.mockInput.pressEscape()
  await ui.frame("Forge · overview")
  ui.app.mockInput.pressKey("m")
  await ui.frame("Word Documents")
})

test("overview creates the default references folder on ADD and parses later files automatically", async () => {
  await using root = await tmpdir()
  await using ui = await mount(root.path, "overview", false)
  await ui.frame("Available knowledge")
  ui.app.mockInput.pressKey("f")
  await ui.frame("Add folder to workspace knowledge")
  await ui.enter(`${root.path}/references`)
  await ui.frame("Type ADD to parse locally")
  await ui.enter("ADD")
  await ui.until(async () => (await ui.api.collections()).some((item) => item.state === "ready"))
  const item = (await ui.api.collections()).at(0)!
  expect(item).toMatchObject({ location: `${root.path}/references`, watch: true, approved: true, providers: [] })
  await Bun.write(`${root.path}/references/later.txt`, "Automatically parsed reference text.")
  await ui.until(async () => (await ui.api.view({ category: "text" })).sources.length === 1)
  ui.app.mockInput.pressEscape()
  await ui.frame("Text Documents: 1")
}, 15000)

test("a narrow terminal keeps category objects reachable with Tab and zoom", async () => {
  await using root = await tmpdir()
  await using ui = await mount(root.path)
  await ui.frame("Terminal knowledge map")
  ui.app.renderer.resize(70, 30)
  await ui.choose("Word Documents")
  ui.app.mockInput.pressKey("z")
  await ui.frame("/ Word Documents", "Reading source page")
  ui.app.mockInput.pressArrow("left")
  await ui.frame("report.docx")
  ui.app.mockInput.pressEscape()
  await ui.frame("Terminal knowledge map", "/ Word Documents")
  expect(ui.calls.filter((call) => call.method !== "GET")).toEqual([])
})
