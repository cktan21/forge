import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { engine } from "../src/engine"
import { store } from "../src/store"
import { relation } from "../src/parse"

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "forge-inspection-")))
  const db = new Database(":memory:")
  const storage = store({
    all: async (query) => db.query<Record<string, unknown>, (string | number | null)[]>(query.text).all(...query.values ?? []),
    batch: async (queries) => { db.transaction(() => { for (const query of queries) db.query(query.text).run(...query.values ?? []) })() },
  })
  await writeFile(path.join(root, "queue.ts"), "export const queue = 'public queue passage'")
  await writeFile(path.join(root, "hidden.ts"), "export const hidden = 'excluded passage canary'")
  const api = engine({ root, store: storage, complete: async () => { throw new Error("No model call expected") } })
  const snapshot = await api.refresh()
  const queue = snapshot.sources.find((item) => item.uri === "queue.ts" && item.method === "file")!
  const hidden = snapshot.sources.find((item) => item.uri === "hidden.ts" && item.method === "file")!
  await storage.replace({ ...snapshot, relations: [...snapshot.relations, relation(queue.id, hidden.id, "fixture", [queue.id, hidden.id], "Explicit fixture relationship")] })
  return { root, api, storage, queue, hidden, async [Symbol.asyncDispose]() { await api.dispose(); db.close(); await rm(root, { recursive: true, force: true }) } }
}

test("symbol and relationship captures distinguish passages from metadata", async () => {
  await using state = await fixture()
  const symbol = await state.api.inspect({ query: state.queue.id, tool: "forge_get_symbol", session: "chat", call: "symbol", message: "turn" })
  const captured = (await state.api.request(symbol.request, "chat"))!
  expect(captured.entries.at(0)).toMatchObject({ source: state.queue.id, hash: state.queue.hash, text: state.queue.text, stage: "assembled" })
  expect(captured.selection).toBeUndefined()
  expect(captured.coverage.join(" ")).toContain("no ranked candidate selection")
  const graph = await state.api.inspect({ query: state.queue.id, tool: "forge_relationships", session: "chat", call: "graph", message: "turn" })
  const record = (await state.api.request(graph.request, "chat"))!
  expect(record.operation).toBe(captured.operation)
  expect(record.entries).toHaveLength(1)
  expect(record.entries.at(0)?.kind).toBe("tool")
  expect(record.entries.at(0)?.text).toBe(graph.result.output)
  expect(graph.result.output).toContain(state.hidden.id)
  expect(graph.result.output).not.toContain(state.hidden.text)
  expect(graph.result.output).not.toContain(state.queue.text)
  const data = JSON.parse(graph.result.output)
  const ids = new Set(data.sources.map((item: { id: string }) => item.id))
  expect(data.relations.every((edge: { from: string; to: string; evidence: string[] }) => ids.has(edge.from) && ids.has(edge.to) && edge.evidence.every((id) => ids.has(id)))).toBe(true)
})

test("inspection policy excludes passages and removes graph identities and supporting edges", async () => {
  await using state = await fixture()
  await state.api.configure({ ...await state.api.policy("chat"), exclude: [state.hidden.id] })
  expect((await state.api.view({ focus: state.queue.id, session: "chat" })).sources.some((item) => item.id === state.hidden.id)).toBe(true)
  const graph = await state.api.inspect({ query: state.queue.id, tool: "forge_relationships", session: "chat" })
  expect(graph.result.output).not.toContain(state.hidden.id)
  expect(graph.result.output).not.toContain("hidden.ts")
  expect(graph.result.output).toContain("withheld")
  await expect(state.api.inspect({ query: state.hidden.id, tool: "forge_get_symbol", session: "chat" })).rejects.toThrow("excluded")
  const failed = (await state.api.manifests({ session: "chat" })).find((item) => item.state === "failed")!
  expect(failed.entries).toEqual([])
  expect(failed.selection).toBeUndefined()
  expect(await state.api.request(graph.request, "other")).toBeUndefined()
})

test("changed neighbors and cancelled inspections cannot publish stale passages", async () => {
  await using state = await fixture()
  await writeFile(path.join(state.root, "hidden.ts"), "export const hidden = 'changed content'")
  const graph = await state.api.inspect({ query: state.queue.id, tool: "forge_relationships", session: "chat" })
  expect(graph.result.output).not.toContain(state.hidden.hash)
  expect(graph.result.output).not.toContain("excluded passage canary")
  const controller = new AbortController()
  controller.abort(new Error("Inspection cancelled"))
  await expect(state.api.inspect({ query: state.queue.id, tool: "forge_get_symbol", session: "chat", signal: controller.signal })).rejects.toThrow("Inspection cancelled")
  const failed = (await state.api.manifests({ session: "chat" })).find((item) => item.state === "failed")!
  expect(failed.entries).toEqual([])
})
