import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { engine, type Ports } from "../src/engine"
import { source } from "../src/parse"
import { usage, type Source } from "../src/schema"
import { store } from "../src/store"

const canary = "Adapter replacement canary is not repository evidence."
const query = "checkpoint recovery"

function original(item: Source | undefined) {
  return item ? { ...item, observed: 0 } : undefined
}

test("reopened SQLite rebuilds repository ownership before merging stripped legacy adapter records", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "forge-repository-reopen-")))
  await Bun.write(path.join(root, ".kilo/forge.jsonc"), JSON.stringify({ routing: "domains", exclude: [".kilo/**"] }))
  await Bun.write(path.join(root, "checkpoint.ts"), "export function recovery(checkpoint: string) { return checkpoint.trim() }\n")
  await Bun.write(path.join(root, "package.json"), JSON.stringify({ dependencies: { "checkpoint-recovery": "1.0.0" } }))
  const targets: Source[] = []
  try {
    for (const restart of [false, true]) {
      const db = new Database(path.join(root, ".kilo/catalog.sqlite"))
      const storage = store({
        all: async (query) => db.query<Record<string, unknown>, (string | number | null)[]>(query.text).all(...(query.values ?? [])),
        batch: async (queries) => {
          db.transaction(() => {
            for (const query of queries) db.query(query.text).run(...(query.values ?? []))
          })()
        },
      })
      const api = engine({
        root, store: storage,
        complete: async () => { throw new Error("No model calls permitted") },
      })
      try {
        const snapshot = await api.refresh()
        if (!restart) {
          targets.push(...snapshot.sources.filter((item) =>
            item.method === "file" || item.kind === "symbol" || item.kind === "dependency" || item.method === "domain-index"))
          expect(targets).toHaveLength(5)
          for (const target of targets) await storage.external(root, {
            ...target, text: canary, uri: `adapter:${target.id}`, method: "adapter-document", detail: {}, evidence: [],
          })
          continue
        }
        for (const target of targets) {
          expect(snapshot.sources.filter((item) => item.id === target.id).map(original)).toEqual([original(target)])
          expect(original(await storage.source(root, target.id))).toEqual(original(target))
        }
        expect((await storage.externals(root)).filter((item) => item.text === canary)).toHaveLength(5)
        const result = await api.lookup({ tool: "forge_search_code", session: "chat", query })
        expect(JSON.stringify(result.result)).not.toContain(canary)
        expect(result.result.text).toContain("checkpoint")
      } finally {
        await api.dispose()
        db.close()
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

for (const selector of ["ranked", "greedy", "knapsack"]) {
  for (const kind of ["file", "symbol", "dependency", "domain"]) {
    for (const channel of ["docs", "memory", "legacy"] as const) {
      test(`${selector}/${kind}/${channel}: repository originals own their IDs`, async () => {
        const root = await realpath(await mkdtemp(path.join(tmpdir(), "forge-repository-owner-")))
        await Bun.write(path.join(root, ".kilo/forge.jsonc"), JSON.stringify({
          selector, routing: "domains", budget: 8000, exclude: [".kilo/**"],
        }))
        await Bun.write(path.join(root, "checkpoint.ts"), "export function recovery(checkpoint: string) { return checkpoint.trim() }\n")
        await Bun.write(path.join(root, "package.json"), JSON.stringify({ dependencies: { "checkpoint-recovery": "1.0.0" } }))
        const db = new Database(path.join(root, ".kilo/catalog.sqlite"))
        const storage = store({
          all: async (query) => db.query<Record<string, unknown>, (string | number | null)[]>(query.text).all(...(query.values ?? [])),
          batch: async (queries) => {
            db.transaction(() => {
              for (const query of queries) db.query(query.text).run(...(query.values ?? []))
            })()
          },
        })
        const records: Source[] = []
        const calls: Parameters<Ports["complete"]>[0][] = []
        const api = engine({
          root, store: storage,
          ...(channel === "memory" ? { memory: async () => records } : { docs: async () => records }),
          complete: async (input) => {
            calls.push(input)
            return {
              text: JSON.stringify({
                objective: query, reuse: [], inspect: [], changes: [], constraints: [],
                hypotheses: [], questions: [], acceptance: [], verification: [], evidence: [],
              }),
              usage: usage("fixture"),
            }
          },
        })
        try {
          const initial = await api.refresh()
          const target = initial.sources.find((item) =>
            kind === "file" ? item.method === "file" && item.uri === "checkpoint.ts"
              : kind === "domain" ? item.method === "domain-index"
                : item.kind === kind)!
          expect(target).toBeDefined()
          await api.configure({
            ...await api.policy("chat"),
            exclude: initial.sources.filter((item) => item.id !== target.id).map((item) => item.id),
          })
          const duplicate = {
            ...target, text: canary,
            ...(channel === "memory" ? { method: "kilo-memory-recall", detail: { session: "chat", query } } : {}),
          }
          if (channel === "legacy") await storage.external(root, duplicate)
          if (channel !== "legacy") records.push(duplicate)
          if (channel === "legacy") await api.refresh(true)
          const lookup = await api.lookup({
            query, session: "chat", tool: channel === "memory" ? "forge_search_code" : "forge_search_docs",
          })
          expect(JSON.stringify(lookup.result)).not.toContain(canary)
          expect(original(lookup.result.matches.find((item) => item.source.id === target.id)?.source)).toEqual(original(target))
          expect((await api.request(lookup.request, "chat"))?.selection).toEqual(lookup.result.audit)
          expect(await api.request(lookup.request, "other")).toBeUndefined()
          if (channel === "memory") expect(lookup.result.audit?.channels?.find((item) => item.name === "memory")?.withheld).toBe(1)
          if (channel !== "legacy") expect((await storage.externals(root)).some((item) => item.id === target.id)).toBe(false)
          const refreshed = await api.refresh(true)
          expect(refreshed.sources.filter((item) => item.id === target.id).map(original)).toEqual([original(target)])
          expect(original(await storage.source(root, target.id))).toEqual(original(target))
          const draft = await api.enhance({ text: query, session: "chat" })
          expect(original(draft.context.matches.find((item) => item.source.id === target.id)?.source)).toEqual(original(target))
          expect(calls).toHaveLength(1)
          expect(calls.at(0)?.prompt).toContain(target.text)
          expect(calls.at(0)?.prompt).not.toContain(canary)
          const excluded = await api.retrieve(query, { session: "chat", docs: true, exclude: [target.id] })
          expect(excluded.matches.some((item) => item.source.id === target.id)).toBe(false)
          if (channel === "legacy") {
            expect((await storage.externals(root)).find((item) => item.id === target.id)).toEqual(duplicate)
            const independent = source("adapter:reference", "Checkpoint recovery independent documentation.", "document", { method: "adapter-document" })
            records.push(independent)
            await api.retrieve(query, { session: "chat", docs: true })
            expect((await storage.externals(root)).find((item) => item.id === independent.id)).toEqual(independent)
            records.splice(0, 1, { ...independent, status: "stale" })
            await api.retrieve(query, { session: "chat", docs: true })
            expect((await storage.externals(root)).find((item) => item.id === independent.id)?.status).toBe("stale")
          }
        } finally {
          await api.dispose()
          db.close()
          await rm(root, { recursive: true, force: true })
        }
      })
    }
  }
}
