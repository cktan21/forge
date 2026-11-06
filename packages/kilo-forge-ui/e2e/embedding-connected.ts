import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, mkdir, realpath, rm, readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { chromium, expect, type Browser, type Request } from "@playwright/test"
import { decode, Registry } from "@kilocode/forge/schema"

// Explicit local integration probe: source or native backend, no hosted inference.
const root = path.resolve(import.meta.dir, "../../..")
const binary = process.env.FORGE_EMBEDDING_BINARY
const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), "forge-embedding-browser-")))
const directory = path.join(temporary, "workspace")
await mkdir(directory)
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
      return new Response("Coding calls are not part of this probe", { status: 500 })
    }
    assert.equal(request.headers.get("authorization"), "Bearer local-embedding-key")
    const body: unknown = await request.json()
    assert(body && typeof body === "object" && "input" in body && Array.isArray(body.input))
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
const socket = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
const port = socket.port
await socket.stop(true)
const origin = `http://127.0.0.1:${port}`
const authorization = `Basic ${Buffer.from("kilo:local-browser-fixture").toString("base64")}`
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
      : [process.execPath, "run", "--conditions=node", path.join(root, "packages/opencode/src/index.ts")]),
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
      HOME: temporary,
      XDG_DATA_HOME: path.join(temporary, "data"),
      XDG_CONFIG_HOME: path.join(temporary, "config"),
      XDG_STATE_HOME: path.join(temporary, "state"),
      XDG_CACHE_HOME: path.join(temporary, "cache"),
      KILO_TEST_HOME: temporary,
      KILO_AUTH_CONTENT: "{}",
      KILO_CONFIG_CONTENT: JSON.stringify(config),
      KILO_DISABLE_PROJECT_CONFIG: "1",
      KILO_DISABLE_MODELS_FETCH: "1",
      MODELS_DEV_API_JSON: path.join(root, "packages/opencode/node_modules/.cache/models-dev-api.json"),
      KILO_DISABLE_AUTOUPDATE: "1",
      KILO_TELEMETRY_LEVEL: "off",
      KILO_SERVER_PASSWORD: "local-browser-fixture",
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
    stdout: Bun.file(path.join(temporary, "stdout.log")),
    stderr: Bun.file(path.join(temporary, "stderr.log")),
  },
)
let browser: Browser | undefined
try {
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.FORGE_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  })
  const page = await browser.newPage({ viewport: { width: 1512, height: 1100 } })
  page.setDefaultTimeout(15_000)
  const errors: string[] = []
  page.on("pageerror", (err) => errors.push(err.message))
  const pending = new Set<Request>()
  let updated = Date.now()
  page.on("request", (request) => {
    if (request.method() !== "GET" || !/\/forge\/(?:status|knowledge|policy|requests|view)(?:\?|$)/.test(request.url()))
      return
    pending.add(request)
    updated = Date.now()
  })
  const finished = (request: Request) => {
    if (pending.delete(request)) updated = Date.now()
  }
  page.on("requestfinished", finished)
  page.on("requestfailed", finished)
  const settled = () => expect.poll(() => (pending.size ? 0 : Date.now() - updated)).toBeGreaterThan(400)
  const url = (route: string) => {
    const value = new URL(route, origin)
    value.searchParams.set("directory", directory)
    return value
  }
  await expect
    .poll(
      async () =>
        fetch(`${origin}/global/health`, { headers: { authorization }, signal: AbortSignal.timeout(1000) }).then(
          (response) => response.ok,
          () => false,
        ),
      { timeout: 60_000 },
    )
    .toBe(true)
  const response = await fetch(url("/session"), {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: "{}",
  })
  assert(response.ok)
  const session: unknown = await response.json()
  assert(session && typeof session === "object" && "id" in session && typeof session.id === "string")
  const target = url("/forge/")
  target.searchParams.set("session", session.id)
  target.hash = new URLSearchParams({ authorization }).toString()
  await page.goto(target.href)
  await expect(page.getByText("LIVE WORKSPACE UPDATES", { exact: true })).toBeVisible()
  const assets = binary ? path.join(path.dirname(binary), "forge") : path.join(root, "packages/kilo-forge-ui/dist")
  const scripts = await page
    .locator('script[src*="/assets/"]')
    .evaluateAll((items) => items.map((item) => item.getAttribute("src")))
  assert(scripts.length > 0, "Expected packaged browser scripts")
  const hashes: Record<string, string> = {}
  for (const script of scripts) {
    assert(script)
    const asset = new URL(script, origin)
    assert.equal(asset.origin, origin)
    const relative = asset.pathname.replace(/^\/forge\//, "")
    assert(relative.startsWith("assets/") && !relative.includes(".."))
    const response = await fetch(asset, { headers: { authorization } })
    assert(response.ok)
    const served = Buffer.from(await response.arrayBuffer())
    assert.deepEqual(served, await readFile(path.join(assets, relative)))
    hashes[relative] = createHash("sha256").update(served).digest("hex")
  }
  await settled()
  const library = page.getByRole("region", { name: "Knowledge library", exact: true })
  await library.getByLabel("Source type").selectOption("text")
  await library.getByLabel("Label", { exact: true }).fill("Embedding browser reference")
  const text = "Release ownership only after the signed receipt arrives."
  await library.getByLabel("Knowledge text").fill(text)
  await library.getByRole("button", { name: "Preview before registering", exact: true }).click()
  await library.getByRole("button", { name: "Register locally", exact: true }).click()
  const card = library
    .getByRole("article")
    .filter({ has: page.getByRole("heading", { name: "Embedding browser reference", exact: true }) })
  await card.getByRole("button", { name: "Approve local indexing", exact: true }).click()
  await expect(card.getByText("ready", { exact: true })).toBeVisible()
  await settled()
  assert.equal(inputs.length, 0)
  await card.getByRole("button", { name: "Manage embeddings", exact: true }).click()
  const panel = library.getByRole("article", { name: "Collection embeddings", exact: true })
  await expect(panel).toBeVisible()
  const coverage = panel.getByRole("region", { name: "Embedding coverage", exact: true })
  await coverage.getByRole("button", { name: "Check embedding coverage", exact: true }).click()
  await expect(coverage.getByRole("alert")).toContainText("has not been approved")
  assert.equal(inputs.length, 0)
  await panel.getByRole("button", { name: "Review embedding destination", exact: true }).click()
  await expect(panel).toContainText(`${fixture.url}v1/embeddings`)
  await expect(panel.getByRole("button", { name: "Approve embedding destination", exact: true })).toBeDisabled()
  assert.equal(inputs.length, 0)
  await panel.getByRole("checkbox").check()
  await panel.getByRole("button", { name: "Approve embedding destination", exact: true }).click()
  await expect(panel.locator(":scope > [role=status]")).toContainText("No indexing was started")
  await settled()
  await coverage.getByRole("button", { name: "Check embedding coverage", exact: true }).click()
  await expect(coverage.locator("dd")).toHaveText(["1", "0", "1", "0", "0", "0"])
  assert.equal(inputs.length, 0)
  await panel.getByRole("button", { name: "Review embedding destination", exact: true }).click()
  await panel.getByRole("button", { name: "Index embeddings", exact: true }).click()
  await entered.promise
  const history = panel.getByRole("region", { name: "Embedding job history" })
  await expect(history.getByRole("button", { name: /^Cancel embedding job / })).toBeVisible()
  const cancellation = await history.getByRole("button", { name: /^Cancel embedding job / }).innerText()
  await panel.getByRole("button", { name: "Close embeddings", exact: true }).click()
  await card.getByRole("button", { name: "Manage embeddings", exact: true }).click()
  await expect(history.getByRole("button", { name: cancellation, exact: true })).toBeVisible()
  assert.equal(inputs.length, 1)
  await history.getByRole("button", { name: cancellation, exact: true }).click()
  await closed.promise
  await expect(history).toContainText("cancelled")
  const usage = history.locator('[aria-label="Embedding job usage"]')
  await expect(usage.first()).toContainText("prompt-token subtotal: 0 from 0 reports; 1 attempts unknown")
  held = false
  await settled()
  await panel.getByRole("button", { name: "Review embedding destination", exact: true }).click()
  await panel.getByRole("button", { name: "Index embeddings", exact: true }).click()
  await expect(history).toContainText("1 sections, 1 newly embedded, 0 reused")
  await expect(usage.first()).toContainText("Locally admitted attempts: 1; inputs: 1;")
  await expect(usage.first()).toContainText("prompt-token subtotal: 7 from 1 reports; 0 attempts unknown")
  await expect(usage.first()).toContainText("total-token subtotal: 7 from 1 reports; 0 attempts unknown")
  await expect(usage.first()).toContainText("Monetary cost unknown")
  released.resolve()
  await settled()
  assert.deepEqual(inputs, [[text], [text]])
  await coverage.getByRole("button", { name: "Check embedding coverage", exact: true }).click()
  await expect(coverage.locator("dd")).toHaveText(["1", "1", "0", "0", "0", "0"])
  assert.equal(inputs.length, 2)
  const output = process.env.FORGE_CONNECTED_OUTPUT
  if (output) await panel.screenshot({ path: `${output}-indexed.png` })
  await panel.getByRole("button", { name: "Close embeddings", exact: true }).click()
  await page.reload()
  // Authentication is intentionally removed from the URL. Reopen the terminal handoff on reload.
  await expect(
    page.getByText("Open /map from the terminal to authenticate this browser session.", { exact: false }).first(),
  ).toBeVisible()
  await page.goto(target.href)
  await expect(page.getByText("LIVE WORKSPACE UPDATES", { exact: true })).toBeVisible()
  await expect(card).toBeVisible()
  await settled()
  await card.getByRole("button", { name: "Manage embeddings", exact: true }).click()
  await expect(coverage.locator("dl")).toHaveCount(0)
  await panel.getByRole("button", { name: "Review embedding destination", exact: true }).click()
  await panel.getByRole("button", { name: "Index embeddings", exact: true }).click()
  await expect(history).toContainText("1 sections, 0 newly embedded, 1 reused")
  await expect(usage.first()).toContainText("Locally admitted attempts: 0; inputs: 0; request-body bytes: 0.")
  await expect(usage.first()).toContainText("prompt-token subtotal: 0 from 0 reports; 0 attempts unknown")
  await expect(usage.nth(1)).toContainText("prompt-token subtotal: 7 from 1 reports; 0 attempts unknown")
  await expect(usage.nth(2)).toContainText("prompt-token subtotal: 0 from 0 reports; 1 attempts unknown")
  assert.equal(inputs.length, 2)
  await settled()
  await coverage.getByRole("button", { name: "Check embedding coverage", exact: true }).click()
  await expect(coverage.locator("dd")).toHaveText(["1", "1", "0", "0", "0", "0"])
  const ledger = panel.getByRole("region", { name: "Session embedding usage", exact: true })
  await expect(ledger.getByRole("link")).toHaveCount(0)
  await ledger.getByRole("button", { name: "Inspect latest usage" }).click()
  await expect(ledger).toContainText("2 observed attempts")
  await expect(ledger.locator("dd")).toHaveText(["2 / 2", "258", "1 / 1 / 0", "7 / 1 / 1", "7 / 1 / 1"])
  const downloading = page.waitForEvent("download")
  await ledger.getByRole("link", { name: "Download observed usage JSON" }).click()
  const downloaded = await downloading
  const exported = JSON.parse(await readFile(await downloaded.path(), "utf8"))
  assert.equal(exported.entries.length, 2)
  assert.equal(exported.groups.at(0).usage.promptTokens, 7)
  assert.equal(exported.groups.at(0).unknown.prompt, 1)
  assert.equal(exported.snapshot, false)
  assert.equal(exported.consistency, "revision-checked")
  assert.match(exported.observation.revision, /^[0-9a-f]{32}$/)
  assert.equal(exported.observation.before, "unknown")
  assert.equal(exported.observation.deleted, false)
  assert(exported.observation.since > 0)
  await expect(ledger).toContainText("Pages share one recorded ledger revision")
  await expect(ledger).toContainText("Earlier coverage is unknown")
  assert.equal(exported.cost, null)
  assert.equal(inputs.length, 2)
  if (output) {
    await ledger.screenshot({ path: `${output}-usage.png` })
    await Bun.write(`${output}-usage.json`, JSON.stringify(exported, null, 2))
  }
  await panel.getByRole("button", { name: "Revoke embedding consent", exact: true }).click()
  await expect(panel.locator(":scope > [role=status]")).toContainText("consent revoked")
  await settled()
  await expect(ledger.getByRole("link")).toHaveCount(0)
  await ledger.getByRole("button", { name: "Inspect latest usage" }).click()
  await expect(ledger).toContainText("2 observed attempts")
  await expect(coverage.locator("dl")).toHaveCount(0)
  await coverage.getByRole("button", { name: "Check embedding coverage", exact: true }).click()
  await expect(coverage.getByRole("alert")).toContainText("has not been approved")
  assert.equal(inputs.length, 2)
  await panel.getByRole("button", { name: "Review embedding destination", exact: true }).click()
  await expect(panel).toContainText("Not approved for this destination")
  await expect(panel.getByRole("button", { name: "Index embeddings", exact: true })).toBeDisabled()
  await expect(ledger.getByRole("link")).toHaveCount(0)
  await expect(ledger).toContainText("Knowledge or embedding state changed. Inspect usage again.")
  await ledger.getByRole("button", { name: "Inspect latest usage" }).click()
  await expect(ledger).toContainText("2 observed attempts")
  const registry = decode(
    Registry,
    await fetch(url("/forge/knowledge"), { headers: { authorization } }).then((value) => value.json()),
  )
  assert.equal(registry.collections.at(0)?.session, "")
  assert.deepEqual(registry.collections.at(0)?.providers, [])
  const cutoff = Date.now() + 1000
  const scope = session.id
  async function retain(extra: string[] = []) {
    const child = Bun.spawn(
      [
        ...(binary
          ? [binary]
          : [process.execPath, "run", "--conditions=node", path.join(root, "packages/opencode/src/index.ts")]),
        "forge-usage",
        origin,
        "--directory",
        directory,
        "--session",
        scope,
        "--before",
        String(cutoff),
        "--keep",
        "1",
        ...extra,
      ],
      {
        cwd: directory,
        env: {
          ...process.env,
          HOME: temporary,
          XDG_DATA_HOME: path.join(temporary, "data"),
          XDG_CONFIG_HOME: path.join(temporary, "config"),
          XDG_STATE_HOME: path.join(temporary, "state"),
          XDG_CACHE_HOME: path.join(temporary, "cache"),
          KILO_TEST_HOME: temporary,
          KILO_CONFIG_CONTENT: JSON.stringify(config),
          KILO_AUTH_CONTENT: "{}",
          KILO_DISABLE_PROJECT_CONFIG: "1",
          KILO_DISABLE_MODELS_FETCH: "1",
          KILO_DISABLE_AUTOUPDATE: "1",
          KILO_TELEMETRY_LEVEL: "off",
          KILO_SERVER_PASSWORD: "local-browser-fixture",
          KILO_SERVER_USERNAME: "kilo",
          KILO_NO_DAEMON: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const timer = setTimeout(() => child.kill(), 45000)
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      return { code, stdout, stderr }
    } finally {
      clearTimeout(timer)
      child.kill()
      await child.exited
    }
  }
  const reviewed = await retain()
  assert.equal(reviewed.code, 0, reviewed.stderr)
  const preview = JSON.parse(reviewed.stdout)
  assert.equal(preview.selected, 1)
  assert.equal(preview.more, false)
  assert.match(preview.revision, /^[0-9a-f]{64}$/)
  await expect(ledger).toContainText("2 observed attempts")
  const missing = await retain(["--revision", preview.revision])
  assert.notEqual(missing.code, 0)
  await expect(ledger).toContainText("2 observed attempts")
  const applied = await retain(["--revision", preview.revision, "--confirm", "DELETE"])
  assert.equal(applied.code, 0, applied.stderr)
  assert.deepEqual(JSON.parse(applied.stdout), { directory, session: session.id, deleted: 1, more: false })
  await expect(ledger.getByRole("link")).toHaveCount(0)
  await ledger.getByRole("button", { name: "Inspect latest usage" }).click()
  await expect(ledger).toContainText("1 observed attempts")
  await expect(ledger).toContainText("Recorded history has been deleted")
  await expect(ledger.locator("dd")).toHaveText(["1 / 1", "129", "1 / 0 / 0", "7 / 1 / 0", "7 / 1 / 0"])
  const stale = await retain(["--revision", preview.revision, "--confirm", "DELETE"])
  assert.notEqual(stale.code, 0)
  assert.equal(exported.entries.length, 2)
  assert.equal(inputs.length, 2)
  if (output) {
    await ledger.screenshot({ path: `${output}-retention.png` })
    await Bun.write(
      `${output}-retention.json`,
      JSON.stringify({ preview, applied: JSON.parse(applied.stdout) }, null, 2),
    )
  }
  assert.equal(coding, 0)
  assert.deepEqual(errors, [])
  console.log(
    JSON.stringify({
      result: "pass",
      backend: binary ? "native" : "source",
      binary,
      assets: hashes,
      builtAssets: true,
      sharedCollection: true,
      activeSession: true,
      embeddingRequests: inputs.length,
      exactOriginal: true,
      reused: true,
      closeReopen: true,
      explicitCancellation: true,
      explicitCoverage: true,
      coverageNoEgress: true,
      providerUsage: true,
      cancelledUsageUnknown: true,
      reuseWithoutAttempts: true,
      sessionUsageDownload: true,
      usageNoEgress: true,
      compiledRetention: Boolean(binary),
      retentionInvalidatesObservation: true,
      retentionRequiresConfirmation: true,
      staleRetentionRejected: true,
      codingCalls: coding,
      errors,
    }),
  )
} catch (err) {
  console.error(await Bun.file(path.join(temporary, "stdout.log")).text())
  console.error(await Bun.file(path.join(temporary, "stderr.log")).text())
  throw err
} finally {
  released.resolve()
  await browser?.close()
  proc.kill("SIGTERM")
  const timer = setTimeout(() => proc.kill("SIGKILL"), 8000)
  await proc.exited
  clearTimeout(timer)
  await fixture.stop(true)
  await rm(temporary, { recursive: true, force: true })
}
