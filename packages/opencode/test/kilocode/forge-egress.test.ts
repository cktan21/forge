import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { store } from "@kilocode/forge/store"
import { knowledge } from "@kilocode/forge/knowledge"
import { register, start, transport } from "../../src/kilocode/forge/trace"
import { Effect } from "effect"
import { generateText } from "ai"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Provider } from "@/provider/provider"
import * as Config from "@/config/config"
import { Env } from "@/env"
import { Plugin } from "@/plugin"
import { testEffect } from "../lib/effect"
import { reconcile } from "@kilocode/forge/model-accounting"
import { oauth } from "./fixture/forge-oauth"

async function fixture(retry = false) {
  const received: Array<{ path: string; body: string; header: string | null }> = []
  const leaked: string[] = []
  const other = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    leaked.push(await request.text())
    return Response.json({ ok: true })
  } })
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname
    received.push({ path, body: await request.text(), header: request.headers.get("x-probe") })
    if (path.startsWith("/redirect/")) return new Response(null, {
      status: Number(path.split("/").at(-1)),
      headers: { Location: other.url.href },
    })
    if (path === "/relative") return new Response(null, { status: 307, headers: { Location: "/final" } })
    if (retry && received.length === 1 && path === "/v1/chat/completions") return Response.json({ error: { message: "Retry local fixture", type: "server_error" } }, { status: 503 })
    if (path === "/v1/chat/completions") return Response.json({
      id: "fixture", created: 1, model: "model", object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: "local fixture" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    })
    return Response.json({ ok: true })
  } })
  const db = new Database(":memory:")
  const storage = store({
    all: async (query) => db.query<Record<string, unknown>, (string | number | null)[]>(query.text).all(...query.values ?? []),
    batch: async (queries) => { db.transaction(() => { for (const query of queries) db.query(query.text).run(...query.values ?? []) })() },
  })
  const root = `/forge-egress-${server.port}`
  const route = { fingerprint: "reviewed-fixture", origins: [server.url.origin] }
  const destination = async () => ({ ...route, origins: [...route.origins] })
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let held = false
  const access = async () => { if (held) { entered.resolve(); await release.promise } }
  const library = knowledge(root, storage, { destination, authorize: access })
  const off = register(root, storage, access, destination)
  const collection = await library.register({ kind: "text", label: "Private", location: "", content: "Registered canary must not cross unreviewed origins." })
  await library.approve(collection.id, "", ["approved"], { approved: route.fingerprint })
  await library.index(collection.id)
  const item = (await storage.knowledge(root)).find((item) => item.method === "collection-section")!
  const input = { root, model: "approved/model", purpose: "coding", system: [], messages: [`[${item.id}]\n${item.text}`] }
  const trace = (await start(input))!
  return {
    trace, server, other, received, leaked, route, input, storage,
    body: JSON.stringify(input.messages),
    hold() { held = true },
    entered: entered.promise,
    release: release.resolve,
    async [Symbol.asyncDispose]() {
      release.resolve()
      off()
      await library.dispose()
      await Promise.all([server.stop(true), other.stop(true)])
      db.close()
    },
  }
}

test.each(["string", "url", "request", "context"] as const)("reviewed origin receives protected %s requests", async (mode) => {
  await using f = await fixture()
  const url = new URL("/accepted", f.server.url)
  const init = { method: "POST", body: f.body, headers: { "x-probe": "original" } }
  const response = mode === "context"
    ? await f.trace.run(() => transport(fetch)(url, init))
    : await f.trace.fetch(fetch)(mode === "request" ? new Request(url, init) : mode === "string" ? url.href : url, mode === "request" ? undefined : init)
  expect(response.ok).toBe(true)
  expect(f.received).toEqual([{ path: "/accepted", body: f.body, header: "original" }])
  expect(f.leaked).toEqual([])
  expect((await f.storage.manifests(f.input.root)).at(0)?.state).toBe("sent")
})

test.each(["different-port", "different-host", "credentials", "scheme", "empty-origins"] as const)("rejects %s before sending any evidence", async (mode) => {
  await using f = await fixture()
  const url = new URL(f.other.url)
  if (mode === "different-host") { url.port = String(f.server.port); url.hostname = "localhost" }
  if (mode === "credentials") { url.port = String(f.server.port); url.username = "credential-canary" }
  if (mode === "scheme") url.protocol = "ftp:"
  if (mode === "empty-origins") {
    f.route.origins.length = 0
    const trace = (await start(f.input))!
    await expect(trace.fetch(fetch)(f.server.url, { method: "POST", body: f.body })).rejects.toThrow("no reviewed")
  } else await expect(f.trace.fetch(fetch)(url, { method: "POST", body: f.body })).rejects.toThrow("outside")
  expect(f.received).toEqual([])
  expect(f.leaked).toEqual([])
})

test.each([301, 302, 303, 307, 308])("does not follow HTTP %s to another origin", async (status) => {
  await using f = await fixture()
  await expect(f.trace.fetch(fetch)(new URL(`/redirect/${status}`, f.server.url), { method: "POST", body: f.body, redirect: "follow" })).rejects.toThrow()
  expect(f.received).toHaveLength(1)
  expect(f.leaked).toEqual([])
})

test("same-origin redirects also require an explicit final endpoint", async () => {
  await using f = await fixture()
  await expect(f.trace.fetch(fetch)(new Request(new URL("/relative", f.server.url), { method: "POST", body: f.body, redirect: "follow" }))).rejects.toThrow()
  expect(f.received.map((item) => item.path)).toEqual(["/relative"])
})

test("custom fetch cannot rewrite a protected destination but ordinary requests retain overrides", async () => {
  await using f = await fixture()
  const custom = Object.assign((_url: RequestInfo | URL, init?: RequestInit) => fetch(f.other.url, init), { preconnect: fetch.preconnect }) as typeof fetch
  await expect(f.trace.fetch(custom)(f.server.url, { method: "POST", body: f.body })).rejects.toThrow("custom fetch")
  expect(f.leaked).toEqual([])
  const ordinary = (await start({ ...f.input, messages: ["ordinary"] }))!
  expect((await ordinary.fetch(custom)(f.server.url, { method: "POST", body: "ordinary" })).ok).toBe(true)
  expect(f.leaked).toEqual(["ordinary"])
})

test.each([false, true])("built-in OAuth captures the final HTTP hop (registered=%s)", async (registered) => {
  await using f = await fixture()
  const adapter = await oauth(new URL("/accepted", f.server.url).href)
  const trace = registered ? f.trace : (await start({ ...f.input, messages: ["ordinary"] }))!
  const body = registered ? f.body : "ordinary"
  const response = await trace.run(() => transport(adapter.fetch)("https://api.openai.com/v1/responses", {
    method: "POST", body, headers: { "x-probe": "original" },
  }))
  expect(response.status).toBe(200)
  expect(f.received).toEqual([{ path: "/accepted", body, header: "original" }])
  expect(f.leaked).toEqual([])
  const manifest = await f.storage.request(f.input.root, "", trace.id)
  expect(manifest?.attempts).toHaveLength(1)
  expect(manifest?.attempts?.at(0)?.status).toBe(200)
})

test("built-in OAuth cannot send registered evidence to an unreviewed final origin", async () => {
  await using f = await fixture()
  const adapter = await oauth(new URL("/responses", f.other.url).href)
  const error = await f.trace.run(() => transport(adapter.fetch)("https://api.openai.com/v1/responses", {
    method: "POST", body: f.body,
  })).catch((err: unknown) => err)
  expect(error).toBeInstanceOf(Error)
  expect(error instanceof Error && error.message).toContain("outside")
  expect(f.received).toEqual([])
  expect(f.leaked).toEqual([])
  expect((await f.storage.request(f.input.root, "", f.trace.id))?.attempts?.at(0)?.state).toBe("blocked")
})

test("built-in OAuth retains redirect rejection at the final native HTTP hop", async () => {
  await using f = await fixture()
  const adapter = await oauth(new URL("/redirect/307", f.server.url).href)
  const error = await f.trace.run(() => transport(adapter.fetch)("https://api.openai.com/v1/responses", {
    method: "POST", body: f.body, redirect: "follow",
  })).catch((err: unknown) => err)
  expect(error).toBeInstanceOf(Error)
  expect(f.received.map((item) => item.path)).toEqual(["/redirect/307"])
  expect(f.leaked).toEqual([])
})

test.each(["proxy", "unix", "tls", "connect", "dispatcher", "agent", "host"] as const)("rejects request-specific %s transport overrides", async (key) => {
  await using f = await fixture()
  const init = { method: "POST", body: f.body, ...(key === "host" ? { headers: { Host: "other.example" } } : { [key]: key === "tls" ? { rejectUnauthorized: false } : f.other.url.href }) }
  await expect(f.trace.fetch(fetch)(f.server.url, init)).rejects.toThrow(/override/i)
  expect(f.received).toEqual([])
  expect(f.leaked).toEqual([])
})

test.each(["immediately", "during authorization"] as const)("caller mutation %s cannot change checked URL headers or body", async (when) => {
  await using f = await fixture()
  f.hold()
  const url = new URL("/original", f.server.url)
  const headers = new Headers({ "x-probe": "original" })
  const bytes = new TextEncoder().encode(f.body)
  const init = { method: "POST", body: bytes, headers, redirect: "error" as RequestRedirect }
  const pending = f.trace.fetch(fetch)(url, init)
  try {
    if (when === "during authorization") await f.entered
    url.port = String(f.other.port)
    url.pathname = "/changed"
    headers.set("x-probe", "changed")
    bytes.fill(120)
    init.redirect = "follow"
    f.release()
    expect((await pending).ok).toBe(true)
    expect(f.received).toEqual([{ path: "/original", header: "original", body: f.body }])
    expect(f.leaked).toEqual([])
  } finally { f.release(); await Promise.allSettled([pending]) }
})

const it = testEffect(LayerNode.compile(LayerNode.group([Provider.node, Config.node, Env.node, Plugin.node])))
it.instance("real provider SDK retries retain separate attempt IDs and response statuses", () => Effect.gen(function* () {
  const f = yield* Effect.acquireRelease(Effect.promise(() => fixture(true)), (f) => Effect.promise(() => f[Symbol.asyncDispose]()))
  yield* (yield* Config.Service).update({
    enabled_providers: ["probe"],
    provider: { probe: {
      npm: "@ai-sdk/openai-compatible",
      options: { baseURL: new URL("/v1", f.server.url).href, apiKey: "fixture" },
      models: { model: { name: "Local fixture", limit: { context: 32000, output: 1000 } } },
    } },
  })
  const provider = yield* Provider.Service
  const model = yield* provider.getModel(ProviderV2.ID.make("probe"), ModelV2.ID.make("model"))
  const language = yield* provider.getLanguage(model)
  yield* Effect.promise(async () => {
    const result = await f.trace.run(() => generateText({ model: language, prompt: f.input.messages.join("\n"), maxRetries: 1 }))
    expect(result.text).toBe("local fixture")
    const manifest = (await f.storage.request(f.input.root, "", f.trace.id))!
    expect(manifest.attempts?.map((item) => item.status)).toEqual([503, 200])
    expect(manifest.attempts?.at(0)?.response?.usage).toBeUndefined()
    expect(manifest.attempts?.at(1)?.response).toMatchObject({
      state: "completed", usage: { format: "openai-chat", input: 10, output: 2, total: 12 },
    })
    await f.trace.finish({ input: 10, output: 2, measured: true })
    expect(reconcile((await f.storage.request(f.input.root, "", f.trace.id))!)).toMatchObject({
      complete: false, unknown: 1, usage: { input: 10, output: 2 },
    })
    expect(new Set(manifest.attempts?.map((item) => item.id)).size).toBe(2)
    expect(manifest.attempts?.every((item) => item.sent.length > 0)).toBe(true)
    expect(f.received).toHaveLength(2)
    expect(f.leaked).toEqual([])
  })
}), { config: { enabled_providers: ["probe"] } }, 30_000)
for (const allowed of [true, false]) {
  it.instance(`real provider SDK enforces reviewed origin (allowed=${allowed})`, () => Effect.gen(function* () {
    const f = yield* Effect.acquireRelease(Effect.promise(() => fixture()), (f) => Effect.promise(() => f[Symbol.asyncDispose]()))
    const config = yield* Config.Service
    yield* config.update({
      enabled_providers: ["probe"],
      provider: { probe: {
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: new URL("/v1", allowed ? f.server.url : f.other.url).href, apiKey: "fixture" },
        models: { model: { name: "Local fixture", limit: { context: 32000, output: 1000 } } },
      } },
    })
    const provider = yield* Provider.Service
    const model = yield* provider.getModel(ProviderV2.ID.make("probe"), ModelV2.ID.make("model"))
    const language = yield* provider.getLanguage(model)
    yield* Effect.promise(async () => {
      const pending = f.trace.run(() => generateText({ model: language, prompt: f.input.messages.join("\n"), maxRetries: 0 }))
      if (allowed) {
        expect((await pending).text).toBe("local fixture")
        expect(f.received).toHaveLength(1)
        expect(f.received.at(0)?.body).toContain("Registered canary")
      } else {
        await expect(pending).rejects.toThrow("outside")
        expect(f.received).toEqual([])
      }
      expect(f.leaked).toEqual([])
    })
  }), { config: { enabled_providers: ["probe"] } })
}

test("derived investigation summaries inherit source sharing and reviewed-origin restrictions", async () => {
  await using f = await fixture()
  const sources = (await f.storage.knowledge(f.input.root)).filter((item) => item.method === "collection-section")
  const input = { ...f.input, purpose: "investigate", messages: ["A concise derived summary without raw passages or textual source markers."], dependencies: sources }
  const trace = (await start(input))!
  await expect(trace.fetch(fetch)(f.other.url, { method: "POST", body: JSON.stringify(input.messages) })).rejects.toThrow("outside")
  expect(f.leaked).toEqual([])
  expect(f.received).toEqual([])
  const approved = (await start(input))!
  expect((await approved.fetch(fetch)(f.server.url, { method: "POST", body: JSON.stringify(input.messages) })).status).toBe(200)
  const policy = await f.storage.policy(f.input.root)
  await f.storage.policySave(f.input.root, { ...policy, version: "revoked", exclude: sources.map((item) => item.id) })
  await expect(start(input)).rejects.toThrow("excluded")
})

test("a final investigation dependency check can block transmission after capture", async () => {
  await using f = await fixture()
  let valid = true
  const trace = (await start({ ...f.input, check: async () => { if (!valid) throw new Error("Evidence changed before transmission") } }))!
  valid = false
  await expect(trace.fetch(fetch)(f.server.url, { method: "POST", body: f.body })).rejects.toThrow("Evidence changed")
  expect(f.received).toEqual([])
  expect(f.leaked).toEqual([])
})
