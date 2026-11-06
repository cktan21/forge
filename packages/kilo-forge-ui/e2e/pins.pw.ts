import { expect, test } from "@playwright/test"
import { binding } from "@kilocode/forge/binding"
import { decode, Policy, type Source } from "@kilocode/forge/schema"

for (const mode of ["legacy", "stale"]) test(`${mode} pins require explicit review and reject stale inspected versions`, async ({ page }) => {
  const base = process.env.FORGE_TEST_URL ?? "http://127.0.0.1:4096"
  let source: Source = { id: "passage", uri: "reference.md", label: "Reference", kind: "document", method: "collection-section", hash: "current", text: "Current reviewed passage", status: "current", start: 1, end: 2, observed: 0, inferred: false, evidence: [], detail: { collection: "manual", fileHash: "file" } }
  let policy: Policy = { session: "chat", version: "policy", pin: [source.id], exclude: [], ...(mode === "stale" ? { versions: { [source.id]: binding({ ...source, hash: "old" }) } } : {}) }
  const saved = JSON.stringify(policy)
  const writes: Policy[] = []
  const waiting = Promise.withResolvers<void>()
  const gate = Promise.withResolvers<void>()
  let delayed = false
  await page.route("**/event?**", (route) => route.fulfill({ status: 200, contentType: "text/event-stream", body: "" }))
  await page.route(/\/forge\/(status|view|requests|policy|knowledge|source\/passage)(?:\?|$)/, async (route) => {
    const url = new URL(route.request().url())
    const endpoint = url.pathname.split("/").at(-1)!
    if (endpoint === "passage") return route.fulfill({ json: source })
    if (endpoint === "policy") {
      if (route.request().method() === "PUT") {
        const value = decode(Policy, route.request().postDataJSON())
        writes.push(value)
        if (value.versions?.[source.id] !== binding(source)) return route.fulfill({ status: 400, json: { message: "Source changed since inspection. Reload before pinning." } })
        policy = { ...value, version: "confirmed" }
      }
      if (delayed && url.searchParams.get("session") === "") {
        waiting.resolve()
        await gate.promise
        return route.fulfill({ json: { ...policy, session: "", version: "workspace-late", pin: [], versions: {} } })
      }
      return route.fulfill({ json: policy })
    }
    return route.fulfill({ json: endpoint === "requests" ? []
      : endpoint === "status" ? { inventory: { root: "/fixture", generation: `${source.hash}:${source.detail.fileHash}`, counts: { document: 1 }, files: 1, warnings: [], indexed: true }, session: "chat", job: { state: "idle", message: "Ready" } }
      : endpoint === "view" ? { root: "/fixture", generation: `${source.hash}:${source.detail.fileHash}`, sources: [source], relations: [], page: { offset: 0, limit: 120 }, warnings: [] }
      : { collections: [], provider: "", generation: "fixture", page: { offset: 0, limit: 10 } } })
  })
  await page.goto(`${base}/forge/?directory=/fixture&session=chat`)
  await page.getByRole("button", { name: "Source table", exact: true }).click()
  await page.getByRole("table").getByRole("button").first().click()
  await expect(page.getByText(mode === "legacy" ? "Pinned version is unverified." : "Pinned source version changed.", { exact: false })).toBeVisible()
  expect(writes).toEqual([])
  source = mode === "legacy" ? { ...source, hash: "latest", text: "Latest passage requiring review" } : { ...source, detail: { ...source.detail, fileHash: "updated-document" } }
  await page.getByRole("button", { name: "Confirm current pin version", exact: true }).click()
  await expect(page.getByRole("alert").filter({ hasText: "Source changed since inspection" })).toBeVisible()
  expect(JSON.stringify(policy)).toBe(saved)
  await page.getByRole("button", { name: "Reload view", exact: true }).click()
  await page.getByRole("table").getByRole("button").first().click()
  await expect(page.getByText(source.text, { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Confirm current pin version", exact: true }).click()
  await expect(page.getByText("Pin matches this inspected source version.", { exact: true })).toBeVisible()
  expect(policy.versions?.[source.id]).toBe(binding(source))
  expect(writes).toHaveLength(2)
  delayed = true
  await page.getByLabel(/Context controls/).selectOption("")
  await waiting.promise
  await expect(page.getByRole("button", { name: "Pin for preparation", exact: true })).toBeDisabled()
  await page.getByLabel(/Context controls/).selectOption("chat")
  await expect(page.getByRole("button", { name: "Unpin evidence", exact: true })).toBeEnabled()
  const response = page.waitForResponse((response) => new URL(response.url()).pathname === "/forge/policy" && new URL(response.url()).searchParams.get("session") === "")
  gate.resolve()
  await response
  await expect(page.getByRole("button", { name: "Unpin evidence", exact: true })).toBeEnabled()
})
