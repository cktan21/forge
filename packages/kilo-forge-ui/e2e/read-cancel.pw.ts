import { expect, test, type Page, type Route } from "@playwright/test"
import { usage, type Source } from "@kilocode/forge/schema"

const base = process.env.FORGE_TEST_URL ?? "http://127.0.0.1:4177"

async function fixture(page: Page) {
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
  const held: Array<{
    route: Route
    release: ReturnType<typeof Promise.withResolvers<boolean>>
    done: ReturnType<typeof Promise.withResolvers<void>>
  }> = []
  const failed: string[] = []
  const errors: string[] = []
  const unexpected: string[] = []
  let hold = ""
  let views = 0
  let generation = "fixed"
  page.on("pageerror", (err) => errors.push(err.message))
  page.on("requestfailed", (request) => failed.push(new URL(request.url()).pathname))
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
      url.searchParams.get("session") !== "read-cancel"
    ) {
      unexpected.push(url.href)
      return route.abort()
    }
    if (path === "/forge/view") views++
    if (path === hold) {
      hold = ""
      const item = { route, release: Promise.withResolvers<boolean>(), done: Promise.withResolvers<void>() }
      held.push(item)
      const error = await item.release.promise
      try {
        await route.fulfill(
          error
            ? { status: 503, json: { message: "Late obsolete read failed" } }
            : { json: path === "/forge/view" ? view(2) : sources.find((item) => item.id === path.split("/").at(-1)) },
        )
      } finally {
        item.done.resolve()
      }
      return
    }
    if (path.startsWith("/forge/source/"))
      return route.fulfill({ json: sources.find((item) => item.id === path.split("/").at(-1)) })
    if (path === "/forge/view") return route.fulfill({ json: view(Number(url.searchParams.get("offset") ?? 0)) })
    if (path === "/forge/status")
      return route.fulfill({
        json: {
          inventory: { root: "/fixture", generation, counts: { code: 3 }, files: 3, warnings: [], indexed: true },
          session: "read-cancel",
          job: { state: "idle", message: "Ready" },
        },
      })
    if (path === "/forge/requests")
      return route.fulfill({
        json: [
          {
            id: "history",
            root: "/fixture",
            session: "read-cancel",
            generation: "fixed",
            purpose: "enhance",
            model: "none",
            observed: 1,
            entries: [],
            coverage: [],
            usage: usage(),
            state: "completed",
          },
        ],
      })
    if (path === "/forge/policy")
      return route.fulfill({ json: { version: "fixed", session: "read-cancel", pin: [], exclude: [] } })
    if (path === "/forge/knowledge")
      return route.fulfill({
        json: { collections: [], provider: "", generation: "fixed", page: { offset: 0, limit: 10 } },
      })
    unexpected.push(url.href)
    return route.abort()
  })
  function view(offset: number) {
    return {
      root: "/fixture",
      generation,
      files: 3,
      warnings: [],
      relations: [],
      sources: sources.slice(offset, offset + 2),
      page: { offset, limit: 2, ...(offset ? {} : { next: 2 }) },
    }
  }
  await page.goto(`${base}/forge/?directory=/fixture&session=read-cancel`)
  await page.getByRole("button", { name: "Source table", exact: true }).click()
  await expect(page.getByRole("table").getByRole("button")).toHaveCount(2)
  return {
    held,
    failed,
    errors,
    unexpected,
    arm(path: string) {
      hold = path
    },
    views: () => views,
    async refresh(change: boolean) {
      if (change) generation = "changed"
      await page.route(
        "**/event?**",
        (route) =>
          route.fulfill({
            contentType: "text/event-stream",
            body: 'data: {"type":"server.connected","properties":{}}\n\n',
          }),
        { times: 1 },
      )
      const response = page.waitForResponse((response) => new URL(response.url()).pathname === "/forge/status")
      await page.evaluate(() => window.dispatchEvent(new Event("online")))
      await (await response).finished()
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
      )
    },
    async select(key: string) {
      await page
        .getByRole("table")
        .getByRole("button", { name: `${key}.ts · ${key}`, exact: true })
        .click()
    },
    async release(error: boolean) {
      held.at(0)!.release.resolve(error)
      await held.at(0)!.done.promise
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
      )
    },
    close() {
      for (const item of held) item.release.resolve(false)
    },
  }
}

for (const action of ["selection", "history", "page", "search", "reload", "cancel", "close"] as const) {
  for (const error of [false, true]) {
    test(`source ${action} aborts obsolete ${error ? "failure" : "success"} and keeps retries usable`, async ({
      page,
    }, info) => {
      const f = await fixture(page)
      try {
        f.arm("/forge/source/A")
        await f.select("A")
        await expect.poll(() => f.held.length).toBe(1)
        if (action === "selection") await f.select("B")
        if (action === "history") {
          await page.locator("#request").selectOption("history")
          await page.locator("#request").selectOption("")
        }
        if (action === "page") await page.getByRole("button", { name: "Next sources", exact: true }).click()
        if (action === "search") await page.getByRole("button", { name: "Search", exact: true }).click()
        if (action === "reload") await page.getByRole("button", { name: "Reload view", exact: true }).click()
        if (action === "cancel") {
          await expect(page.locator(".inspector").getByRole("status")).toContainText("Reading current source")
          await page.screenshot({ path: info.outputPath("reading.png"), fullPage: true })
          await page.getByRole("button", { name: "Cancel source read", exact: true }).click()
        }
        if (action === "close") await page.getByRole("button", { name: "Close inspection", exact: true }).click()
        if (action === "page") await expect(page.getByRole("table")).toContainText("C.ts")
        if (action === "close") await expect(page.getByRole("status")).toContainText("Knowledge inspection closed")
        await expect.poll(() => f.failed, { timeout: 1500 }).toContain("/forge/source/A")
        await f.release(error)
        await expect(page.getByRole("alert")).toHaveCount(0)
        await expect(page.getByRole("button", { name: "Cancel source read", exact: true })).toHaveCount(0)
        if (action === "selection") {
          await expect(page.locator(".inspector").getByRole("heading", { name: "B", exact: true })).toBeVisible()
          await expect(page.locator(".inspector pre")).toHaveText("Original B")
        }
        if (action !== "selection") {
          await expect(page.locator(".inspector pre")).toHaveCount(0)
          await expect(page.getByRole("button", { name: "Pin for preparation", exact: true })).toHaveCount(0)
        }
        if (action !== "close") {
          if (action === "page") await page.getByRole("button", { name: "Previous sources", exact: true }).click()
          await f.select("B")
          await expect(page.locator(".inspector pre")).toHaveText("Original B")
          await expect(page.getByRole("button", { name: "Pin for preparation", exact: true })).toBeEnabled()
        }
        await page.screenshot({ path: info.outputPath("source.png"), fullPage: true })
        expect(f.errors).toEqual([])
        expect(f.unexpected).toEqual([])
      } finally {
        f.close()
      }
    })
  }
}

for (const mode of ["source", "page"] as const) {
  for (const change of [false, true]) {
    test(`automatic refresh ${change ? "invalidates changed" : "preserves unchanged"} ${mode} reads`, async ({
      page,
    }) => {
      const f = await fixture(page)
      const path = mode === "source" ? "/forge/source/A" : "/forge/view"
      try {
        f.arm(path)
        if (mode === "source") await f.select("A")
        if (mode === "page") await page.getByRole("button", { name: "Next sources", exact: true }).click()
        await expect.poll(() => f.held.length).toBe(1)
        await f.refresh(change)
        if (change) await expect.poll(() => f.failed).toContain(path)
        if (!change) expect(f.failed).not.toContain(path)
        await f.release(false)
        await expect(page.getByRole("alert")).toHaveCount(0)
        if (change) {
          await expect(page.locator(".inspector pre")).toHaveCount(0)
          await expect(page.getByRole("table")).not.toContainText("C.ts")
        }
        if (!change && mode === "source") await expect(page.locator(".inspector pre")).toHaveText("Original A")
        if (!change && mode === "page") await expect(page.getByRole("table")).toContainText("C.ts")
        expect(f.errors).toEqual([])
        expect(f.unexpected).toEqual([])
      } finally {
        f.close()
      }
    })
  }
}

for (const error of [false, true]) {
  test(`pending source hides prior evidence and controls before ${error ? "failure" : "success"}`, async ({ page }) => {
    const f = await fixture(page)
    try {
      await f.select("A")
      await expect(page.locator(".inspector pre")).toHaveText("Original A")
      f.arm("/forge/source/B")
      await f.select("B")
      await expect.poll(() => f.held.length).toBe(1)
      await expect(page.locator(".inspector pre")).toHaveCount(0)
      await expect(page.getByRole("button", { name: "Pin for preparation", exact: true })).toHaveCount(0)
      await f.release(error)
      if (error) {
        await expect(page.getByRole("alert")).toHaveText("Late obsolete read failed")
        await expect(page.locator(".inspector pre")).toHaveCount(0)
      } else await expect(page.locator(".inspector pre")).toHaveText("Original B")
      expect(f.errors).toEqual([])
      expect(f.unexpected).toEqual([])
    } finally {
      f.close()
    }
  })
}

for (const action of ["search", "history", "close"] as const) {
  for (const error of [false, true]) {
    test(`page ${action} aborts obsolete ${error ? "failure" : "success"} without stale content or alerts`, async ({
      page,
    }, info) => {
      const f = await fixture(page)
      try {
        f.arm("/forge/view")
        await page.getByRole("button", { name: "Search", exact: true }).click()
        await expect.poll(() => f.held.length).toBe(1)
        if (action === "search") await page.getByRole("button", { name: "Search", exact: true }).click()
        if (action === "history") {
          await page.locator("#request").selectOption("history")
          await page.locator("#request").selectOption("")
        }
        if (action === "close") await page.getByRole("button", { name: "Close inspection", exact: true }).click()
        await expect.poll(() => f.failed, { timeout: 1500 }).toContain("/forge/view")
        await f.release(error)
        await expect(page.getByRole("alert")).toHaveCount(0)
        if (action !== "close") {
          await expect(page.getByRole("table")).not.toContainText("C.ts")
          await page.getByRole("button", { name: "Next sources", exact: true }).click()
          await expect(page.getByRole("table")).toContainText("C.ts")
          await f.select("C")
          await expect(page.locator(".inspector pre")).toHaveText("Original C")
        }
        await page.screenshot({ path: info.outputPath("page.png"), fullPage: true })
        expect(f.errors).toEqual([])
        expect(f.unexpected).toEqual([])
      } finally {
        f.close()
      }
    })
  }
}
