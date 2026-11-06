import { expect, test } from "@playwright/test"

test("document pins open paginated original passages and failed reads clear stale sections", async ({ page }) => {
  const base = process.env.FORGE_TEST_URL ?? "http://127.0.0.1:4096"
  const parent = { id: "parent", uri: "knowledge:manual/reference.pdf", label: "Reference", kind: "document", method: "collection-document", hash: "version", text: "", status: "current", start: 1, end: 1, observed: 0, inferred: false, evidence: [], detail: { collection: "manual", session: "chat" } }
  const sections = Array.from({ length: 125 }, (_, index) => ({
    ...parent, id: `section-${index}`, label: `Original page ${index + 1}`, hash: `hash-${index}`, method: "collection-section",
    text: `Original passage ${index + 1}`, evidence: ["parent"], detail: { ...parent.detail, page: String(index + 1) },
  }))
  let missing = false
  let policy = { version: "policy", session: "chat", pin: [] as string[], exclude: [] as string[] }
  const writes: string[][] = []
  const requests: string[] = []
  await page.route("**/event?**", (route) => route.fulfill({ status: 200, contentType: "text/event-stream", body: "" }))
  await page.route(/\/forge\/(status|view|requests|policy|knowledge|source\/[^?]+)(?:\?|$)/, (route) => {
    const url = new URL(route.request().url())
    const endpoint = url.pathname.split("/").at(-1)!
    requests.push(`${route.request().method()} ${url.pathname}`)
    if (url.pathname.includes("/source/")) return route.fulfill({ json: endpoint === "parent" ? parent : sections.find((source) => source.id === endpoint) })
    if (endpoint === "policy") {
      if (route.request().method() === "PUT") { policy = route.request().postDataJSON(); writes.push([...policy.pin]) }
      return route.fulfill({ json: policy })
    }
    if (endpoint === "view") {
      const document = url.searchParams.get("document")
      if (document && missing) return route.fulfill({ status: 403, json: { message: "Document is no longer available" } })
      const offset = Number(url.searchParams.get("offset") ?? 0)
      return route.fulfill({ json: { root: "/fixture", generation: "fixture", sources: document ? sections.slice(offset, offset + 120) : [parent], relations: [], page: { offset, limit: 120, ...(document && !offset ? { next: 120 } : {}) }, warnings: [] } })
    }
    return route.fulfill({ json: endpoint === "requests" ? []
      : endpoint === "status" ? { inventory: { root: "/fixture", generation: "fixture", counts: { document: 126 }, files: 1, warnings: [], indexed: true }, session: "chat", job: { state: "idle", message: "Ready" } }
      : { collections: [], provider: "", generation: "fixture", page: { offset: 0, limit: 10 } } })
  })
  await page.goto(`${base}/forge/?directory=/fixture&session=chat`)
  await page.getByRole("button", { name: "Source table", exact: true }).click()
  await page.getByRole("table").getByRole("button").first().click()
  await page.getByRole("button", { name: "Choose section to pin", exact: true }).click()
  await expect(page.getByText("Sections of Reference.", { exact: false })).toBeVisible()
  expect(writes).toEqual([])
  await expect(page.getByRole("table").getByRole("button")).toHaveCount(120)
  await page.getByRole("button", { name: "Next sources", exact: true }).click()
  await expect(page.getByRole("table").getByRole("button")).toHaveCount(5)
  await page.getByRole("table").getByRole("button").first().click()
  await expect(page.getByText("Original passage 121", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Pin for preparation", exact: true }).click()
  await expect(page.getByRole("button", { name: "Unpin evidence", exact: true })).toBeVisible()
  expect(writes).toEqual([["section-120"]])
  missing = true
  await page.getByRole("button", { name: "Search", exact: true }).click()
  await expect(page.getByRole("alert")).toContainText("Document is no longer available")
  await expect(page.getByRole("table").getByRole("button")).toHaveCount(0)
  await expect(page.getByText("Original passage 121", { exact: true })).toHaveCount(0)
  await page.getByRole("button", { name: "Browse all sources", exact: true }).click()
  await expect(page.getByRole("table").getByRole("button")).toHaveCount(1)
  expect(requests.every((request) => request.startsWith("GET ") || request === "PUT /forge/policy")).toBe(true)
})
