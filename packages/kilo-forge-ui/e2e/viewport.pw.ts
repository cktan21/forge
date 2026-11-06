import { expect, test, type Page } from "@playwright/test"
import type { Core } from "cytoscape"
import type { Source } from "@kilocode/forge/schema"

declare global {
  interface HTMLElement { _cyreg?: { cy: Core } }
}

const base = process.env.FORGE_TEST_URL ?? "http://127.0.0.1:4173"
const sources: Source[] = (["code", "document", "symbol", "configuration"] as const).flatMap((kind) =>
  Array.from({ length: 6 }, (_, index) => ({
    id: `${kind}-${index}`, kind, label: `${kind} ${index}`,
    uri: `${kind}/${index}.txt`, text: `Original ${kind} ${index}`, hash: `${kind}-${index}`,
    start: 1, end: 1, observed: 0, method: "file", status: "current" as const,
    inferred: false, evidence: [], detail: {},
  })))

async function open(page: Page, hidden: boolean) {
  const gate = Promise.withResolvers<void>()
  const errors: string[] = []
  const unexpected: string[] = []
  page.on("pageerror", (err) => errors.push(err.message))
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url())
    if (url.origin !== base || route.request().method() !== "GET") {
      unexpected.push(url.href)
      return route.abort()
    }
    if (url.pathname === "/forge/" || url.pathname.startsWith("/forge/assets/")) return route.continue()
    if (url.pathname === "/event") return route.fulfill({ contentType: "text/event-stream", body: "" })
    if (url.pathname === "/forge/status") return route.fulfill({ json: {
      inventory: { root: "/fixture", generation: "viewport", counts: { code: 6, document: 6, symbol: 6, configuration: 6 }, files: 24, warnings: [], indexed: true },
      session: "", job: { state: "idle", message: "Ready" },
    } })
    if (url.pathname === "/forge/view") {
      await gate.promise
      return route.fulfill({ json: { root: "/fixture", generation: "viewport", files: 24, warnings: [],
        sources, relations: [{ id: "relation", from: "code-0", to: "document-0", kind: "documents", reason: "Fixture relation", inferred: false }],
        page: { offset: 0, limit: 120 },
      } })
    }
    if (url.pathname === "/forge/requests") return route.fulfill({ json: [] })
    if (url.pathname === "/forge/policy") return route.fulfill({ json: { version: "viewport", session: "", pin: [], exclude: [] } })
    if (url.pathname === "/forge/knowledge") return route.fulfill({ json: { collections: [], provider: "", generation: "viewport", page: { offset: 0, limit: 10 } } })
    if (url.pathname.startsWith("/forge/source/")) return route.fulfill({ json: sources.find((source) => source.id === url.pathname.split("/").at(-1)) })
    unexpected.push(url.href)
    return route.abort()
  })
  await page.goto(`${base}/forge/?directory=/fixture`)
  if (hidden) await page.getByRole("button", { name: "Source table", exact: true }).click()
  gate.resolve()
  await expect(page.locator(".sidebar .category").first()).toContainText("24")
  if (hidden) await page.getByRole("button", { name: "Source map", exact: true }).click()
  return { errors, unexpected }
}

async function bounds(page: Page) {
  const graph = page.locator(".graph")
  await graph.scrollIntoViewIfNeeded()
  await expect.poll(() => graph.evaluate((node) => {
    const cy = node instanceof HTMLElement ? node._cyreg?.cy : undefined
    if (!cy || cy.nodes().length < 2) return false
    const rect = node.getBoundingClientRect()
    return cy.nodes().every((item) => {
      const box = item.renderedBoundingBox()
      return box.x1 >= 0 && box.y1 >= 0 && box.x2 <= rect.width && box.y2 <= rect.height
    })
  })).toBe(true)
}

for (const width of [1512, 1024, 390]) {
  for (const hidden of [false, true]) {
    test(`graph fits automatically at ${width}px after ${hidden ? "hidden" : "visible"} arrival`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 1100 })
      const result = await open(page, hidden)
      await bounds(page)
      await page.locator(".sidebar .category").filter({ hasText: /^code/ }).click()
      await expect.poll(() => page.locator(".graph").evaluate((node) =>
        node instanceof HTMLElement ? node._cyreg?.cy.getElementById("code-5").length : 0)).toBe(1)
      await bounds(page)
      const graph = page.locator(".graph")
      await graph.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
      const point = await graph.evaluate((node) => {
        if (!(node instanceof HTMLElement) || !node._cyreg) throw new Error("Expected graph renderer")
        const cy = node._cyreg.cy
        const position = cy.getElementById("code-0").renderedPosition()
        const rect = node.getBoundingClientRect()
        return { x: rect.x + position.x, y: rect.y + position.y, width: innerWidth, height: innerHeight }
      })
      await page.screenshot({ path: info.outputPath("before-click.png"), fullPage: true })
      expect(point.x).toBeGreaterThan(0)
      expect(point.x).toBeLessThan(point.width)
      expect(point.y).toBeGreaterThan(0)
      expect(point.y).toBeLessThan(point.height)
      await page.mouse.click(point.x, point.y)
      await expect(page.locator(".inspector > pre")).toHaveText("Original code 0")
      await page.locator(".sidebar .category").first().click()
      await bounds(page)
      await page.setViewportSize({ width: width === 390 ? 1512 : 390, height: 1100 })
      await bounds(page)
      await page.screenshot({ path: info.outputPath("automatic-fit.png"), fullPage: true })
      expect(result.errors).toEqual([])
      expect(result.unexpected).toEqual([])
    })
  }
}

test("same-geometry reload preserves a manually navigated viewport and close disposes it", async ({ page }) => {
  const result = await open(page, false)
  await bounds(page)
  const graph = page.locator(".graph")
  const rect = await graph.boundingBox()
  expect(rect).not.toBeNull()
  await page.mouse.move(rect!.x + rect!.width / 2, rect!.y + rect!.height / 2)
  await page.mouse.wheel(0, -120)
  await graph.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  const before = await graph.evaluate((node) => {
    if (!(node instanceof HTMLElement) || !node._cyreg) throw new Error("Expected graph renderer")
    const cy = node._cyreg.cy
    return { zoom: cy.zoom(), pan: cy.pan() }
  })
  await page.getByRole("button", { name: "Reload view", exact: true }).click()
  await expect(page.getByRole("region", { name: "Inventory status" })).not.toContainText("Refreshing")
  const response = page.waitForResponse((value) => new URL(value.url()).pathname === "/forge/view")
  await page.getByRole("button", { name: "Search", exact: true }).click()
  await response
  await graph.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  const after = await graph.evaluate((node) => {
    if (!(node instanceof HTMLElement) || !node._cyreg) throw new Error("Expected graph renderer")
    const cy = node._cyreg.cy
    return { zoom: cy.zoom(), pan: cy.pan() }
  })
  expect(after).toEqual(before)
  await page.getByRole("button", { name: "Close inspection", exact: true }).click()
  await page.setViewportSize({ width: 1024, height: 800 })
  await expect(page.getByRole("status")).toContainText("Knowledge inspection closed")
  expect(result.errors).toEqual([])
  expect(result.unexpected).toEqual([])
})
