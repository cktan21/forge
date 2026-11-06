import { describe, expect, test } from "bun:test"
import { object } from "../src/output"
import { prepare } from "../src/preparation"
import { citations } from "../src/citations"
import { source } from "../src/parse"
import { monitor } from "../src/model-response"
import { decode, ModelResponse, type ModelUsage } from "../src/schema"

describe("output", () => {
  test.each([
    '{"objective":"Keep quotes \\"and braces }\\" intact","questions":[]}',
    '```json\n{"objective":"Keep quotes \\"and braces }\\" intact","questions":[]}\n```',
    'Here is the response:\n{"objective":"Keep quotes \\"and braces }\\" intact","questions":[],}\nDone.',
  ])("complete model JSON is decoded without changing string contents", (text) => {
    expect(object(text)).toEqual({ objective: 'Keep quotes "and braces }" intact', questions: [] })
  })

  test.each([
    '{"objective":"Incomplete',
    '{"objective":"Complete","questions":[{"kind":"blocking","question":"Delete?"}',
    '{"objective":"First"} {"objective":"Second"}',
    '{"objective":"bad "quotes"","questions":[]}',
    "No JSON response",
  ])("malformed or cut-off responses fail without accepting a partial task", (text) => {
    expect(() => object(text)).toThrow("Your prompt was kept")
  })

  test("tolerating a trailing comma does not turn a blocking decision into readiness", () => {
    const text = JSON.stringify({
      objective: "Clean up customer records",
      reuse: [],
      inspect: [],
      changes: [],
      constraints: [],
      hypotheses: [],
      acceptance: [],
      verification: [],
      evidence: [],
      questions: [
        {
          kind: "blocking",
          question: "Which retention policy applies?",
          impact: "Deletion is irreversible.",
          options: ["Retain", "Delete"],
        },
      ],
    }).replace(/}$/, ",}")
    expect(prepare(object(text), "Clean up customer records").status).toBe("needs_clarification")
  })
})

describe("citations", () => {
  const file = source("src/queue.ts", "Queue implementation", "code", { start: 10, end: 20 })
  const matches = [{ source: file, score: 1, reason: "Keyword" }]

  test("IDs and unambiguous selected file locators resolve to current evidence", () => {
    expect(citations([file.id], matches)).toEqual({ ids: [file.id], changed: 0 })
    for (const value of [
      `[${file.id}]`,
      `\`${file.id}\``,
      "src/queue.ts",
      "./src/queue.ts",
      "src/queue.ts:12",
      "src/queue.ts#L10-L20",
    ]) {
      expect(citations([value], matches)).toEqual({ ids: [file.id], changed: 1 })
    }
  })

  test("ambiguous paths, guessed IDs, and non-retrieved ranges remain rejected", () => {
    const other = source(file.uri, "Another passage", "symbol", { start: 30, end: 40 })
    expect(() => citations([file.uri], [...matches, { source: other, score: 1, reason: "Keyword" }])).toThrow(
      "ambiguous",
    )
    for (const value of ["queue.ts", "invented-id", other.id, "src/queue.ts:21", "src/queue.ts:5-20"]) {
      expect(() => citations([value], matches)).toThrow("Your prompt and answers were kept")
    }
  })

  test("selected URLs and unique registered document names can be cited", () => {
    const url = source("https://docs.example.test:8080", "Approved documentation", "document")
    expect(citations([url.uri], [{ source: url, score: 1, reason: "Documentation" }]).ids).toEqual([url.id])
    const item = source("knowledge:first/guide.pdf", "Approved reference", "document", {
      method: "collection-section",
      detail: { document: "guide.pdf" },
    })
    expect(citations(["guide.pdf"], [{ source: item, score: 1, reason: "Document search" }]).ids).toEqual([item.id])
  })

  test("the observed one-character-short citation resolves only to unique current evidence", () => {
    const item = source("test/server/httpapi-exercise/types.ts", "BackendApp definition", "symbol", {
      id: "b521c393922fa35e857e12a0",
      start: 55,
      end: 57,
    })
    const selected = [{ source: item, score: 1, reason: "Keyword" }]
    const shortened = "b521c393922fa35e857e12a"
    expect(citations([shortened], selected)).toEqual({ ids: [item.id], changed: 1 })
    expect(citations([item.id, `[${shortened}]`], selected)).toEqual({ ids: [item.id], changed: 1 })
    for (const value of [
      shortened.slice(0, -1),
      item.id.slice(1),
      `${shortened}1`,
      item.id.replace("c", ""),
      `${shortened}...`,
      shortened.toUpperCase(),
    ])
      expect(() => citations([value], selected)).toThrow("Your prompt and answers were kept")
    expect(() => citations([shortened], [])).toThrow("outside this revision")
    expect(() => citations([shortened], matches)).toThrow("outside this revision")
    expect(() => citations([item.id, shortened, "invented-id"], selected)).toThrow("outside this revision")
    const collision = { ...item, id: `${shortened}1`, uri: "test/another.ts" }
    expect(() => citations([shortened], [...selected, { source: collision, score: 1, reason: "Keyword" }])).toThrow(
      "ambiguous",
    )
  })
})

describe("model-response", () => {
  async function observe(input: Response) {
    const values: ModelResponse[] = []
    const response = await monitor(input, async (value) => {
      values.push(decode(ModelResponse, value))
    })
    return { response, values, latest: () => values.at(-1)! }
  }

  for (const [name, report, expected] of [
    ["explicit zero", { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }, { input: 0, output: 0, total: 0 }],
    ["absent", {}, undefined],
    ["invalid only", { prompt_tokens: -1, completion_tokens: "4" }, { invalid: true }],
    ["partial invalid", { prompt_tokens: 3, completion_tokens: 1.5 }, { input: 3, invalid: true }],
    ["unsafe", { prompt_tokens: Number.MAX_SAFE_INTEGER + 1, completion_tokens: 2 }, { output: 2, invalid: true }],
    [
      "contradictory total",
      { prompt_tokens: 3, completion_tokens: 2, total_tokens: 9 },
      { input: 3, output: 2, total: 9, invalid: true },
    ],
    [
      "cached overflow",
      { prompt_tokens: 3, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4 } },
      { input: 3, output: 2, cached: 4, invalid: true },
    ],
    [
      "reasoning overflow",
      { prompt_tokens: 3, completion_tokens: 2, completion_tokens_details: { reasoning_tokens: 4 } },
      { input: 3, output: 2, reasoning: 4, invalid: true },
    ],
  ] as const) {
    test(`model response counters remain truthful: ${name}`, async () => {
      const f = await observe(Response.json({ object: "chat.completion", usage: report }))
      await f.response.text()
      expect(f.latest().state).toBe("completed")
      expect(f.latest().usage).toEqual(expected ? { format: "openai-chat", ...expected } : undefined)
    })
  }

  test("JSON observation preserves UTF-8 bytes, headers and response identity", async () => {
    const text = JSON.stringify({
      object: "response",
      output: "\u4e2d\u6587 \u00e9",
      usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 },
    })
    const input = new Response(text, {
      status: 201,
      statusText: "Created",
      headers: { "content-type": "application/example+json", "x-fixture": "unchanged" },
    })
    Object.defineProperty(input, "url", { value: "http://127.0.0.1/fixture" })
    const f = await observe(input)
    expect(f.response.status).toBe(201)
    expect(f.response.statusText).toBe("Created")
    expect(f.response.url).toBe(input.url)
    expect(f.response.headers.get("x-fixture")).toBe("unchanged")
    expect(Buffer.from(await f.response.arrayBuffer())).toEqual(Buffer.from(text))
    expect(f.latest()).toMatchObject({
      state: "completed",
      bytes: Buffer.byteLength(text),
      usage: { format: "openai-responses", input: 8, output: 4, total: 12 },
    })
  })

  for (const separator of ["\n", "\r\n", "\r"]) {
    test(`split SSE follows event boundaries: ${JSON.stringify(separator)}`, async () => {
      const report = {
        type: "response.completed",
        response: { object: "response", usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 } },
      }
      const text = `: comment${separator}event: response.completed${separator}data: ${JSON.stringify(report)}${separator}${separator}data: [DONE]${separator}${separator}`
      const bytes = new TextEncoder().encode(text)
      let offset = 0
      const f = await observe(
        new Response(
          new ReadableStream<Uint8Array>(
            {
              pull(controller) {
                if (offset === bytes.length) {
                  controller.close()
                  return
                }
                controller.enqueue(bytes.slice(offset, ++offset))
              },
            },
            { highWaterMark: 0 },
          ),
          { headers: { "content-type": "text/event-stream" } },
        ),
      )
      expect(await f.response.text()).toBe(text)
      expect(f.latest()).toMatchObject({
        state: "completed",
        bytes: bytes.length,
        usage: { input: 4, output: 2, total: 6 },
      })
    })
  }

  test("repeated SSE reports are not summed and conflicting reports remain invalid", async () => {
    const event = (input: number) =>
      `data: ${JSON.stringify({ object: "chat.completion.chunk", usage: { prompt_tokens: input, completion_tokens: 2, total_tokens: input + 2 } })}\n\n`
    const same = await observe(new Response(event(4) + event(4), { headers: { "content-type": "text/event-stream" } }))
    await same.response.text()
    expect(same.latest().usage).toEqual({ format: "openai-chat", input: 4, output: 2, total: 6 })
    const conflict = await observe(
      new Response(event(4) + event(6) + event(6), { headers: { "content-type": "text/event-stream" } }),
    )
    await conflict.response.text()
    expect(conflict.latest().usage?.invalid).toBe(true)
  })

  for (const text of [
    "not JSON",
    JSON.stringify({ usage: { input_tokens: 4, output_tokens: 2 } }),
    JSON.stringify({ object: "response", usage: null }),
  ]) {
    test(`unrecognized or malformed JSON stays unknown: ${text.slice(0, 24)}`, async () => {
      const f = await observe(new Response(text, { headers: { "content-type": "application/json" } }))
      expect(await f.response.text()).toBe(text)
      expect(f.latest().usage).toBeUndefined()
    })
  }

  test("observation does not read ahead and forwards cancellation to the owned body", async () => {
    let pulls = 0
    const reasons: unknown[] = []
    const f = await observe(
      new Response(
        new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              pulls++
              controller.enqueue(new TextEncoder().encode("data: pending\n\n"))
            },
            cancel(reason) {
              reasons.push(reason)
            },
          },
          { highWaterMark: 0 },
        ),
        { headers: { "content-type": "text/event-stream" } },
      ),
    )
    expect(pulls).toBe(0)
    expect(f.latest()).toEqual({ state: "pending", bytes: 0 })
    const reader = f.response.body!.getReader()
    await reader.read()
    expect(pulls).toBe(1)
    await reader.cancel("caller stopped")
    expect(reasons).toEqual(["caller stopped"])
    expect(f.latest()).toMatchObject({ state: "cancelled", bytes: 15 })
    expect(f.latest().usage).toBeUndefined()
  })

  test("cancellation while a read is pending cannot later publish completion", async () => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const f = await observe(
      new Response(
        new ReadableStream<Uint8Array>(
          {
            async pull() {
              entered.resolve()
              await release.promise
            },
            cancel() {
              release.resolve()
            },
          },
          { highWaterMark: 0 },
        ),
        { headers: { "content-type": "application/json" } },
      ),
    )
    const reader = f.response.body!.getReader()
    const pending = reader.read()
    await entered.promise
    await reader.cancel("stop")
    await pending
    expect(f.latest()).toEqual({ state: "cancelled", bytes: 0 })
    expect(f.values.filter((value) => value.state === "completed")).toHaveLength(0)
  })

  test("body errors preserve the caller's error and leave usage incomplete", async () => {
    const error = new Error("actual stream error")
    const f = await observe(
      new Response(
        new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              controller.error(error)
            },
          },
          { highWaterMark: 0 },
        ),
        { headers: { "content-type": "application/json" } },
      ),
    )
    const result = await f.response.text().then(
      () => undefined,
      (err: unknown) => err,
    )
    expect(result).toBe(error)
    expect(f.latest()).toEqual({ state: "error", bytes: 0 })
  })

  test("rejected body cancellation still records cancellation and forwards the error", async () => {
    const error = new Error("actual cancellation error")
    const f = await observe(
      new Response(
        new ReadableStream<Uint8Array>(
          {
            cancel() {
              throw error
            },
          },
          { highWaterMark: 0 },
        ),
        { headers: { "content-type": "application/json" } },
      ),
    )
    const result = await f.response.body!.cancel().then(
      () => undefined,
      (err: unknown) => err,
    )
    expect(result).toBe(error)
    expect(f.latest()).toEqual({ state: "cancelled", bytes: 0 })
  })

  for (const [type, text] of [
    ["text/event-stream", "data: " + "x".repeat(65537) + "\n\n"],
    ["text/event-stream", ": " + "x".repeat(65537) + "\n\n"],
    ["text/event-stream", "data: x\n".repeat(40000) + "\n"],
    [
      "application/json",
      JSON.stringify({
        object: "response",
        output: "x".repeat(16 * 1024 * 1024),
        usage: { input_tokens: 4, output_tokens: 2 },
      }),
    ],
  ] as const) {
    test(`parser limits do not truncate caller bytes: ${type} ${text.length}`, async () => {
      const f = await observe(new Response(text, { headers: { "content-type": type } }))
      expect(await f.response.text()).toBe(text)
      expect(f.latest()).toMatchObject({ state: "limited", bytes: Buffer.byteLength(text) })
      expect(f.latest().usage).toBeUndefined()
    })
  }

  test("unsupported and unsuccessful responses never invent provider usage", async () => {
    const report: ModelUsage = { format: "openai-chat", input: 8, output: 4 }
    const text = JSON.stringify({
      object: "chat.completion",
      usage: { prompt_tokens: report.input, completion_tokens: report.output },
    })
    for (const [status, type, state] of [
      [200, "text/plain", "unsupported"],
      [503, "application/json", "completed"],
    ] as const) {
      const f = await observe(new Response(text, { status, headers: { "content-type": type } }))
      expect(await f.response.text()).toBe(text)
      expect(f.latest()).toEqual({ state, bytes: Buffer.byteLength(text) })
    }
    const f = await observe(new Response(null, { status: 204 }))
    expect(await f.response.text()).toBe("")
    expect(f.latest()).toEqual({ state: "unsupported", bytes: 0 })
  })
})
