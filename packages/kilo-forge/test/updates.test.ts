import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { store } from "../src/store"
import { knowledge } from "../src/knowledge"
import { notice, updates } from "../src/updates"
import { stream } from "../src/stream"
import { usage, type Change } from "../src/schema"

test("change notices follow committed writes and never contain source content", async () => {
  const db = new Database(":memory:")
  let fail = false
  const storage = store({
    all: async (query) => db.query<Record<string, unknown>, (string | number | null)[]>(query.text).all(...query.values ?? []),
    batch: async (queries) => {
      if (fail) throw new Error("write failed")
      db.transaction(() => { for (const query of queries) db.query(query.text).run(...query.values ?? []) })()
    },
  })
  const changes: Change[] = []
  const progress: string[] = []
  const foreign: Change[] = []
  const off = storage.subscribe("/one", (change) => {
    expect(db.query("SELECT count(*) AS n FROM forge_records").get()).toBeDefined()
    const rows = db.query<{ stage: string }, []>("SELECT json_extract(body, '$.progress.stage') AS stage FROM forge_records WHERE kind = 'collection' AND json_extract(body, '$.progress.stage') IS NOT NULL").all()
    progress.push(...rows.map((row) => row.stage))
    changes.push(change)
  })
  const other = storage.subscribe("/two", (change) => foreign.push(change))
  const library = knowledge("/one", storage)
  try {
    const item = await library.register({ kind: "text", label: "Private canary", location: "", session: "chat", content: "Private document canary passage." })
    await library.approve(item.id, "chat")
    await library.index(item.id, "chat")
    expect(progress).toContain("discover")
    expect(progress).toContain("extract")
    expect(progress).toContain("publish")
    expect((await storage.collection("/one", item.id))?.progress).toBeUndefined()
    await storage.policySave("/one", { session: "chat", version: "one", pin: [], exclude: [] })
    await storage.manifest({ root: "/one", id: "request", session: "chat", generation: "one", purpose: "coding", model: "none", observed: Date.now(), entries: [], coverage: [], usage: usage(), state: "assembled" })
    expect(changes.map((item) => item.topic)).toContain("policy")
    expect(changes.map((item) => item.topic)).toContain("request")
    expect(changes.every((item) => item.session === "chat")).toBe(true)
    expect(JSON.stringify(changes)).not.toContain("canary")
    expect(new Set(changes.map((item) => item.revision)).size).toBe(changes.length)
    expect(foreign).toEqual([])
    const count = changes.length
    fail = true
    await expect(storage.policySave("/one", { session: "", version: "failed", pin: [], exclude: [] })).rejects.toThrow("write failed")
    expect(changes).toHaveLength(count)
    fail = false
    await library.purge(item.id, "chat")
    expect(changes.at(-1)?.topic).toBe("invalidate")
    expect(changes.at(-1)?.session).toBe("")
    off()
    const stopped = changes.length
    await storage.policySave("/one", { session: "", version: "two", pin: [], exclude: [] })
    expect(changes).toHaveLength(stopped)
  } finally { off(); other(); library.dispose(); db.close() }
})

test("view notices isolate sessions, directories, and workspaces", () => {
  const scope = { directory: "/one", workspace: "first", session: "chat" }
  const payload = { type: "forge.changed", properties: { topic: "knowledge", session: "chat", revision: "one" } }
  expect(notice({ directory: "/one", workspace: "first", payload }, scope, true)).toBe(true)
  expect(notice({ directory: "/two", workspace: "first", payload }, scope, true)).toBe(false)
  expect(notice({ directory: "/one", workspace: "second", payload }, scope, true)).toBe(false)
  expect(notice({ ...payload, properties: { ...payload.properties, session: "other" } }, scope)).toBe(false)
  expect(notice({ ...payload, properties: { ...payload.properties, session: "" } }, scope)).toBe(true)
  expect(notice({ payload: { type: "server.connected" } }, scope, true)).toBe(true)
  expect(notice({ type: "server.heartbeat" }, scope)).toBe(false)
  expect(notice({ type: "forge.changed" }, scope)).toBe(false)
  const indexing = { type: "indexing.status", properties: { status: { state: "Disabled" } } }
  expect(notice(indexing, scope)).toBe(true)
  expect(notice({ directory: "/one", workspace: "first", payload: indexing }, scope, true)).toBe(true)
  expect(notice({ directory: "/two", workspace: "first", payload: indexing }, scope, true)).toBe(false)
  expect(notice({ directory: "/one", workspace: "second", payload: indexing }, scope, true)).toBe(false)
})

test("update coalescing retains changes during reads and cancels pending work", async () => {
  const controller = new AbortController()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const second = Promise.withResolvers<void>()
  const errors: unknown[] = []
  let calls = 0
  const refresh = updates({ signal: controller.signal, delay: 1, error: (err) => errors.push(err), load: async () => {
    calls++
    if (calls === 1) { entered.resolve(); await release.promise; return }
    second.resolve()
  } })
  for (let i = 0; i < 100; i++) refresh()
  await entered.promise
  for (let i = 0; i < 100; i++) refresh()
  expect(calls).toBe(1)
  release.resolve()
  await second.promise
  expect(calls).toBe(2)
  refresh()
  controller.abort()
  await Bun.sleep(20)
  expect(calls).toBe(2)
  expect(errors).toEqual([])
})

test("SDK event stream authenticates, filters sessions, reconnects, and aborts", async () => {
  const controller = new AbortController()
  const second = Promise.withResolvers<void>()
  const requests: URL[] = []
  let refreshes = 0
  const server = Bun.serve({ port: 0, fetch: (request) => {
    expect(request.headers.get("authorization")).toBe("Bearer fixture")
    requests.push(new URL(request.url))
    const frames = [
      { type: "server.connected", properties: {} },
      { type: "forge.changed", properties: { session: "other" } },
      { type: "forge.changed", properties: { session: "chat" } },
      { type: "server.heartbeat", properties: {} },
    ]
    if (requests.length === 2) second.resolve()
    return new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } })
  } })
  try {
    const running = stream({ url: server.url.toString(), directory: "/one", workspace: "first", session: "chat", headers: { Authorization: "Bearer fixture" }, signal: controller.signal, refresh: () => { refreshes++ }, connected: () => undefined, error: (err) => { throw err } })
    await second.promise
    controller.abort()
    await running
    expect(requests).toHaveLength(2)
    expect(requests.every((url) => url.pathname === "/event" && url.searchParams.get("directory") === "/one" && url.searchParams.get("workspace") === "first")).toBe(true)
    expect(refreshes).toBeGreaterThanOrEqual(2)
    expect(refreshes).toBeLessThanOrEqual(4)
  } finally { controller.abort(); await server.stop(true) }
}, 10_000)
