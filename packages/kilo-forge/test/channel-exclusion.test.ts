import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { engine, type Ports } from "../src/engine"
import { source } from "../src/parse"
import { store } from "../src/store"

async function fixture(selector: "ranked" | "greedy" | "knapsack", candidates = 1) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "forge-channel-exclusion-")))
  await Bun.write(path.join(root, ".kilo/forge.jsonc"), JSON.stringify({ selector, candidates, budget: 2400, exclude: [".kilo/**"] }))
  const db = new Database(path.join(root, ".kilo/catalog.sqlite"))
  const storage = store({
    all: async (query) => db.query<Record<string, unknown>, (string | number | null)[]>(query.text).all(...query.values ?? []),
    batch: async (queries) => {
      db.transaction(() => {
        for (const query of queries) db.query(query.text).run(...query.values ?? [])
      })()
    },
  })
  const handles: ReturnType<typeof engine>[] = []
  return {
    root, storage,
    open(ports: Partial<Ports> = {}) {
      const api = engine({
        root, store: storage,
        complete: async () => { throw new Error("Admission tests must not call a model") },
        ...ports,
      })
      handles.push(api)
      return api
    },
    async [Symbol.asyncDispose]() {
      for (const api of handles) await api.dispose()
      db.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}

// Adapter replies are fixed boundary inputs; storage, remapping, fusion,
// selection, policy, and lookup-history publication use production code.
for (const channel of ["memory", "dependency-docs", "semantic"] as const) {
  for (const selector of ["ranked", "greedy", "knapsack"] as const) {
    // Recalled memories are ephemeral, not policy-editable catalog entries.
    const modes = channel === "memory" ? ["request"] as const : ["request", "policy"] as const
    test.each([...modes])(`${channel}/${selector}: %s exclusion cannot occupy the sole fusion slot`, async (mode) => {
      await using f = await fixture(selector)
      const documents = ["first", "second"].map((name) => source(`${channel}:${name}`, `Lease procedure ${name}.`, "document", {
        method: channel === "memory" ? "kilo-memory-recall" : "adapter-document",
        detail: channel === "memory" ? { session: "chat" } : {},
      }))
      if (channel === "semantic") {
        await Bun.write(path.join(f.root, "first.txt"), "First original passage.")
        await Bun.write(path.join(f.root, "second.txt"), "Second original passage.")
      }
      const api = f.open({
        ...(channel === "memory" ? { memory: async () => documents } : {}),
        ...(channel === "dependency-docs" ? { docs: async () => documents } : {}),
        ...(channel === "semantic" ? {
          semantic: async () => documents.map((source) => ({ source, score: 1, reason: "Fixed ranked adapter input" })),
        } : {}),
      })
      if (channel === "semantic") {
        const snapshot = await api.refresh()
        documents.splice(0, documents.length, ...["first.txt", "second.txt"].map((uri) =>
          snapshot.sources.find((item) => item.uri === uri && item.method === "file")!))
      }
      const blocked = documents.at(0)!
      const allowed = documents.at(1)!
      const opts = { session: "chat", docs: channel === "dependency-docs" }
      if (channel === "dependency-docs" && mode === "policy") {
        await api.retrieve("request guidance", opts)
        await api.refresh()
      }
      if (mode === "policy") await api.configure({ ...await api.policy("chat"), pin: [], exclude: [blocked.id] })
      const result = await api.retrieve("request guidance", { ...opts, exclude: mode === "request" ? [blocked.id] : [] })
      expect(result.matches.map((item) => item.source.id)).toEqual([allowed.id])
      expect(result.matches.at(0)?.source.hash).toBe(allowed.hash)
      expect(result.matches.at(0)?.source.text).toBe(allowed.text)
      expect(result.tokens).toBe(Buffer.byteLength(result.text))
      expect(result.tokens).toBeLessThanOrEqual(2400)
      expect(result.audit?.candidates.find((item) => item.source === blocked.id)).toMatchObject({
        state: "omitted", reason: "Excluded by developer",
        channels: [expect.objectContaining({ name: channel, rank: 1 })],
      })
      if (mode === "policy") {
        const lookup = await api.lookup({ tool: opts.docs ? "forge_search_docs" : "forge_search_code", query: "request guidance", session: "chat" })
        expect(lookup.result.matches.map((item) => item.source.id)).toEqual([allowed.id])
        expect((await api.request(lookup.request, "chat"))?.selection).toEqual(lookup.result.audit)
        expect(await api.request(lookup.request, "other")).toBeUndefined()
      }
      const empty = await api.retrieve("request guidance", { ...opts, exclude: documents.map((item) => item.id) })
      expect(empty.matches).toEqual([])
      expect(empty.tokens).toBe(0)
      await api.configure({ ...await api.policy("chat"), pin: [], exclude: [] })
      const restored = await api.retrieve("request guidance", opts)
      expect(restored.matches.length).toBe(1)
    })
  }
}

test("excluded linked documents do not fill relationship or public-document expansion limits", async () => {
  await using f = await fixture("greedy", 100)
  await Bun.write(path.join(f.root, "pivot.ts"), "export const lease = 'public lease procedure'")
  for (let index = 0; index < 45; index++) {
    await Bun.write(path.join(f.root, `${String(index).padStart(2, "0")}.md`), `Supporting record ${index}. [Reference](pivot.ts)`)
  }
  const api = f.open()
  const snapshot = await api.refresh()
  const documents = snapshot.sources.filter((item) => item.kind === "document" && item.method === "file")
  expect(documents).toHaveLength(45)
  const allowed = documents.at(-1)!
  expect(snapshot.relations.filter((item) => item.kind === "document-links-to")).toHaveLength(45)
  const excluded = snapshot.sources.filter((item) => item.kind === "document" && item.uri !== allowed.uri).map((item) => item.id)
  await api.configure({ ...await api.policy("chat"), pin: [], exclude: excluded })
  const result = await api.retrieve("public lease", { session: "chat" })
  expect(result.matches.some((item) => item.source.id === allowed.id)).toBe(true)
  expect(result.matches.some((item) => excluded.includes(item.source.id))).toBe(false)
  const recorded = result.audit?.candidates.find((item) => item.source === allowed.id)
  expect(recorded?.channels?.map((item) => item.name)).toEqual(expect.arrayContaining(["relationships", "public-docs"]))
  expect(result.tokens).toBe(Buffer.byteLength(result.text))
  expect(result.tokens).toBeLessThanOrEqual(2400)
})
