import assert from "node:assert/strict"
import { Database } from "bun:sqlite"
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { chromium, expect, type Locator } from "@playwright/test"
import { Collection, Proposal, decode, type ImportHistory, type Manifest, type Registry, type Selection, type Source, type View } from "@kilocode/forge/schema"

// Opt-in real backend/browser probe. Run through the loopback-only verification runner.
const root = path.resolve(import.meta.dir, "../../..")
const binary = path.join(root, "packages/opencode/dist/@kilocode/cli-darwin-arm64/bin/kilo")
const pdf = process.env.FORGE_RESEARCH_PDF
const publication = process.env.FORGE_CONNECTED_PUBLICATION_ONLY === "1"
assert(pdf || publication, "Provide the approved local research PDF path or select publication only")
const digest = (bytes: Uint8Array | ArrayBuffer | string) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
const hash = pdf ? digest(await Bun.file(pdf).arrayBuffer()) : undefined
const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), "forge-connected-")))
const directory = path.join(temporary, "workspace")
const folder = path.join(temporary, "architecture")
await Promise.all([directory, folder].map((dir) => mkdir(dir)))
await Bun.write(path.join(directory, "queue.ts"), "export const queue = []\n")
for (let offset = 0; offset < 600; offset += 20) {
  await Promise.all(Array.from({ length: 20 }, (_, index) => Bun.write(path.join(folder, `lease-${String(offset + index).padStart(3, "0")}.md`),
    `# Architecture ${offset + index}\n\nThe orchid queue validates epoch lease ownership before dispatch.\n`)))
}
const records: Array<{ phase: string; data: unknown }> = []
const record = (phase: string, data: unknown) => {
  records.push({ phase, data })
  console.log(JSON.stringify({ phase, data }))
}
let calls = 0
let included = false
let excerpt = ""
const fixture = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  async fetch(request) {
    assert.equal(new URL(request.url).pathname, "/v1/chat/completions")
    assert(++calls <= 2, "Unexpected completion loop")
    const body: unknown = await request.json()
    assert(body && typeof body === "object" && "messages" in body && Array.isArray(body.messages))
    const messages: readonly unknown[] = body.messages
    included = !!excerpt && messages.some((message) => {
      if (!message || typeof message !== "object" || !("content" in message)) return false
      if (typeof message.content === "string") return message.content.includes(excerpt)
      if (!Array.isArray(message.content)) return false
      const parts: readonly unknown[] = message.content
      return parts.some((part) => !!part && typeof part === "object" && "text" in part && typeof part.text === "string" && part.text.includes(excerpt))
    })
    // Retain no request bodies or extracted PDF text in artifacts.
    const text = JSON.stringify({
      objective: "Review domain scoped parallel exploration using the approved original passage.",
      reuse: [], inspect: ["Read the approved original research passage"], changes: [],
      constraints: ["Do not modify files"], hypotheses: [], questions: [],
      acceptance: ["Explain the selected passage"], verification: [], evidence: [],
    })
    return Response.json({ id: "local-fixed", object: "chat.completion", created: 1, model: "test",
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } })
  },
})
const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
const port = probe.port
await probe.stop(true)
const origin = `http://127.0.0.1:${port}`
const authorization = `Basic ${Buffer.from("kilo:connected-fixture").toString("base64")}`
const config = {
  plugin: [], model: "probe/test", small_model: "probe/test", enabled_providers: ["probe"],
  provider: { probe: { npm: "@ai-sdk/openai-compatible", options: { baseURL: `${fixture.url}v1`, apiKey: "fixture" },
    models: { test: { name: "Local fixed response", limit: { context: 32000, output: 4000 } } } } },
  indexing: { enabled: false }, snapshot: false, formatter: false, lsp: false,
}
const proc = Bun.spawn([binary, "serve", "--hostname", "127.0.0.1", "--port", String(port)], {
  cwd: directory,
  env: { ...process.env, HOME: temporary, XDG_DATA_HOME: path.join(temporary, "data"), XDG_CONFIG_HOME: path.join(temporary, "config"),
    XDG_STATE_HOME: path.join(temporary, "state"), XDG_CACHE_HOME: path.join(temporary, "cache"), KILO_TEST_HOME: temporary,
    KILO_AUTH_CONTENT: "{}", KILO_CONFIG_CONTENT: JSON.stringify(config), KILO_DISABLE_PROJECT_CONFIG: "1",
    KILO_DISABLE_MODELS_FETCH: "1", KILO_DISABLE_AUTOUPDATE: "1", KILO_TELEMETRY_LEVEL: "off", KILO_SERVER_PASSWORD: "connected-fixture" },
  stdout: Bun.file(path.join(temporary, "backend.stdout.log")), stderr: Bun.file(path.join(temporary, "backend.stderr.log")),
})
async function read<T>(route: string): Promise<T> {
  const url = new URL(route, origin)
  url.searchParams.set("directory", directory)
  const response = await fetch(url, { headers: { authorization }, signal: AbortSignal.timeout(10_000) })
  assert(response.ok, `${route}: ${response.status}`)
  return response.json() as Promise<T>
}
async function until<T>(fn: () => Promise<T | undefined>, label: string, interval = 25) {
  const end = performance.now() + 30_000
  while (performance.now() < end) {
    const value = await fn()
    if (value !== undefined) return value
    await Bun.sleep(interval)
  }
  throw new Error(label)
}
const browser = await chromium.launch({ headless: true, executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" })
const page = await browser.newPage({ viewport: { width: 1512, height: 1100 } })
page.setDefaultTimeout(15_000)
const errors: string[] = []
page.on("pageerror", (error) => errors.push(error.message))
let db: Database | undefined
const library = page.getByRole("region", { name: "Knowledge library" })
async function register(kind: string, label: string, location: string) {
  await library.getByLabel("Source type").selectOption(kind)
  await library.getByLabel("Label", { exact: true }).fill(label)
  await library.getByLabel("Path", { exact: true }).fill(location)
  if (kind === "folder") await library.getByLabel("Watch for changes").uncheck()
  await library.getByRole("button", { name: "Preview before registering", exact: true }).click()
  await expect(library.getByRole("heading", { name: "Ingestion preview", exact: true })).toBeVisible()
  await library.getByRole("button", { name: "Register locally", exact: true }).click()
  const card = library.getByRole("article").filter({ has: page.getByRole("heading", { name: label, exact: true }) })
  await expect(card).toBeVisible()
  const registry = await read<Registry>("/forge/knowledge")
  const item = registry.collections.find((item) => item.label === label)
  assert(item)
  return { card, item }
}
async function shot(card: Locator, name: string) {
  const output = process.env.FORGE_CONNECTED_OUTPUT
  if (output) await card.screenshot({ path: `${output}-${name}.png` })
}
try {
  await until(async () => fetch(`${origin}/global/health`, { signal: AbortSignal.timeout(1000) }).then(() => true, () => undefined), "Backend did not listen")
  const url = new URL("/forge/", origin)
  url.searchParams.set("directory", directory)
  url.hash = new URLSearchParams({ authorization }).toString()
  await page.goto(url.href)
  await expect(page.getByText("LIVE WORKSPACE UPDATES", { exact: true })).toBeVisible()
  const html = await fetch(`${origin}/forge/`, { headers: { authorization } }).then((response) => response.text())
  const script = html.match(/src="([^"]+\.js)"/)?.at(1)
  assert(script)
  const bundle = await fetch(new URL(script, origin), { headers: { authorization } }).then((response) => response.arrayBuffer())
  record("identity", { binary, binaryHash: digest(await Bun.file(binary).arrayBuffer()), pid: proc.pid, origin,
    asset: script, assetHash: digest(bundle), pdf: pdf ? { hash, bytes: Bun.file(pdf).size } : undefined, publication, fixture: fixture.url.origin })

  const held = await register("folder", "Held architecture publication", folder)
  const files = await Array.fromAsync(new Bun.Glob("**/kilo*.db").scan({ cwd: path.join(temporary, "data"), absolute: true }))
  assert.equal(files.length, 1, "Expected one isolated host database")
  const file = files.at(0)
  assert(file)
  db = new Database(file, { create: false, readwrite: true })
  db.run("PRAGMA busy_timeout=0")
  const connection = db
  // Compete only after the durable publish-stage checkpoint; never change worker/store code.
  const locking = until(async () => {
    const row = connection.query<{ body: string }, [string]>("SELECT body FROM forge_records WHERE kind='collection' AND id=?").get(held.item.id)
    const item = row ? decode(Collection, JSON.parse(row.body)) : undefined
    assert(item?.state !== "ready", "Missed publication lock window; this is not held-publication evidence")
    if (item?.progress?.stage !== "publish") return undefined
    connection.run("BEGIN IMMEDIATE")
    return item.progress
  }, "Publication checkpoint was not observed", 1)
  await held.card.getByRole("button", { name: "Approve local indexing", exact: true }).click()
  const checkpoint = await locking
  await expect(held.card).toContainText("Publishing documents")
  await expect(held.card).toContainText("(1s)", { timeout: 5000 })
  const first = await held.card.innerText()
  const live = (await read<Registry>("/forge/knowledge")).collections.find((item) => item.id === held.item.id)!
  await shot(held.card, "heartbeat-one")
  await expect(held.card).toContainText("(2s)", { timeout: 5000 })
  const second = await held.card.innerText()
  const next = (await read<Registry>("/forge/knowledge")).collections.find((item) => item.id === held.item.id)!
  assert.notEqual(first, second)
  assert(next.progress!.updated > live.progress!.updated)
  assert.equal(connection.query<{ count: number }, []>("SELECT count(*) AS count FROM forge_sources").get()!.count, 0)
  await shot(held.card, "heartbeat")
  await held.card.getByRole("button", { name: "Pause", exact: true }).click()
  await expect(held.card).toContainText("cancellation pending", { timeout: 5000 })
  await shot(held.card, "pending")
  record("held-publication", { documents: 600, checkpoint, first: live.progress, second: next.progress,
    pending: await held.card.innerText(), sourcesWhileHeld: 0, calls })
  connection.run("COMMIT")
  await expect(held.card.getByText("paused", { exact: true })).toBeVisible()
  const imports = await read<ImportHistory>(`/forge/knowledge/${held.item.id}/imports`)
  assert.equal(imports.selected?.state, "cancelled")
  page.once("dialog", (dialog) => dialog.accept())
  await held.card.getByRole("button", { name: "Purge stored content", exact: true }).click()
  await expect(held.card).toHaveCount(0)
  assert.equal(connection.query<{ count: number }, []>("SELECT count(*) AS count FROM forge_sources").get()!.count, 0)
  record("released-purged", { state: imports.selected?.state, registrations: (await read<Registry>("/forge/knowledge")).collections.length, calls })

  if (!publication) {
  assert(pdf)
  const research = await register("file", "Research PDF", pdf)
  await research.card.getByRole("button", { name: "Approve local indexing", exact: true }).click()
  await expect(research.card.getByText("ready", { exact: true })).toBeVisible({ timeout: 30_000 })
  assert.equal(calls, 0)
  const denied = await read<Selection>("/forge/search?q=exploration")
  assert(!denied.matches.some((match) => match.source.detail.collection === research.item.id), "Local indexing alone granted provider use")
  const registry = await read<Registry>("/forge/knowledge")
  assert.deepEqual(registry.destination?.origins, [fixture.url.origin])
  page.once("dialog", (dialog) => dialog.accept())
  await research.card.getByRole("button", { name: "Allow use with probe", exact: true }).click()
  await expect(research.card.getByRole("button", { name: "Revoke provider sharing", exact: true })).toBeVisible()
  await expect(research.card.getByText("ready", { exact: true })).toBeVisible()
  const ranked = await read<Selection>("/forge/search?q=domain%20scoped%20parallel%20exploration")
  assert(ranked.matches.some((match) => match.source.detail.collection === research.item.id))
  assert(ranked.tokens <= ranked.budget)
  const query = "exploration"
  await page.getByLabel("Search sources", { exact: true }).fill(query)
  await page.getByRole("button", { name: "Search", exact: true }).click()
  await page.getByRole("button", { name: "Source table", exact: true }).click()
  const view = await read<View>(`/forge/view?query=${encodeURIComponent(query)}`)
  const source = view.sources.find((source) => source.method === "collection-section" && source.detail.collection === research.item.id)
  assert(source)
  // Multiple original sections on one PDF page share a label; view ordering identifies the first.
  await page.getByRole("table").getByRole("button", { name: `${source.uri} · ${source.label}`, exact: true }).first().click()
  const original = await read<Source>(`/forge/source/${source.id}`)
  assert.equal(original.detail.fileHash, hash)
  assert(Number(original.detail.page) > 0)
  await expect.poll(async () => (await page.locator(".inspector").innerText()).includes(original.text)).toBe(true)
  await page.getByRole("button", { name: "Pin for preparation", exact: true }).click()
  await expect(page.getByRole("button", { name: "Unpin evidence", exact: true })).toBeVisible()
  excerpt = original.text
  await page.getByLabel("Development goal", { exact: true }).fill("Explain domain scoped parallel exploration from the approved research passage. Do not modify files.")
  const response = page.waitForResponse((response) => new URL(response.url()).pathname === "/forge/enhance")
  await page.getByRole("button", { name: "Prepare task", exact: false }).click()
  const result = await response
  assert(result.ok(), "Local preparation failed")
  const proposal = decode(Proposal, await result.json())
  await expect(page.locator(".proposal")).toContainText("PREPARED TASK")
  const match = proposal.context.matches.find((match) => match.source.id === original.id)
  assert(match)
  assert.equal(match.source.hash, original.hash)
  assert(match.source.text === original.text, "Prepared excerpt differs from inspected original")
  assert(proposal.context.text.includes(original.id))
  assert(proposal.context.text.includes(`page ${original.detail.page}`))
  assert(proposal.context.tokens <= proposal.context.budget)
  const capture = (await read<Manifest[]>("/forge/requests?purpose=enhance")).find((item) => item.id === proposal.id)
  assert.equal(capture?.state, "completed")
  assert.equal(capture.entries.find((entry) => entry.source === original.id)?.stage, "sent")
  assert.equal(calls, 1)
  assert(included, "Fixed endpoint did not receive the selected original passage")
  assert.deepEqual(errors, [])
  record("pdf-prepared", { query, collection: research.item.id, source: original.id, hash: original.hash,
    fileHash: hash, page: original.detail.page, start: original.start, end: original.end, method: original.method,
    rankedQuery: "domain scoped parallel exploration", rankedMatches: ranked.matches.length,
    matches: proposal.context.matches.length, tokens: proposal.context.tokens, budget: proposal.context.budget, request: proposal.id,
    state: capture.state, originalMatched: true, fixtureReceived: included, calls, codingCalls: 0 })
  assert.equal(digest(await Bun.file(pdf).arrayBuffer()), hash)
  }
} catch (err) {
  record("failure", { error: String(err), calls })
  throw err
} finally {
  if (db?.inTransaction) db.run("ROLLBACK")
  db?.close()
  await browser.close()
  proc.kill("SIGTERM")
  const timer = setTimeout(() => proc.kill("SIGKILL"), 8000)
  const code = await proc.exited
  clearTimeout(timer)
  await fixture.stop(true)
  const stopped = await fetch(`${origin}/global/health`, { signal: AbortSignal.timeout(1000) }).then(() => false, () => true)
  record("cleanup", { code, stopped, calls })
  const output = process.env.FORGE_CONNECTED_OUTPUT
  if (output) await Bun.write(`${output}.json`, JSON.stringify({ records }, null, 2))
  await rm(temporary, { recursive: true, force: true })
  assert(stopped)
}
