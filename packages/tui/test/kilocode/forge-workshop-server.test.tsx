/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { Schema } from "effect"
import { decode } from "@kilocode/forge/schema"
import { deadline } from "@kilocode/forge/deadline"
import { backend } from "../../../opencode/test/kilocode/fixture/forge-server"
import { tmpdir } from "../fixture/fixture"
import { mount, workshop } from "./forge-composer-fixture"

test.each(["envelope", "proposal"] as const)("real backend recovers a malformed %s without rereading or asking for refinement", async (mode) => {
  await using home = await tmpdir()
  await using root = await tmpdir()
  await mkdir(`${root.path}/.kilo`)
  await Bun.write(`${root.path}/.kilo/forge.jsonc`, '{"investigation":true}')
  await Bun.write(`${root.path}/queue.ts`, "export function enqueue(id: string) { return [id, id] }\n")
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const calls: unknown[] = []
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = decode(
        Schema.Struct({
          messages: Schema.Array(Schema.Struct({ role: Schema.String, content: Schema.Unknown })),
          tools: Schema.Array(Schema.Struct({ function: Schema.Struct({ name: Schema.String }) })),
          tool_choice: Schema.Unknown,
        }),
        await request.json(),
      )
      calls.push(body)
      if (calls.length === 1) {
        entered.resolve()
        await release.promise
      }
      const previous = body.messages.findLast((item) => item.role === "tool")?.content
      const source =
        typeof previous === "string"
          ? decode(Schema.Struct({ source: Schema.Struct({ id: Schema.String }) }), JSON.parse(previous)).source
          : undefined
      const conclusion = {
        intent: "Fix duplicate queue output",
        summary: "The function returns the identifier twice.",
        findings: source
          ? [
              {
                title: "Duplicate queue output",
                kind: "defect",
                support: "observed",
                explanation: "The return array contains two copies.",
                benefit: "Avoid duplicated work.",
                evidence: [source.id],
                counterevidence: [],
                unknowns: [],
                action: "Return one identifier.",
                verification: ["Add a single-input regression."],
              },
            ]
          : [],
        questions: [],
        limitations: ["Tests have not been executed."],
      }
      const actions = source
        ? [
            {
              name: "forge_finish",
              input: {
                ...conclusion,
                ...(calls.length === 2 && mode === "envelope" ? { unknowns: [] } : {}),
                ...(calls.length === 2 && mode === "proposal"
                  ? { findings: conclusion.findings.map((item) => ({ ...item, action: null })) }
                  : {}),
              },
            },
          ]
        : [
            { name: "forge_finish", input: { unknowns: ["No original evidence yet."] } },
            { name: "forge_lookup", input: { path: 42 } },
            { name: "forge_read_file", input: { path: "queue.ts" } },
          ]
      return Response.json({
        id: `response-${calls.length}`,
        object: "chat.completion",
        created: 1,
        model: "test",
        choices: [
          {
            index: 0,
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: null,
              tool_calls: actions.map((item, index) => ({
                id: `call-${calls.length}-${index}`,
                type: "function",
                function: { name: item.name, arguments: JSON.stringify(item.input) },
              })),
            },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      })
    },
  })
  try {
    await using server = await backend(root.path, {
      home: home.path,
      endpoint: `${provider.url}v1`,
      provider: "test",
      binary: process.env.FORGE_WORKSHOP_BINARY,
    })
    const session = (await server.client.session.create({ directory: root.path }, { throwOnError: true })).data.id
    const forward = (request: Request, body?: Record<string, unknown>) => {
      const target = new URL(request.url)
      return fetch(new URL(target.pathname + target.search, server.url), {
        method: request.method,
        headers: request.headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: request.signal,
      })
    }
    using ui = await mount(
      root.path,
      true,
      [],
      [],
      async (path, request) => {
        if (path !== "/forge/investigations/stream") return undefined
        return forward(request, ui.requests.at(-1)!.body)
      },
      undefined,
      () => root.path,
      {
        url: server.url,
        headers: server.headers,
        session,
        reads: async (path, request) => (path.startsWith("/forge/") ? forward(request) : undefined),
      },
      workshop(root.path),
    )
    ui.prompt.set({ input: "/enhance Inspect queue.ts for duplicate output", parts: [] })
    await ui.press("\r")
    await deadline(() => entered.promise, undefined, 10_000)
    await ui.frame("Response pending")
    await ui.frame("1s elapsed")
    expect(ui.app.captureCharFrame()).not.toContain("0 model turns")
    expect(calls).toHaveLength(1)
    release.resolve()
    if (mode === "envelope") {
      await ui.frame("unknowns)")
      await ui.frame("Failure: schema during response")
    }
    if (mode === "proposal") {
      await ui.frame("The model's suggestions could not be validated")
      await ui.frame("invalid action format")
      await ui.frame("Retry suggestions (saved evidence")
      expect(ui.app.captureCharFrame()).not.toContain("Refine request")
    }
    await ui.frame("Retry conclusion only")
    expect(calls).toHaveLength(2)
    expect(ui.prompt.current.input).toBe("/enhance Inspect queue.ts for duplicate output")
    await ui.press(mode === "proposal" ? "\r" : "\x12")
    await ui.frame("Duplicate queue output")
    expect(ui.requests.filter((item) => item.path === "/forge/investigations/stream")).toHaveLength(2)
    expect(ui.requests.at(-1)?.body.resume).toMatchObject({ id: ui.requests.at(0)?.body.key })
    expect(calls).toHaveLength(3)
    expect(calls.at(-1)).toMatchObject({ tools: [{ function: { name: "forge_finish" } }] })
    expect(ui.requests.some((item) => item.path.startsWith("/session/"))).toBe(false)
  } finally {
    release.resolve()
    await provider.stop(true)
  }
}, 60_000)
