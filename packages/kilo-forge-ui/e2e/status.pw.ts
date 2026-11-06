import { expect, test, type Page, type Route } from "@playwright/test"
import { createServer, type Server } from "node:http"
import { readFile } from "node:fs/promises"

let server: Server
let base: string
test.beforeAll(async () => {
  // Serve the final UI bundle, with only API responses replaced by route fixtures.
  server = createServer(async (request, response) => {
    const pathname = new URL(request.url!, "http://localhost").pathname
    const asset = pathname.startsWith("/forge/assets/") ? `assets/${pathname.split("/").at(-1)}` : "index.html"
    try {
      const body = await readFile(new URL(`../dist/${asset}`, import.meta.url))
      response.writeHead(200, { "Content-Type": asset.endsWith(".js") ? "text/javascript" : asset.endsWith(".css") ? "text/css" : "text/html" })
      response.end(body)
    } catch (err) {
      response.writeHead(500)
      response.end(String(err))
    }
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Missing fixture listener")
  base = `http://127.0.0.1:${address.port}`
})
test.afterAll(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()))
})

type Observation = { started?: number; useful?: number; timers: Set<number>; aborted: number }
declare global {
  interface Window { observation: Observation }
}

async function fixture(page: Page) {
  const calls: { path: string; method: string; session: string }[] = []
  const pending: { route: Route; release: ReturnType<typeof Promise.withResolvers<void>>; done: ReturnType<typeof Promise.withResolvers<void>>; generation: string; error: boolean }[] = []
  let generation = "old"
  await page.addInitScript(() => {
    const state: Observation = { timers: new Set(), aborted: 0 }
    const fetch = window.fetch.bind(window)
    const interval = window.setInterval.bind(window)
    const clear = window.clearInterval.bind(window)
    // These execute in Chromium, not the Bun/Node timer environment of the runner.
    Object.assign(window, {
      observation: state,
      fetch: (input: RequestInfo | URL, init?: RequestInit) => {
        if (new URL(input instanceof Request ? input.url : input, window.location.href).pathname === "/forge/status") {
          state.started ??= performance.now()
          init?.signal?.addEventListener("abort", () => state.aborted++, { once: true })
        }
        return fetch(input, init)
      },
      setInterval: (handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
        const id = interval(handler, timeout, ...args)
        if (timeout === 1000) state.timers.add(id)
        return id
      },
      clearInterval: (id?: number) => { state.timers.delete(id!); clear(id) },
    })
    const observer = new MutationObserver(() => {
      const region = document.querySelector('[aria-label="Inventory status"]')
      if (state.useful != null || !region?.textContent?.includes("Backend progress is not observed.")) return
      requestAnimationFrame(() => { state.useful ??= performance.now(); observer.disconnect() })
    })
    observer.observe(document, { childList: true, subtree: true })
  })
  await page.route("**/event?**", (route) => route.fulfill({ status: 200, contentType: "text/event-stream", body: "" }))
  await page.route(/\/forge\/(status|view|requests|policy|knowledge)(?:\?|$)/, async (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname.split("/").at(-1)!
    const session = url.searchParams.get("session") ?? ""
    calls.push({ path, method: route.request().method(), session })
    if (path === "status") {
      const item = { route, release: Promise.withResolvers<void>(), done: Promise.withResolvers<void>(), generation: "loaded", error: false }
      pending.push(item)
      await item.release.promise
      try {
        await route.fulfill(item.error ? { status: 503, json: { message: "Status unavailable" } } : { json: {
          inventory: { root: "/fixture", generation: item.generation, counts: { file: 17 }, files: 17, warnings: [], indexed: true },
          session, job: { state: "idle", message: "Ready" }, semantic: { state: "disabled", searchable: false },
        } })
      } finally { item.done.resolve() }
      return
    }
    return route.fulfill({ json: path === "view" ? {
      root: "/fixture", generation, files: 17, relations: [], warnings: [], page: { offset: 0, limit: 100 },
      sources: [{ id: generation, root: "/fixture", kind: "file", uri: `${generation}.ts`, label: `${generation} source`, status: "current", hash: generation, detail: {}, evidence: [], observed: 1, start: 1, end: 1 }],
    } : path === "requests" ? [] : path === "policy" ? { version: "fixture", session, pin: [], exclude: [] }
      : { collections: [], provider: "", generation: "fixture", page: { offset: 0, limit: 10 } } })
  })
  return {
    calls, pending,
    async open(session = "chat") {
      await page.goto(`${base}/forge/?directory=/fixture&session=${session}`, { waitUntil: "domcontentloaded" })
      await expect(page.getByRole("region", { name: "Inventory status" })).toContainText("Waiting for saved inventory status")
    },
    async respond(index: number, value = "loaded", error = false) {
      const item = pending.at(index)!
      generation = value
      item.generation = value
      item.error = error
      item.release.resolve()
      await item.done.promise
    },
    async observation() {
      return page.evaluate(() => {
        const state = window.observation
        return { elapsed: state.useful! - state.started!, timers: state.timers.size, aborted: state.aborted }
      })
    },
  }
}

async function key(page: Page, name: string) {
  const button = page.getByRole("button", { name, exact: true })
  // Use only keyboard traversal and activation, including controls below the fold.
  for (let index = 0; index < 100; index++) {
    if (await button.evaluate((element) => element === document.activeElement)) { await page.keyboard.press("Enter"); return }
    await page.keyboard.press("Tab")
  }
  throw new Error(`Keyboard could not reach ${name}`)
}

test("held cold status paints useful waiting under 500ms; local elapsed stops on success", async ({ page }) => {
  const ui = await fixture(page)
  await ui.open()
  const region = page.getByRole("region", { name: "Inventory status" })
  await expect(region).toContainText("0s elapsed")
  await expect(region).toContainText("Saved inventory unknown until the status response arrives.")
  await expect(region).toContainText("Request waiting may include local initialization or recovery.")
  await expect(region).toContainText("Backend progress is not observed.")
  await expect(region).toContainText("Inspection starts no model call or scan.")
  await expect(page.locator("main")).not.toContainText("Available inventory: 0")
  await expect.poll(async () => (await ui.observation()).elapsed).toBeGreaterThanOrEqual(0)
  const observed = await ui.observation()
  expect(observed.elapsed).toBeLessThan(500)
  console.log(`Task31 browser cold useful wait: ${observed.elapsed.toFixed(2)}ms`)
  await expect(region).toContainText("1s elapsed")
  expect(ui.calls.filter((call) => call.path === "status")).toHaveLength(1)
  expect(ui.calls.every((call) => call.method === "GET")).toBe(true)
  await ui.respond(0)
  await expect(page.locator("main")).toContainText("Available inventory: 17 sources")
  await expect(region).not.toContainText("Waiting for")
  await expect(region).not.toContainText("unknown")
  expect((await ui.observation()).timers).toBe(0)
})

test("keyboard cancel, held retry, failure and retry success reject a late status", async ({ page }) => {
  const ui = await fixture(page)
  await ui.open()
  const region = page.getByRole("region", { name: "Inventory status" })
  await key(page, "Cancel status wait")
  await expect(region).toContainText("Status wait cancelled locally")
  expect((await ui.observation()).aborted).toBe(1)
  expect((await ui.observation()).timers).toBe(0)
  await key(page, "Reload view")
  await expect.poll(() => ui.pending.length).toBe(2)
  await ui.respond(1, "failed", true)
  await expect(page.getByRole("alert")).toContainText("Status unavailable")
  await expect(region).toContainText("Saved inventory unknown")
  await expect(region).not.toContainText("Waiting for")
  await key(page, "Reload view")
  await expect.poll(() => ui.pending.length).toBe(3)
  await ui.respond(2, "new")
  await expect(page.locator("main")).toContainText("Last observed generation: new")
  await ui.respond(0, "stale")
  await expect(page.locator("main")).not.toContainText("Last observed generation: stale")
  await expect(page.getByRole("alert")).toHaveCount(0)
  expect(ui.calls.every((call) => call.method === "GET")).toBe(true)
})

test("keyboard close aborts the held status and removes its local timer", async ({ page }) => {
  const ui = await fixture(page)
  await ui.open()
  await expect(page.getByRole("region", { name: "Inventory status" })).toContainText("1s elapsed")
  expect((await ui.observation()).timers).toBe(1)
  await key(page, "Close inspection")
  await expect(page.getByRole("status")).toContainText("Knowledge inspection closed")
  expect((await ui.observation()).aborted).toBe(1)
  expect((await ui.observation()).timers).toBe(0)
  await ui.respond(0)
  await expect(page.locator("main")).not.toContainText("Available inventory")
  expect(ui.calls.filter((call) => call.path === "view")).toHaveLength(0)
})

test("warm held refresh retains last observed sources and generation", async ({ page }) => {
  const ui = await fixture(page)
  await ui.open()
  await ui.respond(0, "old")
  await expect(page.locator("main")).toContainText("Last observed generation: old")
  await key(page, "Source table")
  await expect(page.getByRole("table")).toContainText("old.ts")
  await key(page, "Reload view")
  const region = page.getByRole("region", { name: "Inventory status" })
  await expect(region).toContainText("Refreshing saved inventory status")
  await expect(region).toContainText("generation old; refreshing")
  await expect(region).not.toContainText("Saved inventory unknown")
  await expect(page.getByRole("table")).toContainText("old.ts")
  await expect(page.getByRole("table")).toContainText("current; refreshing")
  await ui.respond(1, "new")
  await expect(page.getByRole("table")).toContainText("new.ts")
  await expect(page.getByRole("table")).not.toContainText("old.ts")
  await expect(region).not.toContainText("Refreshing")
})

test("new inventory keeps the old source page labelled through page loading and failure", async ({ page }) => {
  const ui = await fixture(page)
  await ui.open()
  await ui.respond(0, "old")
  await key(page, "Source table")
  await expect(page.getByRole("table")).toContainText("old.ts")
  const held = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  const handler = async (route: Route) => {
    entered.resolve()
    await held.promise
    await route.fulfill({ status: 503, json: { message: "Source page unavailable" } })
  }
  await page.route("**/forge/view?**", handler)
  try {
    await key(page, "Reload view")
    await expect.poll(() => ui.pending.length).toBe(2)
    await ui.respond(1, "new")
    await entered.promise
    await expect(page.locator("main")).toContainText("Last observed generation: new")
    await expect(page.locator("main")).toContainText("Source generation: old")
    await expect(page.getByRole("table")).toContainText("old.ts")
    await expect(page.getByRole("table")).toContainText("current; refreshing")
    held.resolve()
    await expect(page.getByRole("alert")).toContainText("Source page unavailable")
    await expect(page.getByRole("table")).toContainText("old.ts")
    await expect(page.getByRole("table")).toContainText("newer inventory observed")
    await page.unroute("**/forge/view?**", handler)
    await key(page, "Reload view")
    await expect.poll(() => ui.pending.length).toBe(3)
    await ui.respond(2, "new")
    await expect(page.getByRole("table")).toContainText("new.ts")
    await expect(page.getByRole("table")).not.toContainText("old.ts")
  } finally { held.resolve() }
})

test("navigation to another session does not accept a held previous-session response", async ({ page }) => {
  const ui = await fixture(page)
  await ui.open("first")
  await ui.open("second")
  expect(ui.pending).toHaveLength(2)
  await ui.respond(0, "foreign")
  await expect(page.getByRole("region", { name: "Inventory status" })).toContainText("Saved inventory unknown")
  await expect(page.locator("main")).not.toContainText("Last observed generation: foreign")
  await ui.respond(1, "own")
  await expect(page.locator("main")).toContainText("Session: second")
  await expect(page.locator("main")).toContainText("Last observed generation: own")
  expect(ui.calls.filter((call) => call.path === "view").map((call) => call.session)).toEqual(["second"])
})
