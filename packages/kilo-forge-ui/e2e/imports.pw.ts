import { expect, test } from "@playwright/test"

test("import history closes during loading, retries failures, and pages retained runs without stale data", async ({ page }) => {
  const base = process.env.FORGE_TEST_URL ?? "http://127.0.0.1:4096"
  let missing = false
  let legacy = false
  let held = true
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const finished = Promise.withResolvers<void>()
  const methods: string[] = []
  await page.route("**/event?**", (route) => route.fulfill({ status: 200, contentType: "text/event-stream", body: "" }))
  await page.route(/\/forge\/(status|view|requests|policy|knowledge)(?:\?|$)/, (route) => {
    methods.push(route.request().method())
    const endpoint = new URL(route.request().url()).pathname.split("/").at(-1)
    return route.fulfill({ json: endpoint === "requests" ? []
      : endpoint === "status" ? { inventory: { root: "/fixture", generation: "fixture", counts: {}, files: 0, warnings: [], indexed: false }, session: "chat", job: { state: "idle", message: "Ready" } }
      : endpoint === "view" ? { root: "/fixture", generation: "fixture", sources: [], relations: [], page: { offset: 0, limit: 100 }, warnings: [] }
      : endpoint === "policy" ? { version: "fixture", session: "chat", pin: [], exclude: [] }
      : { collections: [{ id: "reference", label: "Reference", location: "/docs", state: "ready", chunks: 1, files: 1, session: "chat", providers: [], warnings: [] }], provider: "", generation: "fixture", page: { offset: 0, limit: 10 } } })
  })
  await page.route("**/forge/knowledge/reference/imports?**", async (route) => {
    methods.push(route.request().method())
    if (held) {
      held = false
      started.resolve()
      await release.promise
      try {
        await route.fulfill({ json: { runs: [], documents: [{ name: "closed-read-canary.md", state: "reused", bytes: 20, chunks: 1 }], page: { offset: 0, limit: 50, total: 1 } } })
      } finally { finished.resolve() }
      return
    }
    if (missing) return route.fulfill({ status: 404, json: { message: "Collection unavailable" } })
    if (legacy) return route.fulfill({ json: { runs: [], documents: [], page: { offset: 0, limit: 50, total: 0 } } })
    const url = new URL(route.request().url())
    const offset = Number(url.searchParams.get("offset") ?? 0)
    const runs = [
      { id: "new", collection: "reference", session: "chat", started: 2, updated: 3, state: "interrupted", stage: "extract", count: 55, withheld: 1 },
      { id: "old", collection: "reference", session: "chat", started: 1, updated: 2, state: "published", stage: "publish", count: 55, withheld: 0 },
    ]
    const selected = runs.find((run) => run.id === url.searchParams.get("run")) ?? runs.at(0)!
    return route.fulfill({ json: { runs, selected, documents: Array.from({ length: 55 }, (_, index) => ({ name: `${selected.id}-${index}.md`, state: selected.id === "old" ? "reused" : "processing", bytes: 20, chunks: 1 })).slice(offset, offset + 50), page: { offset, limit: 50, total: 55, ...(offset === 0 ? { next: 50 } : {}) } } })
  })
  await page.goto(`${base}/forge/?directory=/fixture&session=chat`)
  await page.getByRole("button", { name: "Inspect import history", exact: true }).click()
  const history = page.getByRole("article", { name: "Import history", exact: true })
  try {
    await started.promise
    await expect(history.getByRole("status")).toHaveText("Loading import history...")
    await expect(history.getByRole("button", { name: "Reload import history", exact: true })).toBeDisabled()
    const aborted = page.waitForEvent("requestfailed", { predicate: (request) => request.url().includes("/knowledge/reference/imports?") })
    await history.getByRole("button", { name: "Close import history", exact: true }).click()
    await aborted
    await expect(history).toHaveCount(0)
    await page.getByRole("button", { name: "Inspect import history", exact: true }).click()
    await expect(history).toContainText("new-0.md")
  } finally {
    release.resolve()
    await finished.promise
  }
  await expect(history).not.toContainText("closed-read-canary.md")
  await expect(history).toContainText("Import run interrupted")
  await expect(history).toContainText("new-0.md: unfinished (last observed processing)")
  await history.getByRole("button", { name: "Next import files", exact: true }).click()
  await expect(history).toContainText("new-50.md")
  await expect(history).not.toContainText("new-0.md")
  await history.getByLabel("Import run", { exact: true }).selectOption("old")
  await expect(history).toContainText("Import run published")
  await expect(history).toContainText("old-0.md: reused")
  missing = true
  await history.getByRole("button", { name: "Reload import history", exact: true }).click()
  await expect(history.getByRole("alert")).toContainText("Collection unavailable")
  await expect(history).not.toContainText("old-0.md")
  missing = false
  await history.getByRole("button", { name: "Reload import history", exact: true }).click()
  await expect(history).toContainText("old-0.md: reused")
  await expect(history.getByRole("alert")).toHaveCount(0)
  legacy = true
  await history.getByRole("button", { name: "Reload import history", exact: true }).click()
  await expect(history).toContainText("No retained import history")
  await history.getByRole("button", { name: "Close import history", exact: true }).click()
  await expect(history).toHaveCount(0)
  expect(methods.every((method) => method === "GET")).toBe(true)
})
