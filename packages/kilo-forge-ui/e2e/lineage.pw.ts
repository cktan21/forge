import { expect, test } from "@playwright/test"
import { caveat } from "@kilocode/forge/lineage"
import { usage, type Manifest } from "@kilocode/forge/schema"

test("cancelled preparation retains partial execution without selected or sent evidence", async ({ page }) => {
  const base = process.env.FORGE_TEST_URL ?? "http://127.0.0.1:4096"
  const capture: Manifest = {
    id: "cancelled", root: "/fixture", session: "chat", generation: "fixture", purpose: "enhance",
    model: "none", observed: 1, entries: [], attempts: [], coverage: [], usage: usage(), state: "failed",
    retrieval: { started: 1, updated: 5, finished: 5, state: "cancelled", phase: "channels", channels: [
      { name: "keyword", state: "completed", started: 1, finished: 2 },
      { name: "semantic", state: "abandoned", started: 1, finished: 5 },
    ] },
  }
  await page.route("**/event?**", (route) => route.fulfill({ status: 200, contentType: "text/event-stream", body: "" }))
  await page.route(/\/forge\/(status|view|requests|policy|knowledge)(?:\?|$)/, (route) => {
    const endpoint = new URL(route.request().url()).pathname.split("/").at(-1)
    return route.fulfill({ json: endpoint === "requests" ? [capture]
      : endpoint === "status" ? { inventory: { root: "/fixture", generation: "fixture", counts: {}, files: 0, warnings: [], indexed: false }, session: "chat", job: { state: "idle", message: "Ready" } }
      : endpoint === "view" ? { root: "/fixture", generation: "fixture", sources: [], relations: [], page: { offset: 0, limit: 100 }, warnings: [] }
      : endpoint === "policy" ? { version: "fixture", session: "chat", pin: [], exclude: [] }
      : { collections: [], provider: "", generation: "fixture", page: { offset: 0, limit: 10 } } })
  })
  await page.goto(`${base}/forge/?directory=/fixture&session=chat`)
  await page.locator("#request").selectOption("cancelled")
  await page.locator(".retrieval-history summary").click()
  await expect(page.locator(".retrieval-history")).toContainText("Retrieval execution: cancelled; last phase: channels")
  await expect(page.locator(".retrieval-history")).toContainText("keyword: completed")
  await expect(page.locator(".retrieval-history")).toContainText("semantic: abandoned")
  await expect(page.locator(".retrieval-history")).toContainText("do not imply selected evidence or provider transmission")
  await expect(page.locator(".request-info")).toContainText("0 captured sources")
  await expect(page.locator(".selection-history")).toContainText("Selection history unavailable")
})

for (const scope of ["session", "workspace"] as const) {
for (const age of ["recent", "older"] as const) {
test(`request view resolves ${age} ${scope} preparation references without borrowing unrelated history`, async ({ page }) => {
  const base = process.env.FORGE_TEST_URL ?? "http://127.0.0.1:4096"
  const parent = "26996be9-bc68-4dfa-bf80-0de3ff999412"
  const capture: Manifest = {
    id: "coding", operation: parent, preparation: parent, root: "/fixture", session: "chat",
    generation: "fixture", purpose: "coding", model: "local", observed: 1,
    lookups: ["lookup"],
    entries: [], coverage: [caveat], usage: usage(), state: "completed",
    attempts: [
      { id: "attempt-one", sequence: 1, started: 0, finished: 5, state: "response", status: 503, membership: "matched", sent: ["source-one"] },
      { id: "attempt-two", sequence: 2, started: 6, finished: 10, state: "response", status: 200, membership: "matched", sent: [] },
    ], discarded: 0,
  }
  const captures: Manifest[] = [capture, {
    ...capture, id: parent, session: scope === "workspace" ? "" : "chat", preparation: undefined, purpose: "enhance",
    selection: {
      candidates: [
        { source: "selected-id", hash: "original-version", score: 1, retrieval: "Keyword match", state: "selected", reason: "Selected within the evidence budget", channels: [{ name: "keyword", rank: 3, score: 0.7, reason: "BM25 match" }] },
        { source: "omitted-id", hash: "omitted-version", score: 0.5, retrieval: "Related document", state: "omitted", reason: "Excluded by developer" },
      ], total: 2, unrecorded: 0, withheld: 0, budget: 1000, tokens: 100, estimator: "utf8-bytes-conservative",
      channels: [{ name: "keyword", state: "completed", candidates: 2, withheld: 0 }, { name: "semantic", state: "unavailable", candidates: 0, withheld: 0, readiness: { state: "uninitialized", searchable: false } }],
    },
  }, { ...capture, id: "legacy", purpose: "enhance", operation: undefined, preparation: undefined, attempts: undefined, discarded: undefined, coverage: [] }]
  captures.push({ ...captures.at(1)!, id: "lookup", purpose: "tool-retrieval", session: "chat", preparation: undefined, lookups: undefined, lookup: { tool: "forge_search_code", call: "call", query: "queue lease" } })
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  // HTTP fixtures isolate rendering; engine/transport lineage is tested in the host package.
  await page.route("**/event?**", (route) => route.fulfill({ status: 200, contentType: "text/event-stream", body: "" }))
  const lookups: string[] = []
  await page.route(/\/forge\/requests\/[^/?]+(?:\?|$)/, (route) => {
    const url = new URL(route.request().url())
    const key = url.pathname.split("/").at(-1)
    const session = url.searchParams.get("session") ?? ""
    lookups.push(`${session}:${key}`)
    return route.fulfill({ json: { request: captures.find((item) => item.id === key && item.session === session) ?? null } })
  })
  await page.route(/\/forge\/(status|view|requests|policy|knowledge)(?:\?|$)/, (route) => {
    const url = new URL(route.request().url())
    const endpoint = url.pathname.split("/").at(-1)
    const records = (url.searchParams.get("session") === ""
      ? [...captures.filter((item) => item.session === ""), { ...capture, id: "unrelated", session: "", purpose: "enhance" }]
      : captures.filter((item) => item.session === "chat")).filter((item) => item.id !== "lookup" && (age === "recent" || item.id !== parent))
    const body = endpoint === "requests" ? records
      : endpoint === "status" ? {
        inventory: { root: "/fixture", generation: "fixture", counts: {}, files: 0, warnings: [], indexed: false },
        session: "chat", job: { state: "idle", message: "Ready" },
        semantic: { state: "ready", searchable: true },
        coding: { ...capture, entries: 0, sent: 0 },
      }
      : endpoint === "view" ? { root: "/fixture", generation: "fixture", sources: [], relations: [], page: { offset: 0, limit: 100 }, warnings: [] }
      : endpoint === "policy" ? { version: "fixture", session: "chat", pin: [], exclude: [] }
      : { collections: [], provider: "", generation: "fixture", page: { offset: 0, limit: 10 } }
    return route.fulfill({ json: body })
  })
  await page.goto(`${base}/forge/?directory=/fixture&session=chat`)
  await expect(page.getByText("Semantic index: ready;", { exact: false })).toBeVisible()
  await expect(page.getByText("Collection semantic search requires separate host configuration, destination approval and explicit indexing;", { exact: false })).toBeVisible()
  await expect(page.getByText("repository readiness does not describe collection coverage.", { exact: false })).toBeVisible()
  await expect(page.locator(".request-info")).toContainText(`Preparation reference: ${parent}`)
  await expect(page.locator(".request-info")).toContainText(caveat)
  await expect(page.locator(".request-info")).toContainText("2 transport attempts retained")
  await page.getByText("Attempt 1: HTTP 503", { exact: false }).click()
  await expect(page.locator(".request-info")).toContainText("Matched source IDs: source-one")
  await expect(page.locator(".request-info")).toContainText("Attempt 2: HTTP 200; 0 excerpt matches")
  await page.getByRole("button", { name: "Inspect referenced preparation (when retained in history)" }).click()
  await expect(page.locator(".selection-history")).toContainText("Selection history: 2 scoped candidates")
  await expect(page.locator(".selection-history")).toContainText("semantic: unavailable")
  await expect(page.locator(".selection-history")).toContainText("Semantic index: not initialized; search unavailable")
  await expect(page.locator(".selection-history")).not.toContainText("Semantic index: ready")
  await page.getByText("omitted: omitted-id", { exact: true }).click()
  await expect(page.locator(".selection-history")).toContainText("Excluded by developer")
  await page.getByText("selected: selected-id", { exact: true }).click()
  await expect(page.locator(".selection-history")).toContainText("original-version")
  await expect(page.locator(".selection-history")).toContainText("keyword rank 3")
  expect(lookups.every((item) => item === "chat:coding" || item === `chat:${parent}` || item === `:${parent}`)).toBe(true)
  if (age === "older" || scope === "workspace") expect(lookups).toContain(`chat:${parent}`)
  if (scope === "workspace") expect(lookups).toContain(`:${parent}`)
  if (age === "older" || scope === "workspace") {
    const before = lookups.length
    await page.getByRole("button", { name: "Reload view", exact: true }).click()
    await expect.poll(() => lookups.length).toBeGreaterThan(before)
    await expect(page.locator(".selection-history")).toContainText("Selection history: 2 scoped candidates")
  }
  await expect(page.locator("#request option[value=unrelated]")).toHaveCount(0)
  await page.locator("#request").selectOption("legacy")
  await expect(page.locator(".request-info")).not.toContainText("Preparation reference")
  await expect(page.locator(".request-info")).toContainText("Transport attempt history unavailable")
  await expect(page.locator(".request-info")).not.toContainText("Attempt 1:")
  await expect(page.locator(".selection-history")).toContainText("Selection history unavailable")
  await expect(page.locator(".selection-history")).toContainText("Retrieval channel history unavailable")
  await expect(page.locator(".selection-history")).not.toContainText("original-version")
  await page.locator("#request").selectOption("coding")
  await expect(page.locator(".request-info")).toContainText(parent)
  await page.getByRole("button", { name: "Inspect tool retrieval lookup", exact: true }).click()
  await expect(page.locator(".selection-history")).toContainText("Lookup tool: forge_search_code")
  await expect(page.locator(".selection-history")).toContainText("Query / source ID: queue lease")
  await expect(page.locator(".selection-history")).toContainText("Selection history: 2 scoped candidates")
  expect(lookups).toContain("chat:lookup")
  expect(lookups).not.toContain(":lookup")
  expect(errors).toEqual([])
})
}
}

for (const outcome of ["missing", "failed", "foreign", "error", "delayed"] as const) {
test(`request detail lookup handles ${outcome} captures without showing stale history`, async ({ page }) => {
  const base = process.env.FORGE_TEST_URL ?? "http://127.0.0.1:4096"
  const capture: Manifest = {
    id: "coding", preparation: "parent", root: "/fixture", session: "chat",
    generation: "fixture", purpose: "coding", model: "local", observed: 1,
    entries: [], coverage: [], usage: usage(), state: "completed",
  }
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let failing = outcome === "error"
  await page.route("**/event?**", (route) => route.fulfill({ status: 200, contentType: "text/event-stream", body: "" }))
  await page.route(/\/forge\/requests\/parent(?:\?|$)/, async (route) => {
    const url = new URL(route.request().url())
    if (failing) return route.fulfill({ status: 503, json: { message: "History unavailable" } })
    if (url.searchParams.get("session") === "chat") return route.fulfill({ json: { request: null } })
    started.resolve()
    if (outcome === "delayed") await release.promise
    return route.fulfill({ json: {
      request: outcome === "missing" ? null : {
        ...capture, id: "parent", preparation: undefined, purpose: "enhance",
        session: outcome === "foreign" ? "private" : "",
        state: outcome === "failed" ? "failed" : "completed",
        coverage: ["Historical parent canary"],
      },
    } })
  })
  await page.route(/\/forge\/(status|view|requests|policy|knowledge)(?:\?|$)/, (route) => {
    const endpoint = new URL(route.request().url()).pathname.split("/").at(-1)
    return route.fulfill({ json: endpoint === "requests" ? [capture]
      : endpoint === "status" ? {
        inventory: { root: "/fixture", generation: "fixture", counts: {}, files: 0, warnings: [], indexed: false },
        session: "chat", job: { state: "idle", message: "Ready" }, coding: { ...capture, entries: 0, sent: 0 },
      }
      : endpoint === "view" ? { root: "/fixture", generation: "fixture", sources: [], relations: [], page: { offset: 0, limit: 100 }, warnings: [] }
      : endpoint === "policy" ? { version: "fixture", session: "chat", pin: [], exclude: [] }
      : { collections: [], provider: "", generation: "fixture", page: { offset: 0, limit: 10 } },
    })
  })
  await page.goto(`${base}/forge/?directory=/fixture&session=chat`)
  await page.getByRole("button", { name: "Inspect referenced preparation (when retained in history)" }).click()
  if (outcome === "delayed") {
    await started.promise
    await page.locator("#request").selectOption("coding")
    release.resolve()
    await expect(page.locator(".request-info")).toContainText("Preparation reference: parent")
  } else {
    await expect(page.getByRole("alert")).toContainText(outcome === "error" ? "History unavailable" : outcome === "foreign" ? "scope or identity mismatch" : "no longer retained")
    await expect(page.locator(".request-info")).toHaveCount(0)
  }
  await expect(page.locator("main")).not.toContainText("Historical parent canary")
  if (outcome === "error") {
    failing = false
    await page.getByRole("button", { name: "Reload view", exact: true }).click()
    await expect(page.locator(".request-info")).toContainText("Historical parent canary")
    await expect(page.getByRole("alert")).toHaveCount(0)
  }
  await page.locator("#request").selectOption("")
  await expect(page.getByRole("alert")).toHaveCount(0)
})
}
