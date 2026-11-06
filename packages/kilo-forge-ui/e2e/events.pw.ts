import { expect, test, type Request } from "@playwright/test"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

test("live views receive other-client changes, stay idle, and reconcile after disconnect", async ({ page, context, request }) => {
  const base = process.env.FORGE_TEST_URL ?? "http://127.0.0.1:4096"
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "forge-live-browser-")))
  const authorization = `Basic ${Buffer.from(`kilo:${process.env.FORGE_TEST_PASSWORD ?? "forge-local-validation"}`).toString("base64")}`
  const headers = { Authorization: authorization }
  const query = new URLSearchParams({ directory }).toString()
  const reads: string[] = []
  const pending = new Set<Request>()
  let updated = Date.now()
  page.on("request", (request) => {
    if (request.method() !== "GET" || !/\/forge\/(?:status|view|knowledge|policy|requests)(?:\?|$)/.test(request.url())) return
    reads.push(request.url())
    pending.add(request)
    updated = Date.now()
  })
  const finished = (request: Request) => { if (pending.delete(request)) updated = Date.now() }
  page.on("requestfinished", finished)
  page.on("requestfailed", finished)
  const settled = () => expect.poll(() => pending.size ? 0 : Date.now() - updated, { timeout: 15_000 }).toBeGreaterThan(400)
  const register = (label: string, session = "") => request.post(`${base}/forge/knowledge?${query}`, {
    headers, data: { kind: "text", label, content: `${label} reference material`, location: "", session },
  })
  try {
    await page.goto(`${base}/forge/?${query}#${new URLSearchParams({ authorization })}`)
    await expect(page.getByText("LIVE WORKSPACE UPDATES", { exact: true })).toBeVisible()
    await expect(page.getByText("No registered documents yet.", { exact: false })).toBeVisible()
    expect((await register("Other client document")).ok()).toBe(true)
    await expect(page.getByRole("heading", { name: "Other client document", exact: true })).toBeVisible()
    await settled()
    const idle = reads.length
    await page.waitForTimeout(1300)
    expect(reads).toHaveLength(idle)

    const session = await request.post(`${base}/session?${query}`, { headers })
    const chat = await session.json()
    expect(session.ok()).toBe(true)
    expect((await register("Private session document", chat.id)).ok()).toBe(true)
    await page.waitForTimeout(200)
    await expect(page.getByRole("heading", { name: "Private session document", exact: true })).toHaveCount(0)
    expect(reads).toHaveLength(idle)

    await context.setOffline(true)
    await expect(page.getByText("UPDATES DISCONNECTED · RETRYING", { exact: true })).toBeVisible()
    expect((await register("Document while disconnected")).ok()).toBe(true)
    await context.setOffline(false)
    await expect(page.getByText("LIVE WORKSPACE UPDATES", { exact: true })).toBeVisible()
    await expect(page.getByRole("heading", { name: "Document while disconnected", exact: true })).toBeVisible()
    await expect(page.getByRole("heading", { name: "Private session document", exact: true })).toHaveCount(0)
    await settled()
    const resumed = reads.length
    await page.waitForTimeout(1300)
    expect(reads).toHaveLength(resumed)
    for (let index = 0; index < 12; index++) expect((await register(`Paged document ${index}`)).ok()).toBe(true)
    const library = page.getByRole("region", { name: "Knowledge library" })
    await expect(library.getByRole("navigation", { name: "Collection pages" })).toContainText("14 matching registrations")
    await settled()
    await expect(library.getByRole("button", { name: "Next collections", exact: true })).toBeEnabled()
    const first = await library.locator(".ideas article h3").allTextContents()
    expect(first).toHaveLength(10)
    await library.getByRole("button", { name: "Next collections", exact: true }).click()
    await expect(library.getByRole("navigation", { name: "Collection pages" })).toContainText("Collection page 2")
    const second = await library.locator(".ideas article h3").allTextContents()
    expect(second).toHaveLength(4)
    expect(second.some((label) => first.includes(label))).toBe(false)
    await library.getByRole("button", { name: "Previous collections", exact: true }).click()
    await expect(library.getByRole("navigation", { name: "Collection pages" })).toContainText("Collection page 1")
    const ready = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const done = Promise.withResolvers<void>()
    await page.route((url) => url.pathname === "/forge/knowledge" && url.searchParams.get("query") === "Paged document 11", async (route) => {
      const response = await route.fetch()
      ready.resolve()
      await release.promise
      await route.fulfill({ response })
      done.resolve()
    }, { times: 1 })
    await library.getByLabel("Search collections", { exact: true }).fill("Paged document 11")
    await library.getByRole("button", { name: "Find collections", exact: true }).click()
    await ready.promise
    expect((await register("Unrelated search-race registration")).ok()).toBe(true)
    await expect(library.locator(".ideas article h3")).toHaveText(["Paged document 11"])
    const completed = page.waitForResponse((response) => new URL(response.url()).searchParams.get("query") === "Paged document 11")
    release.resolve()
    await done.promise
    await (await completed).finished()
    await settled()
    await expect(library.locator(".ideas article h3")).toHaveText(["Paged document 11"])
    await expect(library.getByRole("button", { name: "Next collections", exact: true })).toBeDisabled()
    await library.getByLabel("Search collections", { exact: true }).fill("Private session document")
    await library.getByRole("button", { name: "Find collections", exact: true }).click()
    await expect(library.getByText("No matching registrations.", { exact: true })).toBeVisible()
    await library.getByRole("button", { name: "All collections", exact: true }).click()
    await expect(library.locator(".ideas article")).toHaveCount(10)
    await library.getByRole("button", { name: "Next collections", exact: true }).click()
    await expect(library.getByRole("navigation", { name: "Collection pages" })).toContainText("Collection page 2")
    expect((await register("Added while on second page")).ok()).toBe(true)
    await expect(library.getByRole("navigation", { name: "Collection pages" })).toContainText("Collection page 1")
    await expect(library.getByRole("navigation", { name: "Collection pages" })).toContainText("16 matching registrations")
  } finally {
    await context.setOffline(false)
    await page.close()
    await rm(directory, { recursive: true, force: true })
  }
})
