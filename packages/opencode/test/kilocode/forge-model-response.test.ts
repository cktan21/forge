import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { store } from "@kilocode/forge/store"
import { knowledge } from "@kilocode/forge/knowledge"
import { register, start } from "../../src/kilocode/forge/trace"

async function fixture() {
  const db = new Database(":memory:")
  const storage = store({
    all: async (query) =>
      db.query<Record<string, unknown>, (string | number | null)[]>(query.text).all(...(query.values ?? [])),
    batch: async (queries) =>
      db.transaction(() => {
        for (const query of queries) db.query(query.text).run(...(query.values ?? []))
      })(),
  })
  const root = `/forge-model-response-${crypto.randomUUID()}`
  const library = knowledge(root, storage)
  const collection = await library.register({
    kind: "text",
    label: "Purge fixture",
    location: "",
    content: "Local fixture",
  })
  const off = register(root, storage)
  const trace = (await start({
    root,
    session: "chat",
    purpose: "coding",
    model: "fixture/model",
    system: [],
    messages: [],
  }))!
  return {
    root,
    storage,
    trace,
    collection,
    read: () => storage.request(root, "chat", trace.id),
    async [Symbol.asyncDispose]() {
      off()
      await library.dispose()
      db.close()
    },
  }
}

test("trace retains independent consumed response usage without storing model output", async () => {
  await using f = await fixture()
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) =>
      Response.json(
        {
          object: "chat.completion",
          choices: [{ message: { content: "Private model output must not be retained by accounting" } }],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 2,
            total_tokens: 12,
            prompt_tokens_details: { cached_tokens: 3 },
          },
        },
        { status: new URL(request.url).pathname === "/failed" ? 503 : 200 },
      ),
  })
  try {
    const fetcher = f.trace.fetch(fetch)
    const failed = await fetcher(new URL("/failed", server.url))
    await failed.text()
    const success = await fetcher(server.url)
    expect(success.url).toBe(server.url.href)
    expect(success.headers.get("content-type")).toContain("application/json")
    expect((await success.json()).usage.total_tokens).toBe(12)
    await f.trace.finish({ input: 10, output: 2, cached: 3, measured: true })
    const value = (await f.read())!
    expect(value.state).toBe("completed")
    expect(value.attempts?.at(0)?.response?.usage).toBeUndefined()
    expect(value.attempts?.at(1)?.response).toMatchObject({
      state: "completed",
      usage: { format: "openai-chat", input: 10, output: 2, total: 12, cached: 3 },
    })
    expect(value.attempts?.at(1)?.response?.bytes).toBeGreaterThan(0)
    expect(JSON.stringify(value)).not.toContain("Private model output")
  } finally {
    await server.stop(true)
  }
})

test("trace sees split SSE usage once and never rewrites terminal manifest state", async () => {
  await using f = await fixture()
  const stream =
    'data: {"object":"chat.completion.chunk","usage":{"prompt_tokens":0,"completion_tokens":2,"total_tokens":2}}\r\n\r\ndata: [DONE]\r\n\r\n'
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (const part of [stream.slice(0, 18), stream.slice(18, 87), stream.slice(87)])
              controller.enqueue(new TextEncoder().encode(part))
            controller.close()
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  })
  try {
    const response = await f.trace.fetch(fetch)(server.url)
    await f.trace.finish({ input: 0, output: 2, measured: true })
    expect(await response.text()).toBe(stream)
    const value = (await f.read())!
    expect(value.state).toBe("completed")
    expect(value.attempts?.at(0)?.response).toMatchObject({
      state: "completed",
      bytes: Buffer.byteLength(stream),
      usage: { format: "openai-chat", input: 0, output: 2, total: 2 },
    })
  } finally {
    await server.stop(true)
  }
})

test("unread and cancelled model bodies stay unknown without eager reads", async () => {
  await using f = await fixture()
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.json({ object: "response", usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 } }),
  })
  try {
    const response = await f.trace.fetch(fetch)(server.url)
    expect((await f.read())?.attempts?.at(0)?.response).toMatchObject({ state: "pending", bytes: 0 })
    await response.body!.cancel()
    expect((await f.read())?.attempts?.at(0)?.response).toMatchObject({ state: "cancelled", bytes: 0 })
  } finally {
    await server.stop(true)
  }
})

test("purge prevents a delayed body observation from recreating captured history", async () => {
  await using f = await fixture()
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.json({ object: "response", usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 } }),
  })
  try {
    const response = await f.trace.fetch(fetch)(server.url)
    await f.storage.purge(f.root, f.collection.id)
    expect((await response.json()).usage.total_tokens).toBe(12)
    expect(await f.read()).toBeUndefined()
  } finally {
    await server.stop(true)
  }
})
