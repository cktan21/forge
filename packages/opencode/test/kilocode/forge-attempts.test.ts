import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { store } from "@kilocode/forge/store"
import { source } from "@kilocode/forge/parse"
import { register, start } from "../../src/kilocode/forge/trace"

async function fixture() {
  const db = new Database(":memory:")
  const storage = store({
    all: async (query) => db.query<Record<string, unknown>, (string | number | null)[]>(query.text).all(...query.values ?? []),
    batch: async (queries) => { db.transaction(() => { for (const query of queries) db.query(query.text).run(...query.values ?? []) })() },
  })
  const root = `/forge-attempts-${crypto.randomUUID()}`
  const item = source("queue.ts", "export const queue = 'retained request evidence'", "code")
  await storage.replace({ root, generation: "fixture", revision: "", observed: 0, sources: [item], relations: [], files: 1, warnings: [], partial: false })
  const off = register(root, storage)
  const trace = (await start({ root, session: "chat", purpose: "coding", model: "fixture", system: [], messages: [{ role: "user", content: `[${item.id}]\n${item.text}` }] }))!
  return {
    db, storage, root, item, trace,
    read: async () => (await storage.request(root, "chat", trace.id))!,
    async [Symbol.asyncDispose]() { off(); db.close() },
  }
}

test("HTTP retries preserve independent membership and failures without rewriting earlier attempts", async () => {
  await using f = await fixture()
  const server = Bun.serve({ port: 0, fetch: async (request) => {
    await request.text()
    return new Response("fixture", { status: new URL(request.url).pathname === "/fail" ? 503 : 200 })
  } })
  try {
    const fetcher = f.trace.fetch(fetch)
    expect((await fetcher(new URL("/fail", server.url), { method: "POST", body: f.item.text })).status).toBe(503)
    const failed = (await f.read()).attempts!.at(0)!
    expect(failed).toMatchObject({ sequence: 1, state: "response", status: 503, membership: "matched" })
    expect(failed.sent).toContain(f.item.id)
    const revision = (await f.storage.latest(f.root, "chat", "coding"))!.revision
    await fetcher(server.url, { method: "POST", body: "Transformed second payload" })
    const current = await f.read()
    expect(current.attempts).toHaveLength(2)
    expect(current.attempts?.at(0)).toEqual(failed)
    expect(current.attempts?.at(1)?.sent).not.toContain(f.item.id)
    expect(current.entries.find((entry) => entry.source === f.item.id)?.stage).toBe("assembled")
    expect((await f.storage.latest(f.root, "chat", "coding"))!.revision).not.toBe(revision)
    await f.trace.finish({ input: 10 }, true)
    expect((await f.read()).attempts).toEqual(current.attempts)
    expect((await f.read()).state).toBe("failed")
  } finally { await server.stop(true) }
})

test("reverse completion order cannot overwrite the latest started attempt's projection", async () => {
  await using f = await fixture()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const server = Bun.serve({ port: 0, fetch: async (request) => {
    await request.text()
    if (new URL(request.url).pathname === "/slow") { entered.resolve(); await release.promise }
    return new Response("ok")
  } })
  try {
    const pending = f.trace.fetch(fetch)(new URL("/slow", server.url), { method: "POST", body: f.item.text })
    await entered.promise
    expect((await f.read()).attempts?.at(0)?.state).toBe("pending")
    await f.trace.fetch(fetch)(server.url, { method: "POST", body: "Different second attempt" })
    const second = (await f.read()).attempts?.at(1)
    release.resolve()
    await pending
    const value = await f.read()
    expect(value.attempts?.at(1)).toEqual(second)
    expect(value.attempts?.at(0)?.sent).toContain(f.item.id)
    expect(value.entries.find((entry) => entry.source === f.item.id)?.stage).toBe("assembled")
    expect(new Set(value.attempts?.map((item) => item.id)).size).toBe(2)
  } finally { release.resolve(); await server.stop(true) }
})

test("network failures remain unknown, policy blocks remain unsent, and history is bounded", async () => {
  await using f = await fixture()
  const server = Bun.serve({ port: 0, fetch: () => new Response("ok") })
  const url = server.url
  await server.stop(true)
  await expect(f.trace.fetch(fetch)(url, { method: "POST", body: f.item.text })).rejects.toThrow()
  expect((await f.read()).attempts?.at(0)).toMatchObject({ state: "error", membership: "unknown", sent: [] })
  await f.storage.policySave(f.root, { version: "blocked", session: "chat", pin: [], exclude: [f.item.id] })
  for (let index = 0; index < 34; index++) {
    await expect(f.trace.fetch(fetch)(url, { method: "POST", body: f.item.text })).rejects.toThrow("excluded")
  }
  const value = await f.read()
  expect(value.attempts).toHaveLength(32)
  expect(value.discarded).toBe(3)
  expect(value.attempts?.at(0)?.sequence).toBe(4)
  expect(value.attempts?.at(-1)?.sequence).toBe(35)
  expect(value.attempts?.every((item) => item.state === "blocked" && item.sent.length === 0)).toBe(true)
  expect(value.coverage).toHaveLength(2)
  expect(value.entries.every((entry) => entry.stage === "assembled")).toBe(true)
})

test("non-text payloads record response status without inventing excerpt membership", async () => {
  await using f = await fixture()
  const server = Bun.serve({ port: 0, fetch: async (request) => { await request.text(); return new Response("no", { status: 400 }) } })
  try {
    await f.trace.fetch(fetch)(server.url, { method: "POST", body: new Blob([f.item.text]) })
    const value = await f.read()
    expect(value.state).toBe("failed")
    expect(value.attempts?.at(0)).toMatchObject({ state: "response", status: 400, membership: "unknown", sent: [] })
  } finally { await server.stop(true) }
})
