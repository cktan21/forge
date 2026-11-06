import { expect, test, type Page } from "@playwright/test"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { usage, type Collection, type Registry, type Status, type View } from "@kilocode/forge/schema"

const base = process.env.FORGE_TEST_URL ?? "http://127.0.0.1:4096"
const authorization = `Basic ${Buffer.from(`kilo:${process.env.FORGE_TEST_PASSWORD ?? "forge-local-validation"}`).toString("base64")}`
const headers = { Authorization: authorization }
let home: string
let directory: string
let query: string
let generation: string

async function inspect(page: Page) {
  // A populated source page need not contain any particular document.
  const row = page
    .getByRole("table")
    .getByRole("button", { name: /Populated manuals: service-\d+\.md$/ })
    .first()
  const label = (await row.innerText()).split(" · ").at(-1) ?? ""
  expect(label).toMatch(/^Populated manuals: service-\d+\.md$/)
  await row.click()
  await expect(page.locator(".inspector").getByRole("heading", { name: label, exact: true })).toBeVisible()
}

test.describe.configure({ mode: "serial", timeout: 120_000 })
test.beforeAll(async ({ request }) => {
  home = await realpath(await mkdtemp(path.join(tmpdir(), "forge-populated-browser-")))
  directory = path.join(home, "workspace")
  await mkdir(directory)
  query = new URLSearchParams({ directory }).toString()
  const folder = path.join(home, "manuals")
  await mkdir(folder)
  for (let index = 0; index < 600; index++) {
    await writeFile(
      path.join(folder, `service-${index}.md`),
      `# Service ${index}\n\nService ${index} owns its retry queue and epoch lease. Expired owners must stop processing before reassignment.\n\n## Verification\n\nCheck owner identity before publishing the result. Preserve the original task on retry.\n`,
    )
  }
  const response = await request.post(`${base}/forge/knowledge?${query}`, {
    headers,
    data: { kind: "folder", label: "Populated manuals", location: folder, watch: false },
  })
  expect(response.ok()).toBe(true)
  const collection: Collection = await response.json()
  for (const action of ["approve", "index"]) {
    expect(
      (
        await request.put(`${base}/forge/knowledge/${collection.id}?${query}`, {
          headers,
          data: { action, providers: [], grants: {} },
        })
      ).ok(),
    ).toBe(true)
  }
  await expect
    .poll(
      async () => {
        const registry: Registry = await (await request.get(`${base}/forge/knowledge?${query}`, { headers })).json()
        return registry.collections.find((item) => item.id === collection.id)?.state
      },
      { timeout: 90_000 },
    )
    .toBe("ready")
  const status: Status = await (await request.get(`${base}/forge/status?${query}`, { headers })).json()
  expect(status.inventory.counts.document).toBeGreaterThan(600)
  expect(status.inventory.indexed).toBe(false)
  generation = status.inventory.generation
})
test.afterAll(async () => {
  if (home) await rm(home, { recursive: true, force: true })
})

test("populated map survives fresh and cached navigation without indexing or model calls", async ({
  browser,
  request,
}, info) => {
  const forbidden: string[] = []
  const errors: string[] = []
  const context = await browser.newContext()
  const page = await context.newPage()
  page.on("request", (call) => {
    if (call.method() !== "GET" && /\/forge\/(?:index|enhance|overview|ideas)(?:\?|$)/.test(call.url()))
      forbidden.push(call.url())
  })
  page.on("pageerror", (err) => errors.push(err.message))
  try {
    let origin = 0
    for (const mode of ["fresh-context", "cached-navigation"]) {
      // Restoring only the auth fragment is a same-document navigation, not a reload.
      await page.goto("about:blank")
      await page.goto(`${base}/forge/?${query}#${new URLSearchParams({ authorization })}`)
      await expect(page.getByRole("heading", { name: "Populated manuals", exact: true })).toBeVisible()
      await expect(page.getByRole("button", { name: "Next sources", exact: true })).toBeEnabled()
      const started = await page.evaluate(() => performance.timeOrigin)
      expect(started).not.toBe(origin)
      origin = started
      await page.screenshot({ path: info.outputPath(`${mode}.png`), fullPage: true })
      await page.getByRole("button", { name: "Source table", exact: true }).click()
      await expect(page.getByRole("table").locator("tbody tr")).toHaveCount(120)
    }
  } finally {
    await context.close()
  }
  const status: Status = await (await request.get(`${base}/forge/status?${query}`, { headers })).json()
  const view: View = await (await request.get(`${base}/forge/view?${query}`, { headers })).json()
  expect(status.inventory.generation).toBe(generation)
  expect(status.inventory.indexed).toBe(false)
  expect(status.job.state).toBe("idle")
  expect(view.sources).toHaveLength(120)
  expect(forbidden).toEqual([])
  expect(errors).toEqual([])
})

for (const endpoint of ["policy", "requests"])
  test(`slow ${endpoint} reads do not block populated source rendering`, async ({ page }) => {
    page.setDefaultTimeout(10_000)
    let held = false
    const release = Promise.withResolvers<void>()
    await page.route(`**/forge/${endpoint}?**`, async (route) => {
      held = true
      await release.promise
      await route.continue()
    })
    try {
      await page.goto(`${base}/forge/?${query}#${new URLSearchParams({ authorization })}`, {
        waitUntil: "domcontentloaded",
      })
      await expect.poll(() => held).toBe(true)
      await expect(page.getByRole("button", { name: "Next sources", exact: true })).toBeEnabled({ timeout: 3000 })
      await page.getByRole("button", { name: "Source table", exact: true }).click()
      await expect(page.getByRole("table").locator("tbody tr")).toHaveCount(120)
      await inspect(page)
      if (endpoint === "policy") {
        await expect(page.getByRole("button", { name: "Choose section to pin", exact: true })).toBeDisabled()
        await expect(page.getByRole("button", { name: "Exclude from preparation", exact: true })).toBeDisabled()
      }
    } finally {
      release.resolve()
      await page.unrouteAll({ behavior: "wait" })
    }
  })

test("failed policy reads leave populated sources inspectable and explain the failure", async ({ page }) => {
  await page.route("**/forge/policy?**", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ message: "Policy store unavailable" }),
    }),
  )
  await page.goto(`${base}/forge/?${query}#${new URLSearchParams({ authorization })}`)
  await expect(page.getByRole("button", { name: "Next sources", exact: true })).toBeEnabled()
  await expect(page.getByRole("alert").filter({ hasText: "Policy store unavailable" })).toBeVisible()
  await page.getByRole("button", { name: "Source table", exact: true }).click()
  await inspect(page)
  await expect(page.getByRole("button", { name: "Choose section to pin", exact: true })).toBeDisabled()
  await expect(page.getByRole("button", { name: "Exclude from preparation", exact: true })).toBeDisabled()
})

for (const delayed of [false, true])
  test(`unavailable selected request never labels library sources as request context (${delayed ? "pending" : "immediate"} inventory)`, async ({
    page,
  }) => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    if (delayed)
      await page.route(
        "**/forge/view?**",
        async (route) => {
          entered.resolve()
          await release.promise
          await route.continue()
        },
        { times: 1 },
      )
    // Inject only request metadata; the populated library still comes from the real backend.
    await page.route("**/forge/status?**", async (route) => {
      const response = await route.fetch()
      const status: Status = await response.json()
      await route.fulfill({
        response,
        json: {
          ...status,
          coding: {
            id: "missing-request",
            session: "",
            purpose: "coding",
            model: "fixture",
            observed: Date.now(),
            state: "sent",
            entries: 1,
            sent: 1,
            usage: usage(),
          },
        },
      })
    })
    await page.route("**/forge/requests?**", (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ message: "Request history unavailable" }),
      }),
    )
    try {
      await page.goto(`${base}/forge/?${query}#${new URLSearchParams({ authorization })}`)
      if (delayed) await entered.promise
      await expect(
        page.getByRole("status").filter({ hasText: "Selected request context is unavailable" }),
      ).toBeVisible()
      await expect(page.getByRole("img", { name: /Interactive source graph/ })).toBeHidden()
      await page.getByRole("button", { name: "Source table", exact: true }).click()
      await expect(page.getByRole("table").locator("tbody tr")).toHaveCount(0)
      await page.getByLabel("Context snapshot").selectOption("")
      await expect(page.getByRole("table").locator("tbody tr")).toHaveCount(120)
    } finally {
      release.resolve()
      await page.unrouteAll({ behavior: "wait" })
    }
  })
