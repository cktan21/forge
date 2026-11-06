import { expect, test, type Page, type Request } from "@playwright/test"
import { decode, Policy, type Source } from "@kilocode/forge/schema"

const base = process.env.FORGE_TEST_URL ?? "http://127.0.0.1:4096"
const directory = process.env.FORGE_TEST_DIRECTORY ?? new URL("../../kilo-forge", import.meta.url).pathname
const password = process.env.FORGE_TEST_PASSWORD ?? "forge-local-validation"

async function inspection(page: Page) {
  const sources: Source[] = ["A", "B", "C"].map((label) => ({
    id: label,
    label,
    uri: `${label}.ts`,
    kind: "code",
    method: "parser",
    status: "current",
    hash: label,
    text: `Original ${label}`,
    start: 1,
    end: 1,
    observed: 0,
    inferred: false,
    evidence: [],
    detail: {},
  }))
  const held: {
    id: string
    request: Request
    release: ReturnType<typeof Promise.withResolvers<void>>
    done: ReturnType<typeof Promise.withResolvers<void>>
    error: boolean
  }[] = []
  const errors: string[] = []
  const unexpected: string[] = []
  page.on("pageerror", (err) => errors.push(err.message))
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname
    if (url.origin !== new URL(base).origin) {
      unexpected.push(url.href)
      return route.abort()
    }
    if (path === "/forge/" || path.startsWith("/forge/assets/")) return route.continue()
    if (path === "/event") return route.fulfill({ contentType: "text/event-stream", body: "" })
    if (
      route.request().method() !== "GET" ||
      url.searchParams.get("directory") !== "/fixture" ||
      url.searchParams.get("session") !== "inspection"
    ) {
      unexpected.push(url.href)
      return route.abort()
    }
    if (path.startsWith("/forge/source/")) {
      const id = decodeURIComponent(path.split("/").at(-1)!)
      const item = {
        id,
        request: route.request(),
        release: Promise.withResolvers<void>(),
        done: Promise.withResolvers<void>(),
        error: false,
      }
      held.push(item)
      await item.release.promise
      try {
        await route.fulfill(
          item.error
            ? { status: 503, json: { message: `Inspection ${id} unavailable` } }
            : { json: sources.find((source) => source.id === id) },
        )
      } finally {
        item.done.resolve()
      }
      return
    }
    if (path === "/forge/status")
      return route.fulfill({
        json: {
          inventory: {
            root: "/fixture",
            generation: "same-page",
            counts: { code: 3 },
            files: 3,
            warnings: [],
            indexed: true,
          },
          session: "inspection",
          job: { state: "idle", message: "Ready" },
        },
      })
    if (path === "/forge/view") {
      const offset = Number(url.searchParams.get("offset") ?? 0)
      return route.fulfill({
        json: {
          root: "/fixture",
          generation: "same-page",
          files: 3,
          warnings: [],
          relations: [],
          sources: sources.slice(offset, offset + 2),
          page: { offset, limit: 2, ...(offset === 0 ? { next: 2 } : {}) },
        },
      })
    }
    if (path === "/forge/requests") return route.fulfill({ json: [] })
    if (path === "/forge/policy")
      return route.fulfill({ json: { version: "fixture", session: "inspection", pin: [], exclude: [] } })
    if (path === "/forge/knowledge")
      return route.fulfill({
        json: { collections: [], provider: "", generation: "fixture", page: { offset: 0, limit: 10 } },
      })
    unexpected.push(url.href)
    return route.abort()
  })
  await page.goto(`${base}/forge/?directory=/fixture&session=inspection`)
  await page.getByRole("button", { name: "Source table", exact: true }).click()
  await expect(page.getByRole("table").getByRole("button")).toHaveCount(2)
  return {
    held,
    errors,
    unexpected,
    async select(id: string) {
      const count = held.length
      await page
        .getByRole("table")
        .getByRole("button", { name: `${id}.ts · ${id}`, exact: true })
        .click()
      await expect.poll(() => held.length).toBe(count + 1)
    },
    async release(index: number, error = false, closed = false) {
      const item = held.at(index)!
      item.error = error
      const response =
        closed || item.request.failure()
          ? undefined
          : page.waitForResponse((response) => new URL(response.url()).pathname === `/forge/source/${item.id}`)
      item.release.resolve()
      await item.done.promise
      if (response) await (await response).finished()
      // Match the existing paging regression: let the delivered response reach Solid.
      await page.waitForTimeout(100)
    },
  }
}

for (const outcome of ["latest-error", "repeat"] as const) {
  test(`same-page inspection keeps the latest selection after ${outcome}`, async ({ page }, info) => {
    const ui = await inspection(page)
    try {
      await ui.select("A")
      const latest = outcome === "repeat" ? "A" : "B"
      await ui.select(latest)
      await ui.release(1, outcome === "latest-error")
      const inspector = page.locator(".inspector")
      if (outcome === "latest-error") await expect(page.getByRole("alert")).toHaveText("Inspection B unavailable")
      else await expect(inspector.getByRole("heading", { name: latest, exact: true })).toBeVisible()
      await ui.release(0, outcome === "repeat")
      await page.screenshot({ path: info.outputPath("inspection.png"), fullPage: true })
      if (outcome === "latest-error") {
        await expect(
          inspector.getByRole("heading", { name: "Understanding you can inspect.", exact: true }),
        ).toBeVisible()
        await expect(page.getByRole("alert")).toHaveText("Inspection B unavailable")
      } else {
        await expect(inspector.getByRole("heading", { name: latest, exact: true })).toBeVisible()
        await expect(inspector.locator("pre")).toHaveText(`Original ${latest}`)
        await expect(page.getByRole("alert")).toHaveCount(0)
      }
      expect(ui.errors).toEqual([])
      expect(ui.unexpected).toEqual([])
    } finally {
      for (const item of ui.held) item.release.resolve()
    }
  })
}

test("authenticates from a transient fragment and exposes a usable source map and table", async ({ page, request }) => {
  const unauthenticated = await request.get(`${base}/forge/graph?directory=${encodeURIComponent(directory)}`)
  expect(unauthenticated.status()).toBe(401)
  const errors: string[] = []
  const calls: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  page.on("request", (request) => {
    if (/\/forge\/(?:enhance|overview|ideas)(?:\?|$)/.test(request.url())) calls.push(request.url())
  })
  const authorization = `Basic ${Buffer.from(`kilo:${password}`).toString("base64")}`
  await page.goto(`${base}/forge/?directory=${encodeURIComponent(directory)}#${new URLSearchParams({ authorization })}`)
  await expect(page.getByRole("heading", { name: "What Forge knows. What it used." })).toBeVisible()
  await expect(page.getByText("No coding request observed for this session.")).toBeVisible()
  expect(new URL(page.url()).hash).toBe("")
  await page.getByRole("button", { name: "Index / refresh knowledge" }).click()
  await page.getByRole("button", { name: "Source table", exact: true }).click()
  await expect(page.getByRole("table")).toBeVisible()
  await expect(page.getByRole("table").getByRole("button").first()).toBeVisible({ timeout: 45_000 })
  await expect(page.getByRole("button", { name: "Next sources", exact: true })).toBeEnabled({ timeout: 45_000 })
  const first = await page.getByRole("table").getByRole("button").first().textContent()
  const ready = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const done = Promise.withResolvers<void>()
  await page.route(
    "**/forge/source/**",
    async (route) => {
      const response = await route.fetch()
      ready.resolve()
      await release.promise
      await route.fulfill({ response })
      done.resolve()
    },
    { times: 1 },
  )
  await page.getByRole("table").getByRole("button").first().click()
  await ready.promise
  const aborted = page.waitForEvent("requestfailed", (request) => request.url().includes("/forge/source/"))
  await page.getByRole("button", { name: "Next sources", exact: true }).click()
  await expect(page.getByRole("navigation", { name: "Source pages" })).toContainText("Source page 2")
  await expect(page.getByRole("table").getByRole("button").first()).not.toHaveText(first!)
  await aborted
  release.resolve()
  await done.promise
  // Allow the delayed inspector response to reach Solid before checking the new page.
  await page.waitForTimeout(100)
  await expect(page.getByRole("button", { name: "Pin for preparation", exact: true })).toHaveCount(0)
  await page.getByRole("button", { name: "Previous sources", exact: true }).click()
  await expect(page.getByRole("navigation", { name: "Source pages" })).toContainText("Source page 1")
  await expect(page.getByRole("table").getByRole("button").first()).toHaveText(first!)
  await page.getByRole("table").getByRole("button").first().click()
  await expect(page.getByRole("button", { name: "Pin for preparation", exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Source map", exact: true }).click()
  const library = page.getByRole("region", { name: "Knowledge library" })
  await library.getByLabel("Source type").selectOption("text")
  const label = `Browser policy ${Date.now()}`
  await library.getByLabel("Label", { exact: true }).fill(label)
  await library
    .getByLabel("Knowledge text")
    .fill(`# Ownership\nQueue ownership requires a browser-verifiable epoch lease.\n${label}`)
  await library.getByRole("button", { name: "Preview before registering", exact: true }).click()
  await expect(library.getByRole("heading", { name: "Ingestion preview", exact: true })).toBeVisible()
  await expect(library.getByText("Discovered inventory: 1 files", { exact: false })).toBeVisible()
  const before = await (
    await request.get(`${base}/forge/knowledge?directory=${encodeURIComponent(directory)}`, {
      headers: { Authorization: authorization },
    })
  ).json()
  expect(before.collections.some((entry: { label: string }) => entry.label === label)).toBe(false)
  await library.getByRole("button", { name: "Cancel preview", exact: true }).click()
  await expect(library.getByRole("button", { name: "Register locally", exact: true })).toHaveCount(0)
  await library.getByRole("button", { name: "Preview before registering", exact: true }).click()
  await library.getByRole("button", { name: "Register locally", exact: true }).click()
  const item = library.getByRole("article").filter({ has: page.getByRole("heading", { name: label }) })
  await expect(item.getByText("Sharing grants: Local only")).toBeVisible()
  await item.getByRole("button", { name: "Approve local indexing", exact: true }).click()
  await expect(item.getByText("ready", { exact: true })).toBeVisible()
  await expect(item.getByText(/Last run published: 1 parsed, 0 reused/)).toBeVisible()
  await item.getByRole("button", { name: "Refresh documents", exact: true }).click()
  await expect(item.getByText(/Last run published: 0 parsed, 1 reused/)).toBeVisible()
  if (process.env.FORGE_TEST_SHARING === "1") {
    const url = `${base}/forge/knowledge?directory=${encodeURIComponent(directory)}`
    const registry = await (await request.get(url, { headers: { Authorization: authorization } })).json()
    expect(registry.destination.fingerprint).toMatch(/^[a-f0-9]{64}$/)
    const collection = registry.collections.find((entry: { label: string }) => entry.label === label)
    const rejected = await request.put(
      `${base}/forge/knowledge/${collection.id}?directory=${encodeURIComponent(directory)}`,
      {
        headers: { Authorization: authorization },
        data: {
          action: "approve",
          providers: [registry.provider],
          grants: { [registry.provider]: "stale-confirmation" },
        },
      },
    )
    expect(rejected.ok()).toBe(false)
    page.once("dialog", async (dialog) => {
      expect(dialog.message()).toContain(registry.destination.fingerprint)
      expect(dialog.message()).toContain("https://forge-validation.invalid")
      await dialog.accept()
    })
    await item.getByRole("button", { name: `Allow use with ${registry.provider}`, exact: true }).click()
    await expect(item.getByRole("button", { name: "Revoke provider sharing", exact: true })).toBeVisible()
    const approved = await (await request.get(url, { headers: { Authorization: authorization } })).json()
    expect(
      approved.collections.find((entry: { label: string }) => entry.label === label).grants[registry.provider],
    ).toBe(registry.destination.fingerprint)
    await item.getByRole("button", { name: "Revoke provider sharing", exact: true }).click()
    await expect(item.getByText("Sharing grants: Local only")).toBeVisible()
    await expect(item.getByText("ready", { exact: true })).toBeVisible()
  }
  await page.getByLabel("Search sources").fill("browser-verifiable epoch lease")
  await page.getByRole("button", { name: "Search", exact: true }).click()
  await expect(page.getByRole("navigation", { name: "Source pages" })).toContainText("Source page 1")
  await expect(page.getByRole("button", { name: "Next sources", exact: true })).toBeDisabled()
  await page.getByRole("button", { name: "Source table", exact: true }).click()
  await page.getByRole("table").getByRole("button").filter({ hasText: label }).first().click()
  await page.getByRole("button", { name: "Pin for preparation", exact: true }).click()
  await expect(page.getByRole("button", { name: "Unpin evidence", exact: true })).toBeVisible()
  const policy = await request.get(`${base}/forge/policy?directory=${encodeURIComponent(directory)}`, {
    headers: { Authorization: authorization },
  })
  const pinned = decode(Policy, await policy.json())
  expect(pinned.pin.length).toBeGreaterThan(0)
  await page.getByRole("button", { name: "Unpin evidence", exact: true }).click()
  page.once("dialog", (dialog) => dialog.accept())
  await item.getByRole("button", { name: "Remove", exact: true }).click()
  await expect(item.getByText("removed", { exact: true })).toBeVisible()
  await expect(page.locator(".inspector")).toContainText("Understanding you can inspect.")
  await expect(page.locator(".inspector pre")).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Pin for preparation", exact: true })).toHaveCount(0)
  const removed = await request.get(
    `${base}/forge/source/${encodeURIComponent(pinned.pin.at(0)!)}?directory=${encodeURIComponent(directory)}`,
    { headers: { Authorization: authorization } },
  )
  expect(removed.ok()).toBe(false)
  await page.screenshot({ path: "/tmp/forge-source-map.png", fullPage: true })
  expect(errors).toEqual([])
  expect(calls).toEqual([])
})
