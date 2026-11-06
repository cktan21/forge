import { expect, test, type Locator } from "@playwright/test"
import { binding } from "@kilocode/forge/binding"
import { decode, Policy, type Manifest, type Source, usage } from "@kilocode/forge/schema"

for (const refresh of [false, true]) test(`keyboard-only search, table inspection, pinning, and history preserve source versions${refresh ? " across history refresh" : ""}`, async ({ page }) => {
  const base = process.env.FORGE_TEST_URL ?? "http://127.0.0.1:4096"
  const source: Source = {
    id: "passage", uri: "reference.md", label: "Lease reference", kind: "document",
    method: "collection-section", hash: "current-version", text: "Current lease evidence",
    status: "current", start: 1, end: 2, observed: 0, inferred: false, evidence: [],
    detail: { collection: "manual", fileHash: "current-file" },
  }
  const capture: Manifest = {
    id: "coding", root: "/fixture", session: "chat", generation: "historical", purpose: "coding",
    model: "fixture", observed: 1, state: "failed", usage: usage(), coverage: [],
    entries: [{ source: source.id, kind: source.kind, label: source.label, uri: source.uri,
      hash: "historical-version", text: "Historical lease evidence", stage: "sent", tokens: 10 }],
    attempts: [
      { id: "retry-one", sequence: 1, started: 1, finished: 2, state: "response", status: 503, membership: "matched", sent: [source.id] },
      { id: "retry-two", sequence: 2, started: 3, finished: 4, state: "blocked", membership: "unknown", sent: [] },
    ],
  }
  let policy: Policy = { session: "chat", version: "initial", pin: [], exclude: [] }
  const writes: Policy[] = []
  const queries: string[] = []
  let revision = 0
  const unexpected: string[] = []
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url())
    if (url.origin === new URL(base).origin && (url.pathname === "/forge/" || url.pathname.startsWith("/forge/assets/"))) return route.continue()
    unexpected.push(route.request().url())
    return route.abort()
  })
  await page.route("**/event?**", (route) => route.fulfill({ status: 200, contentType: "text/event-stream", body: "" }))
  await page.route(/\/forge\/requests\/coding(?:\?|$)/, (route) => route.fulfill({ json: { request: capture } }))
  await page.route(/\/forge\/(status|view|requests|policy|knowledge|source\/passage)(?:\?|$)/, (route) => {
    const url = new URL(route.request().url())
    const endpoint = url.pathname.split("/").at(-1)
    if (endpoint === "passage") return route.fulfill({ json: source })
    if (endpoint === "view") queries.push(url.searchParams.get("query") ?? "")
    if (endpoint === "policy" && route.request().method() === "PUT") {
      policy = decode(Policy, route.request().postDataJSON())
      writes.push(policy)
    }
    return route.fulfill({ json: endpoint === "requests" ? [{ ...capture, model: `fixture-${++revision}` }]
      : endpoint === "status" ? { inventory: { root: "/fixture", generation: "fixture", counts: { document: 1 }, files: 1, warnings: [], indexed: true }, session: "chat", job: { state: "idle", message: "Ready" } }
      : endpoint === "view" ? { root: "/fixture", generation: "fixture", sources: [source], relations: [], page: { offset: 0, limit: 100 }, warnings: [] }
      : endpoint === "policy" ? policy
      : { collections: [], provider: "", generation: "fixture", page: { offset: 0, limit: 10 } } })
  })
  // Find controls through the real tab order, never programmatic focus or pointer activation.
  async function reach(target: Locator) {
    await expect(target).toBeVisible()
    const visited: string[] = []
    for (let index = 0; index < 80; index++) {
      if (await target.evaluate((element) => element === document.activeElement)) break
      await page.keyboard.press("Tab")
      visited.push(await page.evaluate(() => `${document.activeElement?.tagName}: ${document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.textContent?.slice(0, 100)}`))
    }
    await expect(target, visited.join("\n")).toBeFocused()
  }
  async function activate(target: Locator) {
    await reach(target)
    await page.keyboard.press("Enter")
  }
  await page.goto(`${base}/forge/?directory=/fixture&session=chat`)
  await expect(page.getByRole("img", { name: /Use the source table for keyboard access/ })).toBeVisible()
  await reach(page.getByLabel("Search sources", { exact: true }))
  await page.keyboard.type("lease")
  await page.keyboard.press("Enter")
  await expect.poll(() => queries).toContain("lease")
  await activate(page.getByRole("button", { name: "Source table", exact: true }))
  const row = page.getByRole("table").getByRole("button", { name: "reference.md · Lease reference", exact: true })
  await activate(row)
  const inspector = page.locator(".inspector")
  await expect(inspector).toContainText(source.text)
  await activate(page.getByRole("button", { name: "Pin for preparation", exact: true }))
  await expect(page.getByRole("button", { name: "Unpin evidence", exact: true })).toBeVisible()
  expect(writes.at(-1)).toMatchObject({ session: "chat", pin: [source.id], versions: { [source.id]: binding(source) } })
  await activate(page.getByRole("button", { name: "Unpin evidence", exact: true }))
  await expect.poll(() => policy.pin).toEqual([])
  await reach(page.getByLabel("Context snapshot", { exact: true }))
  await page.keyboard.press("c")
  await page.keyboard.press("Tab")
  await expect(page.locator("#request")).toHaveValue(capture.id)
  await activate(row)
  await expect(inspector).toContainText("Historical lease evidence")
  await expect(inspector).not.toContainText("Current lease evidence")
  await expect(inspector).toContainText("request-capture")
  await activate(page.getByText("Attempt 1: HTTP 503", { exact: false }))
  await expect(page.locator(".request-info")).toContainText("retry-one")
  await expect(page.locator(".request-info")).toContainText("Matched source IDs: passage")
  await activate(page.getByText("Attempt 2:", { exact: false }))
  await expect(page.locator(".request-info")).toContainText("retry-two")
  await expect(page.locator(".request-info")).toContainText("Matched source IDs: None recorded")
  await activate(page.getByRole("button", { name: "Source map", exact: true }))
  await expect(page.getByRole("img", { name: /Use the source table for keyboard access/ })).toBeVisible()
  await activate(page.getByRole("button", { name: "Source table", exact: true }))
  await activate(row)
  await expect(inspector).toContainText("Historical lease evidence")
  if (refresh) {
    const previous = revision
    await activate(page.getByRole("button", { name: "Reload view", exact: true }))
    await expect.poll(() => revision).toBeGreaterThan(previous)
    // Wait for the new manifest to render, not just its HTTP response.
    await expect(page.locator(".request-info")).toContainText(`fixture-${revision}`)
    await expect(page.locator("#request")).toHaveValue(capture.id)
    await expect(inspector).toContainText("Historical lease evidence")
  }
  await reach(page.getByLabel("Context snapshot", { exact: true }))
  await page.keyboard.press("a")
  await page.keyboard.press("Tab")
  await expect(page.locator("#request")).toHaveValue("")
  await activate(row)
  await expect(inspector).toContainText("Current lease evidence")
  await expect(inspector).not.toContainText("Historical lease evidence")
  expect(writes).toHaveLength(2)
  expect(errors).toEqual([])
  expect(unexpected).toEqual([])
})
