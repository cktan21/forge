import { expect, test } from "@playwright/test"
import type { Core } from "cytoscape"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Collection, Policy, Registry, Source, Status, View } from "@kilocode/forge/schema"

declare global {
  interface HTMLElement { _cyreg?: { cy: Core } }
}

// Fixed before the first run; actual registration, scanning, SQLite and Chrome clicks.
const fixture = {
  "queue.ts": 'import { lease } from "./lease"\nexport function dispatch() { return lease() }\n',
  "lease.ts": 'export function lease() { return "epoch ownership" }\n',
  "README.md": "# Dispatch\n\nRead [queue](queue.ts) before dispatching an epoch lease.\n",
}
const base = process.env.FORGE_TEST_URL!
const authorization = `Basic ${Buffer.from(`kilo:${process.env.FORGE_TEST_PASSWORD}`).toString("base64")}`

test("actual graph clicks navigate originals and preserve workspace/session controls", async ({ page, request }, info) => {
  page.setDefaultTimeout(10_000)
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), "forge-completion-graph-")))
  const directory = path.join(home, "workspace")
  const other = path.join(home, "other")
  const calls: string[] = []
  const errors: string[] = []
  page.on("request", (value) => { if (value.method() !== "GET") calls.push(new URL(value.url()).pathname) })
  page.on("pageerror", (err) => errors.push(err.message))
  async function api<T>(route: string, dir = directory, method = "GET", data?: unknown): Promise<T> {
    const url = new URL(route, base)
    url.searchParams.set("directory", dir)
    const response = await request.fetch(url.href, { method, headers: { authorization }, data })
    expect(response.ok(), `${method} ${route}: ${await response.text()}`).toBe(true)
    return response.json()
  }
  async function open(dir = directory, session = "") {
    await page.goto(`${base}/forge/?${new URLSearchParams({ directory: dir, session })}#${new URLSearchParams({ authorization })}`)
    await expect(page.getByText("LIVE WORKSPACE UPDATES", { exact: true })).toBeVisible()
    await expect(page.getByRole("region", { name: "Inventory status" })).not.toContainText("Saved inventory unknown")
  }
  const graph = page.getByRole("img", { name: /Interactive source graph/ })
  async function bounds() {
    await graph.scrollIntoViewIfNeeded()
    await expect.poll(() => graph.evaluate((node) => {
      if (!(node instanceof HTMLElement) || !node._cyreg) return false
      const cy = node._cyreg.cy
      const rect = node.getBoundingClientRect()
      return cy.nodes().length > 0 && cy.nodes().every((item) => {
        const box = item.renderedBoundingBox()
        return box.x1 >= 0 && box.y1 >= 0 && box.x2 <= rect.width && box.y2 <= rect.height
      })
    })).toBe(true)
    // Renderer coordinates must correspond to a painted canvas before mouse input.
    await graph.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    }))
  }
  async function click(id: string, edge = false) {
    await bounds()
    const point = await graph.evaluate((node, args) => {
      // Read renderer coordinates only; dispatch real mouse input, never synthetic Cytoscape events.
      if (!(node instanceof HTMLElement) || !node._cyreg) throw new Error("Expected Cytoscape renderer")
      const cy = node._cyreg.cy
      const item = cy.getElementById(args.id)
      if (!item.length) throw new Error(`Missing rendered element ${args.id}`)
      const point = args.edge ? item.renderedMidpoint() : item.renderedPosition()
      const rect = node.getBoundingClientRect()
      if (point.x < 0 || point.x >= rect.width || point.y < 0 || point.y >= rect.height) throw new Error("Graph target outside canvas")
      return { x: rect.x + point.x, y: rect.y + point.y, width: innerWidth, height: innerHeight }
    }, { id, edge })
    expect(point.x).toBeGreaterThan(0)
    expect(point.x).toBeLessThan(point.width)
    expect(point.y).toBeGreaterThan(0)
    expect(point.y).toBeLessThan(point.height)
    await page.mouse.click(point.x, point.y)
  }
  try {
    await Promise.all([mkdir(directory), mkdir(other)])
    await Promise.all(Object.entries(fixture).map(([name, text]) => writeFile(path.join(directory, name), text)))
    await writeFile(path.join(other, "foreign.ts"), "export const foreign = true\n")
    await open()
    expect((await api<Status>("/forge/status")).inventory.indexed).toBe(false)
    expect(calls).toEqual([])
    await page.getByRole("button", { name: "\u21bb Index / refresh knowledge", exact: true }).click()
    await expect.poll(async () => (await api<Status>("/forge/status")).job.state).toBe("completed")
    const status = await api<Status>("/forge/status")
    const view = await api<View>("/forge/view")
    expect(view.sources.length).toBeGreaterThan(3)
    expect(view.relations.length).toBeGreaterThan(0)
    const symbol = view.sources.find((item) => item.label === "dispatch" && item.kind === "symbol")!
    expect(symbol).toBeDefined()
    await expect.poll(() => graph.evaluate((node, id) => node instanceof HTMLElement ? node._cyreg?.cy.getElementById(id).length : 0, symbol.id)).toBe(1)
    await click(symbol.id)
    const original = await api<Source>(`/forge/source/${symbol.id}`)
    expect(original.hash).toBe(symbol.hash)
    await expect(page.locator(".inspector h2")).toHaveText(original.label)
    await expect(page.locator(".inspector > pre")).toHaveText(original.text)
    expect(fixture["queue.ts"]).toContain(original.text)
    const supporting = original.evidence.at(0)!
    expect(supporting).toBeTruthy()
    await page.locator(".inspector").getByRole("button", { name: supporting, exact: true }).click()
    const parent = await api<Source>(`/forge/source/${supporting}`)
    await expect(page.locator(".inspector > pre")).toHaveText(parent.text)
    expect(parent.text).toBe(fixture["queue.ts"])
    const navigation = page.waitForResponse((response) => new URL(response.url()).pathname === "/forge/view" && new URL(response.url()).searchParams.get("focus") === parent.id)
    await page.getByRole("button", { name: "Explore current relationships", exact: true }).click()
    expect((await navigation).ok()).toBe(true)
    const edge = await graph.evaluate((node) => {
      if (!(node instanceof HTMLElement) || !node._cyreg) throw new Error("Expected Cytoscape renderer")
      const cy = node._cyreg.cy
      const item = cy.edges().filter((item) => !item.data("membership")).first()
      if (!item.length) throw new Error("Expected an actual repository relationship")
      return { id: item.id(), label: String(item.data("label")), reason: String(item.data("reason")) }
    })
    expect(view.relations.some((item) => item.id === edge.id)).toBe(true)
    await click(edge.id, true)
    await expect(page.locator(".canvas-footer")).toContainText(`${edge.label}: ${edge.reason}`)
    await click("group:code")
    await page.getByRole("button", { name: "Source table", exact: true }).click()
    await expect(page.getByRole("table").locator("tbody tr")).not.toHaveCount(0)
    expect(await page.getByRole("table").locator("tbody tr td:nth-child(2)").allTextContents()).toEqual(expect.arrayContaining(["code"]))
    expect((await page.getByRole("table").locator("tbody tr td:nth-child(2)").allTextContents()).every((kind) => kind === "code")).toBe(true)
    await page.getByRole("table").getByRole("button", { name: `${parent.uri} · ${parent.label}`, exact: true }).click()
    await page.getByRole("button", { name: "Pin for preparation", exact: true }).click()
    await expect(page.getByRole("button", { name: "Unpin evidence", exact: true })).toBeVisible()
    expect((await api<Policy>("/forge/policy")).pin).toContain(parent.id)
    await page.setViewportSize({ width: 390, height: 1100 })
    await page.getByRole("button", { name: "Source map", exact: true }).click()
    await bounds()
    await page.screenshot({ path: info.outputPath("source-map-mobile.png"), fullPage: true })
    await page.setViewportSize({ width: 1512, height: 1100 })
    await click(parent.id)
    await expect(page.locator(".inspector > pre")).toHaveText(parent.text)
    await page.screenshot({ path: info.outputPath("source-map-desktop.png"), fullPage: true })
    const first = await api<{ id: string }>("/session", directory, "POST", { title: "Completion first" })
    const second = await api<{ id: string }>("/session", directory, "POST", { title: "Completion second" })
    const scoped = await api<Collection>("/forge/knowledge", directory, "POST", { kind: "text", label: "Private session evidence", location: "", content: "# Private\nSESSION_ONLY_CANARY", session: first.id, watch: false })
    await api(`/forge/knowledge/${scoped.id}`, directory, "PUT", { action: "approve", session: first.id, providers: [], grants: {} })
    await api(`/forge/knowledge/${scoped.id}`, directory, "PUT", { action: "index", session: first.id })
    await expect.poll(async () => (await api<Registry>(`/forge/knowledge?session=${first.id}`)).collections.find((item) => item.id === scoped.id)?.state).toBe("ready")
    expect((await api<View>(`/forge/view?session=${first.id}`)).sources.some((item) => item.detail.collection === scoped.id)).toBe(true)
    await open(directory, first.id)
    await expect(page.getByRole("heading", { name: "Private session evidence", exact: true })).toBeVisible()
    await page.getByRole("button", { name: "Source table", exact: true }).click()
    await page.getByRole("table").getByRole("button", { name: `${parent.uri} · ${parent.label}`, exact: true }).click()
    await expect(page.getByLabel("Context controls", { exact: false })).toHaveValue(first.id)
    await page.getByRole("button", { name: "Exclude from preparation", exact: true }).click()
    await expect(page.getByRole("button", { name: "Allow in preparation", exact: true })).toBeVisible()
    expect((await api<Policy>(`/forge/policy?session=${first.id}`)).exclude).toContain(parent.id)
    expect((await api<Policy>("/forge/policy")).exclude).not.toContain(parent.id)
    await open(directory, second.id)
    await expect(page.getByRole("heading", { name: "Private session evidence", exact: true })).toHaveCount(0)
    expect((await api<Policy>(`/forge/policy?session=${second.id}`)).exclude).not.toContain(parent.id)
    expect((await api<View>(`/forge/view?session=${second.id}`)).sources.some((item) => item.detail.collection === scoped.id)).toBe(false)
    await open(other)
    await expect(page.getByRole("heading", { name: "Private session evidence", exact: true })).toHaveCount(0)
    expect((await api<Policy>("/forge/policy", other)).pin).toEqual([])
    expect((await api<View>("/forge/view", other)).sources.some((item) => item.id === parent.id)).toBe(false)
    const denied = await request.get(`${base}/forge/source/${parent.id}?${new URLSearchParams({ directory: other })}`, { headers: { authorization } })
    expect(denied.ok()).toBe(false)
    expect((await api<Status>("/forge/status")).inventory.generation).toBe(status.inventory.generation)
    expect(calls.filter((route) => ["/forge/index", "/forge/enhance", "/forge/overview", "/forge/ideas"].includes(route))).toEqual(["/forge/index"])
    expect(errors).toEqual([])
    await info.attach("graph-evidence", { body: JSON.stringify({ fixture, source: original, parent, edge, sessions: [first.id, second.id], calls, generation: status.inventory.generation }, null, 2), contentType: "application/json" })
    await page.screenshot({ path: info.outputPath("workspace-switch.png"), fullPage: true })
  } finally { await rm(home, { recursive: true, force: true }) }
})

test("local knowledge remains usable without any model providers", async ({ page, request }) => {
  test.skip(process.env.FORGE_TEST_OFFLINE !== "1", "Requires an isolated backend with enabled_providers: []")
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "forge-provider-free-")))
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  async function api(route: string, method = "GET", data?: unknown) {
    return request.fetch(`${base}${route}?${new URLSearchParams({ directory })}`, { method, headers: { authorization }, data })
  }
  try {
    const cfg = await api("/config")
    expect(cfg.ok()).toBe(true)
    expect((await cfg.json()).enabled_providers).toEqual([])
    await page.goto(`${base}/forge/?${new URLSearchParams({ directory })}#${new URLSearchParams({ authorization })}`)
    const library = page.getByRole("region", { name: "Knowledge library" })
    await expect(library.getByRole("status")).toContainText("Local registration, indexing and inspection remain available")
    await library.getByLabel("Source type").selectOption("text")
    await library.getByLabel("Label", { exact: true }).fill("Offline recovery")
    await library.getByLabel("Knowledge text").fill("# Recovery\nRestore the original journal before replaying transactions.")
    await library.getByRole("button", { name: "Preview before registering", exact: true }).click()
    await library.getByRole("button", { name: "Register locally", exact: true }).click()
    const card = library.locator("article").filter({ has: page.getByRole("heading", { name: "Offline recovery", exact: true }) })
    await card.getByRole("button", { name: "Approve local indexing", exact: true }).click()
    await expect(card.locator(".pill")).toHaveText("ready")
    await expect(card).toContainText("Sharing grants: Local only")
    await expect(card.getByRole("button", { name: /Allow use with/ })).toHaveCount(0)
    const response = await api("/forge/knowledge")
    expect(response.ok()).toBe(true)
    const registry: Registry = await response.json()
    const item = registry.collections.find((item) => item.label === "Offline recovery")!
    expect(item.approved).toBe(true)
    expect(item.providers).toEqual([])
    expect(registry.provider).toBe("")
    const denied = await api(`/forge/knowledge/${item.id}`, "PUT", { action: "approve", providers: ["unknown"] })
    expect(denied.ok()).toBe(false)
    expect(await denied.text()).toContain("No providers are available")
    await page.getByLabel("Development goal").fill("Recover the journal")
    const failed = page.waitForResponse((response) => new URL(response.url()).pathname === "/forge/enhance")
    await page.getByRole("button", { name: "Prepare task", exact: false }).click()
    expect((await failed).ok()).toBe(false)
    await expect(page.getByRole("alert").filter({ hasText: "No providers are available" })).toBeVisible()
    await expect(page.getByRole("button", { name: "Prepare task", exact: false })).toBeEnabled()
    const refreshed = page.waitForResponse((response) =>
      new URL(response.url()).pathname === `/forge/knowledge/${item.id}` &&
      response.request().method() === "PUT" && response.request().postDataJSON()?.action === "index")
    await card.getByRole("button", { name: "Refresh documents", exact: true }).click()
    const completed = await refreshed
    expect(completed.ok(), await completed.text()).toBe(true)
    expect((await completed.json()).collection.state).toBe("indexing")
    await expect.poll(async () => {
      const response = await api("/forge/knowledge")
      expect(response.ok(), await response.text()).toBe(true)
      const registry: Registry = await response.json()
      const current = registry.collections.find((value) => value.id === item.id)
      return current?.state === "ready" && current.result?.state === "published" &&
        current.result.finished > (item.result?.finished ?? 0)
    }).toBe(true)
    await expect(card.locator(".pill")).toHaveText("ready")
    const view = await api("/forge/view")
    expect(view.ok()).toBe(true)
    const records: View = await view.json()
    const passage = records.sources.find((source) => source.detail.collection === item.id && source.text.includes("original journal"))!
    expect(passage).toBeDefined()
    const original = await api(`/forge/source/${passage.id}`)
    expect(original.ok(), await original.text()).toBe(true)
    expect((await original.json()).text).toContain("Restore the original journal")
    await page.reload()
    await expect(page.getByRole("alert").first()).toHaveText("Open /map in the terminal and press Ctrl+B to authenticate this browser session.")
    await page.goto(`${base}/forge/?${new URLSearchParams({ directory })}#${new URLSearchParams({ authorization })}`)
    await expect(card.locator(".pill")).toHaveText("ready")
    await card.getByRole("button", { name: "Pause", exact: true }).click()
    await expect(card.locator(".pill")).toHaveText("paused")
    page.once("dialog", (dialog) => dialog.accept())
    await card.getByRole("button", { name: "Remove", exact: true }).click()
    await expect(card.locator(".pill")).toHaveText("removed")
    expect(errors).toEqual([])
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test("actual backend rejects loopback URL preview without registering knowledge", async ({ page, request }, info) => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "forge-completion-download-")))
  try {
    await page.goto(`${base}/forge/?${new URLSearchParams({ directory })}#${new URLSearchParams({ authorization })}`)
    const library = page.getByRole("region", { name: "Knowledge library" })
    await library.getByLabel("Source type").selectOption("url")
    await library.getByLabel("Label", { exact: true }).fill("Loopback denial control")
    await library.getByLabel("URL", { exact: true }).fill("http://127.0.0.1/manual.md")
    const pending = page.waitForResponse((response) => new URL(response.url()).pathname === "/forge/knowledge/preview")
    await library.getByRole("button", { name: "Preview before registering", exact: true }).click()
    expect((await pending).ok()).toBe(false)
    await expect(library.getByRole("alert")).toContainText("private, local, or reserved address")
    await expect(library.getByRole("button", { name: "Register locally", exact: true })).toHaveCount(0)
    const response = await request.get(`${base}/forge/knowledge?${new URLSearchParams({ directory })}`, { headers: { authorization } })
    expect(response.ok()).toBe(true)
    const registry: Registry = await response.json()
    expect(registry.collections).toEqual([])
    await info.attach("download-boundary", { body: "Actual packaged downloader rejects loopback before opening a socket. A held successful download requires approved public-origin transport, or a separately identified injected transport fixture.", contentType: "text/plain" })
  } finally { await rm(directory, { recursive: true, force: true }) }
})
