import { expect, test } from "bun:test"
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Schema } from "effect"
import { decode, Investigation, Prepared } from "@kilocode/forge"
import { metadata } from "@kilocode/forge/handoff"
import { backend } from "./fixture/forge-server"

test("source backend preserves prepared provenance through coding, compaction and restart", async () => {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "forge-workshop-process-")))
  const root = path.join(home, "workspace")
  await mkdir(path.join(root, ".kilo"), { recursive: true })
  await writeFile(path.join(root, ".kilo/forge.jsonc"), '{"investigation":true}')
  await writeFile(path.join(root, "queue.ts"), "export function enqueue(id: string) { return [id, id] }\n")
  const calls: string[] = []
  const model = { providerID: "probe", modelID: "test" }
  const provider = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const body = decode(Schema.Struct({
        stream: Schema.optional(Schema.Boolean),
        messages: Schema.Array(Schema.Struct({ role: Schema.String, content: Schema.Unknown })),
        tools: Schema.optional(Schema.Array(Schema.Struct({ function: Schema.Struct({ name: Schema.String }) }))),
      }), await request.json())
      const investigation = body.tools?.some((tool) => tool.function.name === "forge_finish")
      const user = body.messages.findLast((item) => item.role === "user")?.content
      const writer = typeof user === "string" && user.startsWith('{"requirements":')
      calls.push(investigation ? "investigate" : writer ? "write" : body.stream ? "coding" : "auxiliary")
      const base = { id: crypto.randomUUID(), object: "chat.completion", created: 1, model: "test" }
      if (investigation) {
        const output = body.messages.findLast((item) => item.role === "tool")?.content
        const observed = typeof output === "string" ? decode(Schema.Struct({ source: Schema.Struct({ id: Schema.String }) }), JSON.parse(output)).source : undefined
        const name = observed ? "forge_finish" : "forge_read_file"
        const input = observed ? {
          intent: "Fix duplicate queue output", summary: "The function duplicates its input.",
          findings: [{ title: "Duplicate output", kind: "defect", support: "observed", explanation: "The return array contains id twice.", benefit: "Avoid duplicate work.", evidence: [observed.id], counterevidence: [], unknowns: [], action: "Return one identifier.", verification: ["Proposed: a single-input regression."] }],
          questions: [], limitations: ["Tests not executed."],
        } : { path: "queue.ts" }
        return Response.json({ ...base, choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: crypto.randomUUID(), type: "function", function: { name, arguments: JSON.stringify(input) } }] } }], usage: { prompt_tokens: 100, completion_tokens: 30 } })
      }
      const content = (() => {
        if (!writer || typeof user !== "string") return "Fixture completed. Preserve the reviewed task and its historical source references."
        const input = decode(Schema.Struct({ requirements: Schema.Array(Schema.Struct({ id: Schema.String })), sources: Schema.Array(Schema.Struct({ id: Schema.String })) }), JSON.parse(user))
        return JSON.stringify({ objective: "Fix duplicate queue output.", basis: "The inspected return array duplicates its input. Runtime verification remains pending.", changes: ["Return one identifier."], constraints: ["Keep the public API."], verification: ["Proposed: add and run a regression."], evidence: input.sources.map((item) => item.id), requirements: input.requirements.map((item) => item.id) })
      })()
      if (!body.stream) return Response.json({ ...base, choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }], usage: { prompt_tokens: 100, completion_tokens: 30 } })
      return new Response([
        { ...base, object: "chat.completion.chunk", choices: [{ index: 0, finish_reason: null, delta: { role: "assistant", content } }] },
        { ...base, object: "chat.completion.chunk", choices: [{ index: 0, finish_reason: "stop", delta: {} }], usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 } },
      ].map((item) => `data: ${JSON.stringify(item)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
    },
  })
  const processes: Awaited<ReturnType<typeof backend>>[] = []
  async function launch() {
    const value = await backend(root, { home, endpoint: `${provider.url}v1`, binary: process.env.FORGE_WORKSHOP_BINARY })
    processes.push(value)
    return value
  }
  const opts = { throwOnError: true as const, get signal() { return AbortSignal.timeout(30_000) } }
  try {
    const first = await launch()
    const client = first.client
    const session = (await client.session.create({ directory: root, title: "Workshop fixture", agent: "build" }, opts)).data.id
    const record = decode(Investigation, (await client.forge.investigate({ directory: root, key: crypto.randomUUID(), text: "Fix duplicate queue output. Keep the API.", session, model }, opts)).data)
    expect(record.state).toBe("findings_ready")
    const direction = (await client.forge.chooseDirection({ directory: root, key: crypto.randomUUID(), investigation: record.id, revision: record.revision, selected: [record.findings.at(0)!.id], session }, opts)).data
    const prepared = decode(Prepared, (await client.forge.writePrompt({ directory: root, id: direction.id, revision: direction.revision, key: crypto.randomUUID(), session }, opts)).data)
    expect(prepared.prompt).not.toContain("return [id, id]")
    expect(calls.filter((kind) => kind === "coding")).toEqual([])
    const binding = { id: prepared.id, revision: prepared.revision, hash: prepared.hash, session }
    const response = (await client.session.prompt({ directory: root, sessionID: session, agent: "build", model, parts: [{ type: "text", text: prepared.prompt, metadata: metadata(binding) }] }, opts)).data
    expect(response.info.error).toBeUndefined()
    expect(calls.filter((kind) => kind === "coding")).toHaveLength(1)
    // An approved coding step may change repository code without erasing its history.
    await writeFile(path.join(root, "queue.ts"), "export function enqueue(id: string) { return [id] }\n")
    const followup = (await client.session.prompt({ directory: root, sessionID: session, agent: "build", model, parts: [{ type: "text", text: "Review the changed implementation." }] }, opts)).data
    expect(followup.info.error).toBeUndefined()
    await client.session.summarize({ directory: root, sessionID: session, ...model, auto: false }, opts)
    first.proc.kill()
    await first.proc.exited
    const second = await launch()
    const messages = (await second.client.session.messages({ directory: root, sessionID: session }, opts)).data
    expect(messages.some((item) => item.info.role === "assistant" && item.info.summary)).toBe(true)
    await writeFile(path.join(root, ".gitignore"), "queue.ts\n")
    const count = calls.filter((kind) => kind === "coding").length
    const blocked = await second.client.session.prompt({ directory: root, sessionID: session, agent: "build", model, parts: [{ type: "text", text: "Continue after restart." }] }, opts).then((result) => result.data.info.error, (err: unknown) => err)
    expect(blocked).toBeTruthy()
    expect(calls.filter((kind) => kind === "coding")).toHaveLength(count)
  } finally {
    await Promise.allSettled(processes.map((value) => value[Symbol.asyncDispose]()))
    await provider.stop(true)
    await rm(home, { recursive: true, force: true })
  }
}, 120_000)
