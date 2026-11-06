import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { randomUUID } from "node:crypto"
import { engine } from "@kilocode/forge/engine"
import { knowledge } from "@kilocode/forge/knowledge"
import { reference } from "@kilocode/forge/lineage"
import { marker } from "@kilocode/forge/lookups"
import { usage } from "@kilocode/forge/schema"
import { store } from "@kilocode/forge/store"
import { prepared } from "../../../tui/src/kilocode/forge/draft"
import { register, start } from "../../src/kilocode/forge/trace"
import { tmpdir } from "../fixture/fixture"

function database() {
  const db = new Database(":memory:")
  return {
    db,
    storage: store({
      all: async (query) => db.query<Record<string, unknown>, (string | number | null)[]>(query.text).all(...query.values ?? []),
      batch: async (queries) => { db.transaction(() => { for (const query of queries) db.query(query.text).run(...query.values ?? []) })() },
    }),
  }
}

test("persisted document pin flows through preparation, composer, and separate coding captures", async () => {
  await using tmp = await tmpdir()
  const { db, storage } = database()
  const received: string[] = []
  const server = Bun.serve({ port: 0, fetch: async (request) => {
    received.push(await request.text())
    return Response.json({
      objective: "Inspect queue ownership",
      reuse: [], inspect: ["Read queue callers"], changes: [], constraints: [],
      hypotheses: [], questions: [], acceptance: [], verification: [], evidence: [],
    })
  } })
  const destination = async () => ({ fingerprint: "lineage-local", origins: [server.url.origin] })
  const library = knowledge(tmp.path, storage, { destination })
  const unregister = register(tmp.path, storage, undefined, destination)
  const api = engine({
    root: tmp.path, store: storage, provider: async () => "approved", destination,
    complete: async (input) => {
      const messages = [{ role: "user", content: input.prompt }]
      const trace = (await start({
        root: tmp.path, session: input.session, purpose: input.purpose, request: input.request,
        model: "approved/local", system: [input.system], messages,
      }))!
      const response = await trace.fetch(fetch)(server.url, { method: "POST", body: JSON.stringify({ messages }) })
      await trace.finish({ measured: false })
      return { text: await response.text(), usage: usage("approved/local") }
    },
  })
  try {
    const collection = await library.register({
      kind: "text", location: "", label: "Ownership", session: "chat",
      content: "Queue ownership must validate the epoch lease before dispatch.",
    })
    await library.approve(collection.id, "chat", ["approved"], { approved: "lineage-local" })
    await library.index(collection.id, "chat")
    const source = (await storage.knowledge(tmp.path, "chat")).find((item) => item.method === "collection-section")!
    const policy = await api.configure({ ...await api.policy("chat"), pin: [source.id] })
    const proposal = await api.enhance({ text: "Inspect queue ownership. Do not change dispatch.", session: "chat" })
    expect(proposal.context.policy).toBe(policy.version)
    expect(proposal.context.matches.some((item) => item.source.id === source.id)).toBe(true)
    expect(await api.validate(proposal)).toBe(true)
    const parent = (await storage.request(tmp.path, "chat", proposal.id))!
    expect(parent.purpose).toBe("enhance")
    expect(parent.state).toBe("completed")
    expect(parent.operation).toBe(proposal.id)
    expect(parent.selection).toEqual(proposal.context.audit)
    expect(parent.selection?.candidates.find((item) => item.source === source.id)).toMatchObject({ state: "selected", hash: source.hash })
    expect(parent.entries.find((item) => item.source === source.id)?.stage).toBe("sent")
    const draft = prepared({ input: proposal.original, parts: [] }, `${proposal.prompt}\nReviewed edit: inspect only.`, proposal.context.text, proposal.id)
    expect(draft.input).toContain(proposal.original)
    const messages = [{ role: "user", content: [{ type: "text", text: draft.input }] }]
    const ids: string[] = []
    for (let attempt = 0; attempt < 2; attempt++) {
      const trace = (await start({ root: tmp.path, session: "chat", purpose: "coding", model: "approved/local", system: [], messages }))!
      ids.push(trace.id)
      await trace.fetch(fetch)(server.url, { method: "POST", body: JSON.stringify({ messages }) })
      await trace.finish({})
      const coding = (await storage.request(tmp.path, "chat", trace.id))!
      expect(coding.preparation).toBe(proposal.id)
      expect(coding.operation).toBe(parent.operation)
      expect(coding.selection).toBeUndefined()
      expect(coding.entries.find((item) => item.source === source.id)?.stage).toBe("sent")
      expect(coding.coverage.join(" ")).toContain("not proof of approval")
    }
    expect(new Set([proposal.id, ...ids]).size).toBe(3)
    expect(await storage.request(tmp.path, "chat", proposal.id)).toEqual(parent)
    expect(received).toHaveLength(3)
    expect(received.every((body) => body.includes(source.text))).toBe(true)
    expect(received.at(-1)).toContain("Reviewed edit: inspect only.")
    await api.configure({ ...await api.policy("chat"), pin: [], exclude: [source.id] })
    expect(await api.validate(proposal)).toBe(false)
    await expect(start({ root: tmp.path, session: "chat", purpose: "coding", model: "approved/local", system: [], messages })).rejects.toThrow("excluded")
    expect(received).toHaveLength(3)
  } finally {
    await api.dispose()
    unregister()
    await library.dispose()
    await server.stop(true)
    db.close()
  }
})

test("references resolve by ID beyond list pagination, without borrowing private or invalid preparations", async () => {
  const { db, storage } = database()
  const root = "/forge-lineage-scope"
  const unregister = register(root, storage)
  const other = register(`${root}-other`, storage)
  const id = randomUUID()
  const parent = {
    id, root, session: "chat", purpose: "enhance", model: "local", generation: "fixture",
    observed: 0, entries: [], coverage: [], usage: usage(), state: "completed" as const,
  }
  try {
    await storage.manifest(parent)
    for (let index = 0; index < 110; index++) {
      await storage.manifest({ ...parent, id: randomUUID(), observed: index + 1 })
    }
    expect((await storage.manifests(root)).some((item) => item.id === id)).toBe(false)
    const input = { root, session: "chat", purpose: "coding", model: "local", system: [], messages: [{ role: "user", content: reference(id) }] }
    async function capture(value = input) {
      const trace = (await start(value))!
      return (await storage.request(value.root, value.session, trace.id))!
    }
    expect((await capture()).preparation).toBe(id)
    expect((await capture({ ...input, session: "private" })).preparation).toBeUndefined()
    expect((await capture({ ...input, root: `${root}-other` })).preparation).toBeUndefined()
    expect((await capture({ ...input, messages: [...input.messages, { role: "user", content: "New unrelated request" }] })).preparation).toBeUndefined()
    await storage.manifest({ ...parent, state: "failed" })
    expect((await capture()).preparation).toBeUndefined()
    await storage.manifest({ ...parent, purpose: "overview" })
    expect((await capture()).preparation).toBeUndefined()
    await storage.manifest({ ...parent, session: "" })
    expect((await capture()).preparation).toBe(id)
    expect((await capture({ ...input, messages: [{ role: "user", content: reference(randomUUID()) }] })).coverage.join(" ")).toContain("could not be resolved")
    expect((await capture({ ...input, messages: [{ role: "user", content: "Legacy draft" }] })).preparation).toBeUndefined()
  } finally { unregister(); other(); db.close() }
})

test("tool references require matching call, tool and scope and preserve a historical excerpt version", async () => {
  await using tmp = await tmpdir()
  const { db, storage } = database()
  const unregister = register(tmp.path, storage)
  const api = engine({ root: tmp.path, store: storage, complete: async () => { throw new Error("Unexpected model call") } })
  try {
    await Bun.write(`${tmp.path}/queue.ts`, "export const queue = 'original epoch lease evidence'")
    const result = await api.lookup({ query: "queue lease", tool: "forge_search_code", session: "chat", call: "call", message: "turn" })
    const record = (await api.request(result.request, "chat"))!
    const previous = record.entries.find((item) => item.uri === "queue.ts")!
    await Bun.write(`${tmp.path}/queue.ts`, "export const queue = 'changed source contents'")
    await api.refresh(true)
    const part = { type: "tool-result", toolName: "forge_search_code", toolCallId: "call", output: { type: "text", value: `${marker(result.request)}\n${result.result.text}` } }
    async function observe(session = "chat", content = [part]) {
      const handle = (await start({ root: tmp.path, session, model: "local", purpose: "coding", system: [], messages: [{ role: "user", content: "Search" }, { role: "tool", content }] }))!
      return (await api.request(handle.id, session))!
    }
    const linked = await observe()
    expect(linked.lookups).toEqual([result.request])
    expect(linked.entries.find((item) => item.source === previous.source)?.hash).toBe(previous.hash)
    expect(linked.entries.find((item) => item.source === previous.source)?.text).toBe(previous.text)
    expect((await observe("other")).lookups).toEqual([])
    expect((await observe("chat", [{ ...part, toolCallId: "wrong" }])).lookups).toEqual([])
    expect((await observe("chat", [{ ...part, toolName: "forge_search_docs" }])).lookups).toEqual([])
    await storage.manifest({ ...record, state: "failed" })
    expect((await observe()).lookups).toEqual([])
    await storage.manifest({ ...record, session: "" })
    expect((await observe()).lookups).toEqual([])
    await storage.manifest({ ...record, session: "chat", purpose: "enhance" })
    expect((await observe()).lookups).toEqual([])
  } finally { await api.dispose(); unregister(); db.close() }
})
