import { expect, test } from "bun:test"
import { rejects, throws } from "node:assert/strict"
import { embeddingHttp } from "../src/embedding-http"
import { account, summary, type Observation } from "../src/embedding-usage"

for (const [usage, expected] of [
  [undefined, {}],
  [null, {}],
  [{}, {}],
  [
    { prompt_tokens: 0, total_tokens: 0 },
    { prompt: 0, total: 0 },
  ],
  [
    { prompt_tokens: 12, total_tokens: 13, private: "secret" },
    { prompt: 12, total: 13 },
  ],
  [{ prompt_tokens: 5 }, { prompt: 5 }],
  [{ total_tokens: 8 }, { total: 8 }],
  [{ prompt_tokens: null, total_tokens: 8 }, { total: 8 }],
  [{ prompt_tokens: -1, total_tokens: 8 }, {}],
  [{ prompt_tokens: 1.5 }, {}],
  [{ total_tokens: "20" }, {}],
  [{ total_tokens: Number.MAX_SAFE_INTEGER + 1 }, {}],
  [{ prompt_tokens: 8, total_tokens: 7 }, {}],
  ["secret", {}],
  [[], {}],
] as const) {
  test(`transport reports only valid provider usage: ${JSON.stringify(usage)}`, async () => {
    const events: Observation[] = []
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => Response.json({ data: [{ index: 0, embedding: [1, 0] }], usage }),
    })
    try {
      const transport = embeddingHttp({ endpoint: `${server.url}embeddings`, model: "fixture", dimensions: 2 })
      expect(
        await transport.embed(["original"], undefined, async (event) => {
          events.push(event)
        }),
      ).toEqual([[1, 0]])
      expect(events).toEqual([
        {
          state: "attempt",
          inputs: 1,
          bytes: Buffer.byteLength(
            JSON.stringify({
              model: "fixture",
              input: ["original"],
              dimensions: 2,
              encoding_format: "float",
            }),
          ),
        },
        { state: "response", ...expected },
      ])
      expect(JSON.stringify(events)).not.toContain("secret")
    } finally {
      await server.stop(true)
    }
  })
}

test("usage admission is persisted before egress; failed admission prevents any request", async () => {
  let sends = 0
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      sends++
      return Response.json({ data: [{ index: 0, embedding: [1, 0] }] })
    },
  })
  try {
    const transport = embeddingHttp({ endpoint: `${server.url}embeddings`, model: "fixture", dimensions: 2 })
    await rejects(
      transport.embed(["original"], undefined, async () => {
        throw new Error("storage unavailable")
      }),
    )
    expect(sends).toBe(0)
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const controller = new AbortController()
    const events: Observation[] = []
    const pending = transport.embed(["original"], controller.signal, async (event) => {
      events.push(event)
      entered.resolve()
      await release.promise
    })
    await entered.promise
    expect(sends).toBe(0)
    controller.abort(new Error("cancelled"))
    release.resolve()
    await rejects(pending, /cancelled/)
    expect(sends).toBe(0)
    expect(events.map((event) => event.state)).toEqual(["attempt"])
  } finally {
    await server.stop(true)
  }
})

for (const mode of ["vectors", "json", "status"] as const) {
  test(`usage observes ${mode} failure without pretending billed usage is zero`, async () => {
    const events: Observation[] = []
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => {
        if (mode === "json") return new Response("secret-invalid")
        if (mode === "status") return Response.json({ usage: { total_tokens: 99 } }, { status: 429 })
        return Response.json({ data: [], usage: { total_tokens: 99 } })
      },
    })
    try {
      await rejects(
        embeddingHttp({ endpoint: `${server.url}embeddings`, model: "fixture", dimensions: 2 }).embed(
          ["original"],
          undefined,
          async (event) => {
            events.push(event)
          },
        ),
      )
      expect(events.at(1)).toEqual(mode === "vectors" ? { state: "response", total: 99 } : { state: "failed" })
      expect(events).toHaveLength(2)
      expect(JSON.stringify(events)).not.toContain("secret")
    } finally {
      await server.stop(true)
    }
  })
}

test("usage accumulation preserves explicit reports, pending attempts and safe integer bounds", () => {
  const empty = account(undefined, { state: "ready" })
  const started = account(empty, { state: "attempt", inputs: 2, bytes: 100 })
  const partial = account(started, { state: "response", prompt: 0 })
  expect(empty.attempts).toBe(0)
  expect(started.pending).toBe(1)
  expect(partial).toMatchObject({ promptReports: 1, promptTokens: 0, totalReports: 0, pending: 0 })
  throws(() => account(partial, { state: "failed" }), /no pending/)
  throws(() => account(started, { state: "attempt", inputs: -1, bytes: 5 }), /Invalid/)
  throws(() => account(started, { state: "response", total: -1 }), /Invalid/)
  throws(
    () =>
      account(
        { ...started, bytes: Number.MAX_SAFE_INTEGER },
        {
          state: "attempt",
          inputs: 1,
          bytes: 1,
        },
      ),
    /safe counter/,
  )
})

test("usage summaries distinguish unavailable, partial and zero-send records", () => {
  expect(summary()).toBe("Usage accounting unavailable for this job.")
  const empty = account(undefined, { state: "ready" })
  expect(summary(empty)).toContain("Locally admitted attempts: 0")
  expect(summary(empty)).toContain("Monetary cost unknown")
  const partial = account(account(empty, { state: "attempt", inputs: 1, bytes: 100 }), {
    state: "response",
    prompt: 0,
  })
  expect(summary(partial)).toContain("prompt-token subtotal: 0 from 1 reports; 0 attempts unknown")
  expect(summary(partial)).toContain("total-token subtotal: 0 from 0 reports; 1 attempts unknown")
  expect(summary({ ...partial, attempts: 99 })).toContain("inconsistent counters")
  expect(summary({ ...empty, totalTokens: 10 })).toContain("inconsistent counters")
})
