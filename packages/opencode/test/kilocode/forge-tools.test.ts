import { expect } from "bun:test"
import { Effect, Exit } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { Agent } from "@/agent/agent"
import { Session } from "@/session/session"
import { MessageID } from "@/session/schema"
import { Permission } from "@/permission"
import { Forge } from "@/kilocode/forge/service"
import { ForgeTools } from "@/kilocode/forge/tools"
import { start } from "@/kilocode/forge/trace"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { KiloIndexing } from "@/kilocode/indexing"

const it = testEffect(LayerNode.compile(LayerNode.group([Forge.node, Truncate.node, Agent.node, Session.node, Permission.node])))

it.instance("actual Forge search tools retain scoped selection history and link matching transport results", () => Effect.gen(function* () {
  const { directory } = yield* TestInstance
  yield* Effect.promise(() => Bun.write(`${directory}/queue.ts`, "export const epoch = 'Queue lease is checked before dispatch'"))
  const sessions = yield* Session.Service
  const session = yield* sessions.create({ title: "Search history" })
  const permissions = yield* Permission.Service
  const api = yield* (yield* Forge.Service).get()
  expect(KiloIndexing.peek(directory)).toBeUndefined()
  expect((yield* Effect.promise(() => api.status())).semantic).toEqual({ state: "uninitialized", searchable: false })
  expect(KiloIndexing.peek(directory)).toBeUndefined()
  const tools = yield* ForgeTools
  const message = MessageID.ascending()
  const requests: string[] = []
  const http = yield* Effect.acquireRelease(Effect.sync(() => Bun.serve({ port: 0, fetch: async (request) => { requests.push(await request.text()); return Response.json({ ok: true }) } })), (http) => Effect.promise(() => http.stop(true)))
  for (const info of [tools[0], tools[1]]) {
    const name = info.id
    const tool = yield* Tool.init(info)
    const ctx: Tool.Context = {
      sessionID: session.id, messageID: message, callID: `call-${name}`, agent: "build", abort: new AbortController().signal, messages: [],
      metadata: () => Effect.void,
      ask: (input) => permissions.ask({ ...input, sessionID: session.id, ruleset: [{ permission: name, pattern: "*", action: "allow" }] }).pipe(Effect.asVoid, Effect.orDie),
    }
    const output = yield* tool.execute({ query: "queue lease" }, ctx)
    const id = output.metadata.request
    const capture = yield* Effect.promise(() => api.request(id, session.id))
    expect(capture?.purpose).toBe("tool-retrieval")
    expect(capture?.lookup).toMatchObject({ tool: name, call: ctx.callID, message, query: "queue lease" })
    expect(capture?.selection?.candidates.length).toBeGreaterThan(0)
    // An uninitialized optional index is unavailable, not a completed empty search.
    expect(capture?.selection?.channels?.find((item) => item.name === "semantic")).toMatchObject({
      state: "unavailable",
      candidates: 0,
      withheld: 0,
      readiness: { state: "uninitialized", searchable: false },
    })
    expect(KiloIndexing.peek(directory)).toBeUndefined()
    expect(capture?.entries.every((item) => item.stage === "assembled")).toBe(true)
    expect(capture?.operation).toBe(message)
    expect(capture?.state).toBe("completed")
    const messages = [
      { role: "user", content: "Inspect queue" },
      { role: "tool", content: [{ type: "tool-result", toolName: name, toolCallId: ctx.callID, output: { type: "text", value: output.output } }] },
    ]
    const trace = yield* Effect.promise(() => start({ root: directory, session: session.id, model: "local/model", purpose: "coding", system: [], messages }))
    yield* Effect.promise(() => trace!.fetch(fetch)(http.url, { method: "POST", body: JSON.stringify({ messages }) }))
    const coding = yield* Effect.promise(() => api.request(trace!.id, session.id))
    expect(coding?.lookups).toEqual([id])
    expect(coding?.operation).toBe(message)
    expect(coding?.entries.some((entry) => capture!.entries.some((item) => item.source === entry.source) && entry.stage === "sent")).toBe(true)
    expect(coding?.coverage.join(" ")).toContain("not proof of approval")
    expect(yield* Effect.promise(() => api.request(id, "other"))).toBeUndefined()
    const before = yield* Effect.promise(() => api.manifests({ session: session.id }))
    const denied = yield* tool.execute({ query: "denied canary" }, { ...ctx, ask: (input) => permissions.ask({ ...input, sessionID: session.id, ruleset: [{ permission: name, pattern: "*", action: "deny" }] }).pipe(Effect.asVoid, Effect.orDie) }).pipe(Effect.exit)
    expect(Exit.isFailure(denied)).toBe(true)
    expect(yield* Effect.promise(() => api.manifests({ session: session.id }))).toEqual(before)
  }
  const snapshot = yield* Effect.promise(() => api.refresh())
  const source = snapshot.sources.find((item) => item.uri === "queue.ts" && item.method === "file")!
  for (const info of [tools[2], tools[3]]) {
    const name = info.id
    const tool = yield* Tool.init(info)
    const ctx: Tool.Context = {
      sessionID: session.id, messageID: message, callID: `call-${name}`, agent: "build", abort: new AbortController().signal, messages: [],
      metadata: () => Effect.void,
      ask: (input) => permissions.ask({ ...input, sessionID: session.id, ruleset: [{ permission: name, pattern: "*", action: "allow" }] }).pipe(Effect.asVoid, Effect.orDie),
    }
    const output = yield* tool.execute({ id: source.id }, ctx)
    const capture = (yield* Effect.promise(() => api.request(output.metadata.request, session.id)))!
    expect(capture.lookup).toMatchObject({ tool: name, call: ctx.callID, message, query: source.id })
    expect(capture.selection).toBeUndefined()
    expect(capture.state).toBe("completed")
    expect(capture.entries.every((item) => item.stage === "assembled")).toBe(true)
    if (name === "forge_relationships") {
      expect(capture.entries.at(0)?.kind).toBe("tool")
      expect(output.output).not.toContain(source.text)
      expect(output.output).toContain(source.hash)
    }
    const messages = [
      { role: "user", content: "Inspect queue" },
      { role: "tool", content: [{ type: "tool-result", toolName: name, toolCallId: ctx.callID, output: { type: "text", value: output.output } }] },
    ]
    const trace = (yield* Effect.promise(() => start({ root: directory, session: session.id, model: "local/model", purpose: "coding", system: [], messages })))!
    yield* Effect.promise(() => trace.fetch(fetch)(http.url, { method: "POST", body: JSON.stringify({ messages }) }))
    const coding = (yield* Effect.promise(() => api.request(trace.id, session.id)))!
    expect(coding.lookups).toEqual([capture.id])
    expect(coding.entries.some((entry) => entry.source === capture.entries.at(0)?.source && entry.stage === "sent")).toBe(true)
    expect(coding.operation).toBe(message)
    const before = yield* Effect.promise(() => api.manifests({ session: session.id }))
    const denied = yield* tool.execute({ id: source.id }, { ...ctx, ask: (input) => permissions.ask({ ...input, sessionID: session.id, ruleset: [{ permission: name, pattern: "*", action: "deny" }] }).pipe(Effect.asVoid, Effect.orDie) }).pipe(Effect.exit)
    expect(Exit.isFailure(denied)).toBe(true)
    expect(yield* Effect.promise(() => api.manifests({ session: session.id }))).toEqual(before)
  }
  expect(requests).toHaveLength(4)
}), 30_000)
