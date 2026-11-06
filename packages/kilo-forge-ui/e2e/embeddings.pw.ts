import { expect, test, type Page, type Route } from "@playwright/test"
import type { EmbeddingJob, EmbeddingCoverage } from "@kilocode/forge/schema"
import { account } from "@kilocode/forge/embedding-usage"
import { readFile } from "node:fs/promises"

const revision = "a".repeat(64)
const destination = {
  endpoint: "https://embedding.example/v1/embeddings",
  target: { fingerprint: "route-fingerprint", model: "fixture-model", dimensions: 2 },
  revision,
  approved: false,
}

function coverage(): EmbeddingCoverage {
  return {
    collection: "reference",
    session: "chat",
    target: destination.target,
    started: 1,
    finished: 2,
    sections: 5,
    reusable: 1,
    missing: 1,
    outdated: 1,
    stale: 1,
    excluded: 1,
  }
}

function job(state: EmbeddingJob["state"] = "completed"): EmbeddingJob {
  return {
    id: "job-1",
    collection: "reference",
    session: "chat",
    revision: "revision",
    target: destination.target,
    state,
    started: 1,
    updated: 2,
    progressed: 2,
    progress: { phase: "validating", processed: 3, embedded: 2, reused: 1, sections: 3 },
    ...(state === "completed" ? { finished: 3, result: { sections: 3, embedded: 2, reused: 1 } } : {}),
  }
}
async function fixture(
  page: Page,
  respond: (route: Route) => Promise<void>,
  history: (route: Route) => Promise<void> = (route) => route.fulfill({ json: [] }),
) {
  const calls: { path: string; method: string; session: string | null; body: unknown }[] = []
  await page.route("**/event?**", (route) => route.fulfill({ contentType: "text/event-stream", body: "" }))
  await page.route(/\/forge\/(status|view|requests|policy|knowledge)(?:\?|$)/, (route) => {
    const endpoint = new URL(route.request().url()).pathname.split("/").at(-1)
    return route.fulfill({
      json:
        endpoint === "requests"
          ? []
          : endpoint === "status"
            ? {
                inventory: {
                  root: "/fixture",
                  generation: "fixture",
                  counts: {},
                  files: 0,
                  warnings: [],
                  indexed: false,
                },
                session: "chat",
                job: { state: "idle", message: "Ready" },
              }
            : endpoint === "view"
              ? {
                  root: "/fixture",
                  generation: "fixture",
                  sources: [],
                  relations: [],
                  page: { offset: 0, limit: 100 },
                  warnings: [],
                }
              : endpoint === "policy"
                ? { version: "fixture", session: "chat", pin: [], exclude: [] }
                : {
                    collections: ["reference", "other"].map((id) => ({
                      id,
                      label: id,
                      location: "/docs",
                      state: "ready",
                      approved: true,
                      chunks: 1,
                      files: 1,
                      session: "",
                      providers: [],
                      warnings: [],
                    })),
                    provider: "",
                    generation: "fixture",
                    page: { offset: 0, limit: 10 },
                  },
    })
  })
  await page.route(/\/forge\/knowledge\/[^/]+\/embeddings(?:\/[^?]+)?\?/, async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.pathname.endsWith("/jobs") && request.method() === "GET") {
      await history(route)
      return
    }
    calls.push({
      path: url.pathname,
      method: request.method(),
      session: url.searchParams.get("session"),
      body: request.postDataJSON(),
    })
    await respond(route)
  })
  await page.goto(`${process.env.FORGE_TEST_URL ?? "http://127.0.0.1:4096"}/forge/?directory=/fixture&session=chat`)
  await page.getByRole("button", { name: "Manage embeddings", exact: true }).first().click()
  return { calls, panel: page.getByRole("article", { name: "Collection embeddings", exact: true }) }
}

function attempt(id = "attempt-1") {
  return {
    id,
    session: "chat",
    collections: ["reference", "other"],
    target: destination.target,
    purpose: "query",
    started: 1,
    usage: account(undefined, { state: "attempt", inputs: 1, bytes: 52 }),
  }
}

test("session usage is explicit and rejects a non-progressing cursor", async ({ page }) => {
  const requests: string[] = []
  await page.route("**/forge/embeddings/usage?**", (route) => {
    const url = new URL(route.request().url())
    requests.push(url.toString())
    expect(url.searchParams.get("session")).toBe("chat")
    expect(Number(url.searchParams.get("limit"))).toBeLessThanOrEqual(100)
    return route.fulfill({ json: { session: "chat", entries: [attempt()], next: "10" } })
  })
  const { panel, calls } = await fixture(page, (route) => route.fulfill({ json: destination }))
  const section = panel.getByRole("region", { name: "Session embedding usage", exact: true })
  await expect(section).toContainText("not only the selected collection")
  expect(requests).toHaveLength(0)
  await section.getByRole("button", { name: "Inspect latest usage", exact: true }).click()
  await expect(section.getByRole("alert")).toContainText("Invalid embedding usage page")
  expect(calls).toEqual([])
})

test("usage download contains bounded records and current-page unknown subtotals", async ({ page }) => {
  let requests = 0
  await page.route("**/forge/embeddings/usage?**", (route) => {
    requests++
    return route.fulfill({
      json: {
        session: "chat",
        entries: Array.from({ length: 100 }, (_, index) => attempt(`attempt-${index}`)),
        next: "10",
      },
    })
  })
  const { panel, calls } = await fixture(page, (route) => route.fulfill({ json: destination }))
  const section = panel.getByRole("region", { name: "Session embedding usage" })
  expect(requests).toBe(0)
  await section.getByRole("button", { name: "Inspect latest usage" }).click()
  await expect(section).toContainText("100 observed attempts")
  await expect(section.getByRole("definition").last()).toHaveText("0 / 0 / 100")
  const pending = page.waitForEvent("download")
  await section.getByRole("link", { name: "Download observed usage JSON" }).click()
  const download = await pending
  const value = JSON.parse(await readFile(await download.path(), "utf8"))
  expect(value.entries).toHaveLength(100)
  expect(value).toMatchObject({ session: "chat", traversal: "limited", next: "10", snapshot: false, cost: null })
  expect(value.groups.at(0).unknown).toEqual({ prompt: 100, total: 100 })
  expect(requests).toBe(1)
  await page.route("**/forge/embeddings/usage?**", (route) => {
    expect(new URL(route.request().url()).searchParams.get("after")).toBe("10")
    return route.fulfill({ json: { session: "chat", entries: [] } })
  })
  await section.getByRole("button", { name: "Next usage page" }).click()
  await expect(section).toContainText("0 observed attempts")
  await expect(section).toContainText("does not prove complete historical usage")
  await expect(section.getByRole("button", { name: "Next usage page" })).toHaveCount(0)
  expect(calls).toEqual([])
})

test("usage errors clear previous data and reject foreign session and malformed counters", async ({ page }) => {
  let mode = "ready"
  await page.route("**/forge/embeddings/usage?**", (route) => {
    if (mode === "denied") return route.fulfill({ status: 403, json: { message: "Usage access denied" } })
    return route.fulfill({
      json: {
        session: mode === "foreign" ? "foreign" : "chat",
        entries: [{ ...attempt(), usage: { ...attempt().usage, attempts: mode === "invalid" ? 2 : 1 } }],
      },
    })
  })
  const { panel } = await fixture(page, (route) => route.fulfill({ json: destination }))
  const section = panel.getByRole("region", { name: "Session embedding usage" })
  await section.getByRole("button", { name: "Inspect latest usage" }).click()
  await expect(section.getByRole("link")).toBeVisible()
  for (const next of ["denied", "foreign", "invalid"]) {
    mode = next
    await section.getByRole("button", { name: "Inspect latest usage" }).click()
    await expect(section.getByRole("alert")).toBeVisible()
    await expect(section.getByRole("link")).toHaveCount(0)
    await expect(section).not.toContainText("1 observed attempts")
  }
})

for (const action of ["cancel", "close", "scope", "refresh", "revoke"] as const) {
  test(`${action} invalidates held usage and rejects late data`, async ({ page }) => {
    const entered = Promise.withResolvers<void>()
    const released = Promise.withResolvers<void>()
    const done = Promise.withResolvers<void>()
    await page.route("**/forge/embeddings/usage?**", async (route) => {
      entered.resolve()
      await released.promise
      try {
        await route.fulfill({ json: { session: "chat", entries: [attempt("private-late-usage")] } })
      } finally {
        done.resolve()
      }
    })
    const { panel, calls } = await fixture(page, (route) => route.fulfill({ json: { revoked: true } }))
    const section = panel.getByRole("region", { name: "Session embedding usage" })
    try {
      await section.getByRole("button", { name: "Inspect latest usage" }).click()
      await entered.promise
      const aborted = page.waitForEvent("requestfailed", {
        predicate: (request) => request.url().includes("/embeddings/usage?"),
      })
      if (action === "cancel") await section.getByRole("button", { name: "Cancel usage inspection" }).click()
      if (action === "close") await panel.getByRole("button", { name: "Close embeddings", exact: true }).click()
      if (action === "scope") await page.getByRole("button", { name: "Manage embeddings", exact: true }).last().click()
      if (action === "refresh") await page.getByRole("button", { name: "Reload view", exact: true }).click()
      if (action === "revoke") await panel.getByRole("button", { name: "Revoke embedding consent" }).click()
      await aborted
    } finally {
      released.resolve()
      await done.promise
    }
    await expect(page.getByRole("link", { name: "Download observed usage JSON" })).toHaveCount(0)
    await expect(page.locator("body")).not.toContainText("private-late-usage")
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(action === "revoke" ? 1 : 0)
  })
}

test("completed usage is invalidated and its download revoked when embedding state changes", async ({ page }) => {
  let reads = 0
  await page.route("**/forge/embeddings/usage?**", (route) => {
    reads++
    return route.fulfill({ json: { session: "chat", entries: [attempt()] } })
  })
  const { panel } = await fixture(page, (route) => route.fulfill({ json: { revoked: true } }))
  const section = panel.getByRole("region", { name: "Session embedding usage" })
  await section.getByRole("button", { name: "Inspect latest usage" }).click()
  const link = section.getByRole("link", { name: "Download observed usage JSON" })
  await expect(link).toBeVisible()
  const url = await link.getAttribute("href")
  await panel.getByRole("button", { name: "Revoke embedding consent" }).click()
  await expect(link).toHaveCount(0)
  await expect(section).not.toContainText("1 observed attempts")
  const available = await page.evaluate(async (url) => {
    try { await fetch(url!); return true }
    catch { return false }
  }, url)
  expect(available).toBe(false)
  expect(reads).toBe(1)
})

test("narrow usage view supports keyboard inspection and wrapped destination metadata", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 900 })
  await page.route("**/forge/embeddings/usage?**", (route) => route.fulfill({ json: {
    session: "chat", entries: [{ ...attempt(), target: { ...destination.target, fingerprint: "long-route-".repeat(50) } }],
  } }))
  const { panel } = await fixture(page, (route) => route.fulfill({ json: destination }))
  const section = panel.getByRole("region", { name: "Session embedding usage" })
  await section.getByRole("button", { name: "Inspect latest usage" }).focus()
  await page.keyboard.press("Enter")
  await expect(section).toContainText("1 observed attempts")
  await section.getByText("Observed attempt records (1)", { exact: true }).focus()
  await page.keyboard.press("Enter")
  await expect(section.getByText(/attempt-1: query/)).toBeVisible()
  await section.getByRole("link", { name: "Download observed usage JSON" }).focus()
  await expect(section.getByRole("link")).toBeFocused()
  expect(await section.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
})

test("usage deadline clears held reads without changing jobs", async ({ page }) => {
  await page.clock.install()
  const entered = Promise.withResolvers<void>()
  const released = Promise.withResolvers<void>()
  const done = Promise.withResolvers<void>()
  await page.route("**/forge/embeddings/usage?**", async (route) => {
    entered.resolve()
    await released.promise
    try { await route.fulfill({ json: { session: "chat", entries: [attempt()] } }) }
    finally { done.resolve() }
  })
  const { panel, calls } = await fixture(page, (route) => route.fulfill({ json: destination }))
  const section = panel.getByRole("region", { name: "Session embedding usage" })
  try {
    await section.getByRole("button", { name: "Inspect latest usage" }).click()
    await entered.promise
    await page.clock.fastForward(30_001)
    await expect(section).toContainText("Usage inspection timed out")
    await expect(section.getByRole("link")).toHaveCount(0)
    await expect(section.getByRole("button", { name: "Inspect latest usage" })).toBeEnabled()
  } finally {
    released.resolve()
    await done.promise
  }
  expect(calls).toEqual([])
})

test("job usage shows partial provider reports and preserves unknown legacy accounting", async ({ page }) => {
  let value: EmbeddingJob = job()
  const { panel, calls } = await fixture(
    page,
    (route) => route.fulfill({ json: destination }),
    (route) => route.fulfill({ json: [value] }),
  )
  const usage = panel.locator('[aria-label="Embedding job usage"]')
  await expect(usage).toHaveText("Usage accounting unavailable for this job.")
  value = {
    ...job("failed"),
    usage: {
      attempts: 3,
      inputs: 33,
      bytes: 2048,
      responses: 1,
      failed: 1,
      pending: 1,
      promptTokens: 42,
      promptReports: 1,
      totalTokens: 0,
      totalReports: 0,
    },
  }
  await panel.getByRole("button", { name: "Refresh embedding jobs", exact: true }).click()
  await expect(usage).toContainText("Locally admitted attempts: 3; inputs: 33; request-body bytes: 2048")
  await expect(usage).toContainText("failed without a JSON report: 1; unresolved: 1")
  await expect(usage).toContainText("prompt-token subtotal: 42 from 1 reports; 2 attempts unknown")
  await expect(usage).toContainText("total-token subtotal: 0 from 0 reports; 3 attempts unknown")
  await expect(usage).toContainText("Monetary cost unknown")
  value = { ...value, usage: { ...value.usage!, attempts: 4 } }
  await panel.getByRole("button", { name: "Refresh embedding jobs", exact: true }).click()
  await expect(usage).toContainText("inconsistent counters")
  await expect(usage).not.toContainText("subtotal")
  expect(calls).toEqual([])
})

test("coverage is explicit, scoped, partitioned and invalidated without automatically embedding or rechecking", async ({
  page,
}) => {
  let result = coverage()
  const { panel, calls } = await fixture(page, (route) => route.fulfill({ json: result }))
  const section = panel.getByRole("region", { name: "Embedding coverage", exact: true })
  expect(calls).toEqual([])
  await panel.getByRole("button", { name: "Refresh embedding jobs", exact: true }).click()
  expect(calls).toEqual([])
  await section.getByRole("button", { name: "Check embedding coverage", exact: true }).click()
  await expect(section).toContainText("1970-01-01T00:00:00.002Z")
  await expect(section).toContainText(destination.target.fingerprint)
  await expect(section.locator("dt")).toHaveText([
    "Stored nonblank sections",
    "Reusable vectors",
    "Missing vectors",
    "Outdated vectors",
    "Stale or unavailable originals",
    "Excluded sections",
  ])
  await expect(section.locator("dd")).toHaveText(["5", "1", "1", "1", "1", "1"])
  expect(calls).toEqual([
    {
      path: "/forge/knowledge/reference/embeddings/coverage",
      method: "GET",
      session: "chat",
      body: null,
    },
  ])
  await page.getByRole("button", { name: "Reload view", exact: true }).click()
  await expect(section.locator("dl")).toHaveCount(0)
  await expect(section).toContainText("Check coverage again")
  expect(calls).toHaveLength(1)
  result = { ...result, sections: 0, reusable: 0, missing: 0, outdated: 0, stale: 0, excluded: 0 }
  await section.getByRole("button", { name: "Check embedding coverage", exact: true }).click()
  await expect(section.locator("dd")).toHaveText(["0", "0", "0", "0", "0", "0"])
  await expect(section).not.toContainText("100%")
  expect(calls.every((call) => call.method === "GET")).toBe(true)
})

test("coverage remains keyboard-accessible and wraps long destinations on a narrow viewport", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 })
  const { panel } = await fixture(page, (route) =>
    route.fulfill({
      json: { ...coverage(), target: { ...destination.target, fingerprint: "long-route-".repeat(360) } },
    }),
  )
  const section = panel.getByRole("region", { name: "Embedding coverage", exact: true })
  const button = section.getByRole("button", { name: "Check embedding coverage", exact: true })
  await button.focus()
  await page.keyboard.press("Enter")
  await expect(section.locator("dl")).toBeVisible()
  await expect(section).toContainText("long-route-".repeat(360))
  expect(await section.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
  const bounds = await section.boundingBox()
  expect(bounds).not.toBeNull()
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(375)
})

test("failed and malformed coverage clears the prior observation and can be retried", async ({ page }) => {
  let result: unknown = coverage()
  let denied = false
  const { panel } = await fixture(page, (route) =>
    route.fulfill({
      status: denied ? 403 : 200,
      json: denied ? { message: "Embedding permission denied" } : result,
    }),
  )
  const section = panel.getByRole("region", { name: "Embedding coverage", exact: true })
  for (const invalid of [
    { ...coverage(), session: "foreign" },
    { ...coverage(), collection: "foreign" },
    { ...coverage(), reusable: -1 },
    { ...coverage(), sections: 6 },
    { ...coverage(), sections: 10_001, reusable: 9997 },
    { ...coverage(), finished: 0 },
    { ...coverage(), finished: 8_640_000_000_000_001 },
    { ...coverage(), target: { ...destination.target, dimensions: 0 } },
    null,
  ]) {
    result = coverage()
    await section.getByRole("button", { name: "Check embedding coverage", exact: true }).click()
    await expect(section.locator("dl")).toBeVisible()
    result = invalid
    await section.getByRole("button", { name: "Check embedding coverage", exact: true }).click()
    await expect(section.getByRole("alert")).toBeVisible()
    await expect(section.locator("dl")).toHaveCount(0)
    await expect(section).not.toContainText(destination.target.fingerprint)
  }
  denied = true
  await section.getByRole("button", { name: "Check embedding coverage", exact: true }).click()
  await expect(section.getByRole("alert")).toContainText("Embedding permission denied")
  denied = false
  result = coverage()
  await section.getByRole("button", { name: "Check embedding coverage", exact: true }).click()
  await expect(section.locator("dl")).toBeVisible()
  await expect(section.getByRole("alert")).toHaveCount(0)
})

for (const action of ["cancel", "close", "switch", "refresh", "revoke"] as const) {
  test(`${action} cancels coverage observation and ignores its late result`, async ({ page }) => {
    const started = Promise.withResolvers<void>()
    const released = Promise.withResolvers<void>()
    const finished = Promise.withResolvers<void>()
    let held = true
    const { panel, calls } = await fixture(page, async (route) => {
      if (route.request().method() === "POST") return route.fulfill({ json: { revoked: true } })
      const id = new URL(route.request().url()).pathname.includes("/other/") ? "other" : "reference"
      if (!held) return route.fulfill({ json: { ...coverage(), collection: id } })
      started.resolve()
      await released.promise
      try {
        await route.fulfill({
          json: { ...coverage(), target: { ...destination.target, model: "late-private-canary" } },
        })
      } finally {
        finished.resolve()
      }
    })
    const section = panel.getByRole("region", { name: "Embedding coverage", exact: true })
    try {
      await section.getByRole("button", { name: "Check embedding coverage", exact: true }).click()
      await started.promise
      const aborted = page.waitForEvent("requestfailed", {
        predicate: (request) => request.url().includes("/embeddings/coverage?"),
      })
      // Wait for the generation-triggered library read, not a button that can still be idle before debounce.
      const refreshed =
        action === "revoke" || action === "refresh"
          ? page.waitForResponse((response) => new URL(response.url()).pathname === "/forge/knowledge")
          : undefined
      if (action === "cancel") await section.getByRole("button", { name: "Cancel coverage check", exact: true }).click()
      if (action === "close") await panel.getByRole("button", { name: "Close embeddings", exact: true }).click()
      if (action === "switch") await page.getByRole("button", { name: "Manage embeddings", exact: true }).last().click()
      if (action === "refresh") await page.getByRole("button", { name: "Reload view", exact: true }).click()
      if (action === "revoke")
        await panel.getByRole("button", { name: "Revoke embedding consent", exact: true }).click()
      await aborted
      if (refreshed) await (await refreshed).finished()
      if (action === "close") await page.getByRole("button", { name: "Manage embeddings", exact: true }).first().click()
      await expect(section.locator("dl")).toHaveCount(0)
      held = false
      await expect(page.getByRole("button", { name: "Find collections", exact: true })).toBeEnabled()
      await section.getByRole("button", { name: "Check embedding coverage", exact: true }).click()
      await expect(section.locator("dl")).toBeVisible()
    } finally {
      released.resolve()
      await finished.promise
    }
    await expect(panel).not.toContainText("late-private-canary")
    await expect(section.locator("dl")).toBeVisible()
    expect(calls.filter((call) => call.method === "POST").map((call) => call.path)).toEqual(
      action === "revoke" ? ["/forge/knowledge/reference/embeddings/revoke"] : [],
    )
  })
}

test("embedding consent is explicit, scoped and separate from indexing", async ({ page }) => {
  let approved = false
  let rows: EmbeddingJob[] = []
  const { calls, panel } = await fixture(
    page,
    (route) => {
      const path = new URL(route.request().url()).pathname
      if (path.endsWith("/approve")) {
        approved = true
        return route.fulfill({ json: { approved: true } })
      }
      if (path.endsWith("/revoke")) {
        approved = false
        return route.fulfill({ json: { revoked: true } })
      }
      if (path.endsWith("/jobs")) {
        rows = [job()]
        return route.fulfill({ json: rows.at(0) })
      }
      return route.fulfill({ json: { ...destination, approved } })
    },
    (route) => route.fulfill({ json: rows }),
  )
  await expect(panel).toBeVisible()
  expect(calls).toEqual([])
  await expect(panel.getByRole("button", { name: "Approve embedding destination", exact: true })).toBeDisabled()
  await expect(panel.getByRole("button", { name: "Index embeddings", exact: true })).toBeDisabled()
  await panel.getByRole("button", { name: "Review embedding destination", exact: true }).click()
  await expect(panel).toContainText(destination.endpoint)
  await expect(panel).toContainText(destination.target.model)
  await expect(panel).toContainText(destination.target.fingerprint)
  await expect(panel.getByRole("button", { name: "Approve embedding destination", exact: true })).toBeDisabled()
  await panel.getByRole("checkbox").check()
  await panel.getByRole("button", { name: "Approve embedding destination", exact: true }).click()
  await expect(panel.getByRole("status")).toContainText("No indexing was started")
  expect(calls).toEqual([
    { path: "/forge/knowledge/reference/embeddings", method: "GET", session: "chat", body: null },
    {
      path: "/forge/knowledge/reference/embeddings/approve",
      method: "POST",
      session: "chat",
      body: { session: "chat", revision },
    },
  ])
  await expect(panel.getByRole("checkbox")).toHaveCount(0)
  await expect(panel.getByRole("button", { name: "Index embeddings", exact: true })).toBeDisabled()
  // Wait for the mutation-triggered refresh before making another observation.
  await page.getByRole("button", { name: "Reload view", exact: true }).click()
  await expect(page.getByRole("button", { name: "Find collections", exact: true })).toBeEnabled()
  await panel.getByRole("button", { name: "Review embedding destination", exact: true }).click()
  await expect(panel).toContainText("Approved for this destination")
  await panel.getByRole("button", { name: "Index embeddings", exact: true }).click()
  await expect(panel.getByRole("region", { name: "Embedding job history" })).toContainText(
    "3 sections, 2 newly embedded, 1 reused",
  )
  await expect(panel).toContainText("not a guarantee of current coverage")
  await panel.getByRole("button", { name: "Revoke embedding consent", exact: true }).click()
  await expect(panel.getByRole("status")).toContainText("consent revoked")
  expect(calls.filter((call) => call.method === "POST").map((call) => call.body)).toEqual([
    { session: "chat", revision },
    { session: "chat" },
    { session: "chat" },
  ])
  expect(calls.map((call) => call.path.split("/").at(-1))).toEqual([
    "embeddings",
    "approve",
    "embeddings",
    "jobs",
    "revoke",
  ])
})

test("failed and malformed embedding responses clear approval but permit offline revocation", async ({ page }) => {
  let mode = "ready"
  const { panel } = await fixture(page, (route) => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith("/revoke")) return route.fulfill({ json: { revoked: true } })
    if (path.endsWith("/jobs")) return route.fulfill({ status: 403, json: { message: "Embedding permission denied" } })
    if (mode === "offline") return route.fulfill({ status: 503, json: { message: "Embeddings not configured" } })
    return route.fulfill({
      json: { ...destination, approved: true, ...(mode === "malformed" ? { revision: "invalid" } : {}) },
    })
  })
  await panel.getByRole("button", { name: "Review embedding destination", exact: true }).click()
  await panel.getByRole("button", { name: "Index embeddings", exact: true }).click()
  await expect(panel.getByRole("alert")).toContainText("Embedding permission denied")
  await expect(panel).not.toContainText(destination.endpoint)
  await expect(panel.getByRole("button", { name: "Index embeddings", exact: true })).toBeDisabled()
  mode = "malformed"
  await panel.getByRole("button", { name: "Review embedding destination", exact: true }).click()
  await expect(panel.getByRole("alert")).toBeVisible()
  await expect(panel).not.toContainText("Approved for this destination")
  await expect(panel.getByRole("button", { name: "Index embeddings", exact: true })).toBeDisabled()
  mode = "offline"
  await panel.getByRole("button", { name: "Review embedding destination", exact: true }).click()
  await expect(panel.getByRole("alert")).toContainText("Embeddings not configured")
  await panel.getByRole("button", { name: "Revoke embedding consent", exact: true }).click()
  await expect(panel.getByRole("status")).toContainText("consent revoked")
  await expect(panel.getByRole("alert")).toHaveCount(0)
})

for (const action of ["cancel", "close", "switch", "refresh"]) {
  test(`${action} cancels a pending embedding review and rejects its late approval`, async ({ page }) => {
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const finished = Promise.withResolvers<void>()
    const { panel } = await fixture(page, async (route) => {
      started.resolve()
      await release.promise
      try {
        await route.fulfill({ json: { ...destination, approved: true } })
      } finally {
        finished.resolve()
      }
    })
    await panel.getByRole("button", { name: "Review embedding destination", exact: true }).click()
    try {
      await started.promise
      const aborted = page.waitForEvent("requestfailed", {
        predicate: (request) => request.url().includes("/embeddings?"),
      })
      if (action === "cancel")
        await panel.getByRole("button", { name: "Cancel embedding request", exact: true }).click()
      if (action === "close") await panel.getByRole("button", { name: "Close embeddings", exact: true }).click()
      if (action === "switch") await page.getByRole("button", { name: "Manage embeddings", exact: true }).last().click()
      if (action === "refresh") await page.getByRole("button", { name: "Reload view", exact: true }).click()
      await aborted
    } finally {
      release.resolve()
      await finished.promise
    }
    if (action === "close") {
      await expect(panel).toHaveCount(0)
      await page.getByRole("button", { name: "Manage embeddings", exact: true }).first().click()
    }
    await expect(panel).not.toContainText(destination.endpoint)
    await expect(panel.getByRole("button", { name: "Index embeddings", exact: true })).toBeDisabled()
    await expect(panel.getByRole("button", { name: "Review embedding destination", exact: true })).toBeEnabled()
    if (action === "switch")
      await expect(panel.getByRole("heading", { level: 3 })).toHaveText("Collection embeddings: other")
  })
}

test("pending start survives status refresh; cancelling the client request warns that the job may still run", async ({
  page,
}) => {
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const finished = Promise.withResolvers<void>()
  let rows: EmbeddingJob[] = []
  const { panel } = await fixture(
    page,
    async (route) => {
      if (!new URL(route.request().url()).pathname.endsWith("/jobs"))
        return route.fulfill({ json: { ...destination, approved: true } })
      started.resolve()
      rows = [job("running")]
      await release.promise
      try {
        await route.fulfill({ json: { ...job(), id: "late-999" } })
      } finally {
        finished.resolve()
      }
    },
    (route) => route.fulfill({ json: rows }),
  )
  await panel.getByRole("button", { name: "Review embedding destination", exact: true }).click()
  await panel.getByRole("button", { name: "Index embeddings", exact: true }).click()
  try {
    await started.promise
    await page.getByRole("button", { name: "Reload view", exact: true }).click()
    await expect(page.getByRole("button", { name: "Find collections", exact: true })).toBeEnabled()
    await expect(panel.getByRole("status")).toContainText("waiting for admission")
    await expect(panel.getByRole("button", { name: "Revoke embedding consent", exact: true })).toBeDisabled()
    const aborted = page.waitForEvent("requestfailed", {
      predicate: (request) => request.method() === "POST" && request.url().includes("/embeddings/jobs?"),
    })
    await panel.getByRole("button", { name: "Cancel embedding request", exact: true }).click()
    await aborted
    await expect(panel.getByRole("status")).toContainText("An admitted job may still be running")
  } finally {
    release.resolve()
    await finished.promise
  }
  await expect(panel).not.toContainText("999")
  await expect(panel).toContainText("Job job-1: running")
  await expect(panel.getByRole("button", { name: "Index embeddings", exact: true })).toBeDisabled()
  await expect(panel.getByRole("button", { name: "Review embedding destination", exact: true })).toBeEnabled()
})

test("closing and reopening observes the same background job; cancellation is explicit and scoped", async ({
  page,
}) => {
  let rows: EmbeddingJob[] = []
  const scopes: string[] = []
  const { panel, calls } = await fixture(
    page,
    (route) => {
      const path = new URL(route.request().url()).pathname
      if (path.endsWith("/cancel")) {
        rows = [{ ...job("cancelled"), finished: 5 }]
        return route.fulfill({ json: { requested: true } })
      }
      if (path.endsWith("/jobs")) {
        rows = [job("running")]
        return route.fulfill({ json: rows.at(0) })
      }
      return route.fulfill({ json: { ...destination, approved: true } })
    },
    (route) => {
      scopes.push(new URL(route.request().url()).searchParams.get("session") ?? "")
      return route.fulfill({ json: rows })
    },
  )
  await panel.getByRole("button", { name: "Review embedding destination", exact: true }).click()
  await panel.getByRole("button", { name: "Index embeddings", exact: true }).click()
  await expect(panel).toContainText("Job job-1: running")
  await expect(panel).toContainText("Last material progress")
  await expect(panel.getByRole("button", { name: "Index embeddings", exact: true })).toBeDisabled()
  await panel.getByRole("button", { name: "Close embeddings", exact: true }).click()
  expect(calls.filter((call) => call.path.endsWith("/cancel"))).toEqual([])
  await page.getByRole("button", { name: "Manage embeddings", exact: true }).first().click()
  await expect(panel).toContainText("Job job-1: running")
  await panel.getByRole("button", { name: "Cancel embedding job job-1", exact: true }).click()
  await expect(panel).toContainText("Job job-1: cancelled")
  expect(calls.filter((call) => call.path.endsWith("/cancel"))).toEqual([
    {
      path: "/forge/knowledge/reference/embeddings/jobs/job-1/cancel",
      method: "POST",
      session: "chat",
      body: { session: "chat" },
    },
  ])
  expect(scopes.length).toBeGreaterThan(1)
  expect(scopes.every((scope) => scope === "chat")).toBe(true)
})

test("failed or wrong-scope history clears obsolete jobs and can be retried without embedding approval", async ({
  page,
}) => {
  let mode = "ready"
  const { panel, calls } = await fixture(
    page,
    (route) => route.fulfill({ status: 503, json: { message: "Embeddings not configured" } }),
    (route) =>
      mode === "failed"
        ? route.fulfill({ status: 403, json: { message: "Knowledge access denied" } })
        : route.fulfill({
            json: [
              mode === "wrong"
                ? { ...job("running"), session: "foreign" }
                : mode === "malformed"
                  ? { ...job("running"), updated: 8_640_000_000_000_001 }
                  : job("running"),
            ],
          }),
  )
  await expect(panel).toContainText("Job job-1: running")
  mode = "failed"
  await panel.getByRole("button", { name: "Refresh embedding jobs", exact: true }).click()
  await expect(panel.getByRole("alert")).toContainText("Knowledge access denied")
  await expect(panel).not.toContainText("Job job-1")
  mode = "wrong"
  await panel.getByRole("button", { name: "Refresh embedding jobs", exact: true }).click()
  await expect(panel.getByRole("alert")).toContainText("does not match")
  await expect(panel).not.toContainText("Job job-1")
  mode = "malformed"
  await panel.getByRole("button", { name: "Refresh embedding jobs", exact: true }).click()
  await expect(panel.getByRole("alert")).toContainText("invalid identifiers or timestamps")
  await expect(panel).not.toContainText("Job job-1")
  mode = "ready"
  await panel.getByRole("button", { name: "Refresh embedding jobs", exact: true }).click()
  await expect(panel).toContainText("Job job-1: running")
  expect(calls).toEqual([])
})

test("closing history aborts observation and late private metadata cannot enter another collection", async ({
  page,
}) => {
  const started = Promise.withResolvers<void>()
  const released = Promise.withResolvers<void>()
  const finished = Promise.withResolvers<void>()
  const { panel } = await fixture(
    page,
    (route) => route.fulfill({ json: destination }),
    async (route) => {
      if (new URL(route.request().url()).pathname.includes("/other/")) return route.fulfill({ json: [] })
      started.resolve()
      await released.promise
      try {
        await route.fulfill({ json: [{ ...job(), id: "private-history-canary" }] })
      } finally {
        finished.resolve()
      }
    },
  )
  try {
    await started.promise
    const aborted = page.waitForEvent("requestfailed", {
      predicate: (request) => request.url().includes("/reference/embeddings/jobs?"),
    })
    await page.getByRole("button", { name: "Manage embeddings", exact: true }).last().click()
    await aborted
    await expect(panel).toContainText("No retained embedding jobs")
  } finally {
    released.resolve()
    await finished.promise
  }
  await expect(panel).not.toContainText("private-history-canary")
})

test("cancel failures and malformed acknowledgements keep the persisted job observable", async ({ page }) => {
  let mode = "failed"
  const { panel } = await fixture(
    page,
    (route) =>
      mode === "failed"
        ? route.fulfill({ status: 403, json: { message: "Cancellation permission denied" } })
        : route.fulfill({ json: { requested: false } }),
    (route) => route.fulfill({ json: [job("running")] }),
  )
  await panel.getByRole("button", { name: "Cancel embedding job job-1", exact: true }).click()
  await expect(panel.getByRole("alert")).toContainText("Cancellation permission denied")
  await expect(panel).toContainText("Job job-1: running")
  mode = "malformed"
  await panel.getByRole("button", { name: "Cancel embedding job job-1", exact: true }).click()
  await expect(panel.getByRole("alert")).toContainText("was not acknowledged")
  await expect(panel).not.toContainText("Job cancellation requested.")
  await expect(panel).toContainText("Job job-1: running")
})
