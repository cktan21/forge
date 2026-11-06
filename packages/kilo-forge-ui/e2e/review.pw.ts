import { expect, test } from "@playwright/test"
import type { Proposal, Source } from "@kilocode/forge/schema"

test("browser compares consecutive proposals and preserves review after a failed clarification", async ({ page }) => {
  const base = process.env.FORGE_TEST_URL ?? "http://127.0.0.1:4096"
  const calls: Array<{ text: string; answers: string }> = []
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  const source = (id: string, hash: string): Source => ({
    id, hash, text: "Current fixture evidence", kind: "document", label: id, uri: `knowledge:${id}`,
    start: 1, end: 1, method: "fixture", status: "current", inferred: false, evidence: [], detail: {}, observed: 0,
  })
  await page.route("**/event?**", (route) => route.fulfill({ status: 200, contentType: "text/event-stream", body: "" }))
  await page.route(/\/forge\/(status|view|requests|policy|knowledge|enhance)(?:\?|$)/, async (route) => {
    const endpoint = new URL(route.request().url()).pathname.split("/").at(-1)
    if (endpoint === "enhance") {
      calls.push(route.request().postDataJSON())
      if (calls.length === 3) return route.fulfill({ status: 409, json: { message: "Fixture reapproval required" } })
      const revised = calls.length > 1
      const proposal: Proposal = {
        id: revised ? "26996be9-bc68-4dfa-bf80-0de3ff999413" : "26996be9-bc68-4dfa-bf80-0de3ff999412",
        original: calls.at(-1)!.text, generation: "fixture", session: "chat", status: "ready",
        task: { objective: "Inspect only", reuse: [], inspect: [], changes: [], constraints: [], questions: [], hypotheses: [], acceptance: [], verification: [], evidence: [] },
        prompt: `Original request: ${calls.at(-1)!.text}\nClarifications: ${calls.at(-1)!.answers}`,
        context: {
          matches: (revised ? [source("stable", "new"), source("added", "version")] : [source("stable", "old"), source("removed", "version")]).map((source) => ({ source, score: 1, reason: "Keyword" })),
          text: "Current fixture evidence", tokens: revised ? 30 : 20, budget: 1000, estimator: "fixture",
          omitted: revised ? ["removed"] : [], reasons: { removed: "Excluded by developer" }, policy: revised ? "policy-new" : "policy-old",
          provider: "fixture-provider", destination: "routing-fingerprint",
        },
        usage: { input: 10, output: 5, cached: 0, milliseconds: 1, model: "fixture", measured: false },
        warnings: ["Review warning fixture"],
      }
      return route.fulfill({ json: proposal })
    }
    return route.fulfill({ json: endpoint === "requests" ? []
      : endpoint === "status" ? { inventory: { root: "/fixture", generation: "fixture", counts: {}, files: 0, warnings: [], indexed: false }, session: "chat", job: { state: "idle", message: "Ready" } }
      : endpoint === "view" ? { root: "/fixture", generation: "fixture", sources: [], relations: [], page: { offset: 0, limit: 100 }, warnings: [] }
      : endpoint === "policy" ? { version: "fixture", session: "chat", pin: [], exclude: [] }
      : { collections: [], provider: "", generation: "fixture", page: { offset: 0, limit: 10 } } })
  })
  await page.goto(`${base}/forge/?directory=/fixture&session=chat`)
  await page.getByLabel("Development goal").fill("Keep the API unchanged.")
  await page.getByRole("button", { name: "Prepare task →", exact: true }).click()
  const review = page.locator(".proposal")
  await expect(review).toContainText("No previous selection in this review.")
  await expect(review).toContainText("Prepared provider: fixture-provider")
  await expect(review).toContainText("Routing fingerprint: routing-fingerprint")
  await expect(review).toContainText("Review warning fixture")
  await review.getByText("Inspect supporting evidence", { exact: true }).click()
  await expect(review).toContainText("Selected version: stable @ old")
  await review.getByLabel("Clarification").fill("Use epoch leases.")
  await review.getByRole("button", { name: "Clarify and prepare again" }).click()
  await expect(review).toContainText("1 added, 1 removed, 1 versions changed, 0 unchanged")
  await expect(review).toContainText("Removed removed: Excluded by developer")
  await expect(review).toContainText("Version changed stable: old -> new")
  await expect(review).toContainText("policy: policy-old -> policy-new")
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(base).origin })
  await review.getByRole("button", { name: "Copy task and evidence" }).click()
  const copied = await page.evaluate(() => navigator.clipboard.readText())
  expect(copied).toContain('<forge-preparation request="26996be9-bc68-4dfa-bf80-0de3ff999413" />')
  expect(copied).toContain("Use epoch leases.")
  await review.getByLabel("Clarification").fill("Keep retries.")
  await review.getByRole("button", { name: "Clarify and prepare again" }).click()
  await expect(page.getByText("Fixture reapproval required", { exact: true })).toBeVisible()
  await expect(review).toContainText("1 added, 1 removed, 1 versions changed")
  await expect(review.getByLabel("Clarification")).toHaveValue("Keep retries.")
  expect(calls).toEqual([
    { text: "Keep the API unchanged.", answers: "", session: "chat" },
    { text: "Keep the API unchanged.", answers: "Use epoch leases.", session: "chat" },
    { text: "Keep the API unchanged.", answers: "Use epoch leases.\n\nKeep retries.", session: "chat" },
  ])
  expect(errors).toEqual([])
})
