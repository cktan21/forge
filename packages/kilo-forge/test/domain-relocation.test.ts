import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { engine } from "../src/engine"
import { store, type Value } from "../src/store"
import { route } from "../src/domains"
import { render } from "../src/context"
import { chunks } from "../src/extract"
import { tokens } from "../src/util"
import type { Collection, Source } from "../src/schema"

const query = "quartz ledger"

function normalize(item: Source) {
  return {
    document: item.detail.document,
    page: item.detail.page,
    start: item.start,
    end: item.end,
    text: item.text,
  }
}

for (const shape of ["documents", "sections"] as const) {
  for (const routing of [undefined, "domains"] as const) {
    for (const budget of [600, 2400]) {
      test(`${shape}: ${routing ?? "default"} retrieval survives relocation and insertion order at ${budget}`, async () => {
        const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "forge-domain-relocation-")))
        const results: ReturnType<typeof normalize>[][] = []
        const routes: ReturnType<typeof normalize>[][] = []
        const identities: string[] = []
        try {
          for (const name of ["a", "relocated-workspace", "nested/considerably-longer-workspace-name"]) {
            const root = path.join(dir, name)
            const location = path.join(root, "manuals")
            await mkdir(path.join(root, ".kilo"), { recursive: true })
            await mkdir(location, { recursive: true })
            await Bun.write(path.join(root, ".kilo", "forge.jsonc"), JSON.stringify({ routing, budget }))
            const documents = shape === "documents" ? 6 : 1
            const sections = shape === "sections" ? 12 : 1
            for (let document = 0; document < documents; document++) {
              // Distinct lexical ranks isolate domain ties (both query terms match every section).
              const text = Array.from({ length: sections }, (_, section) =>
                `# Entry ${String(section).padStart(2, "0")}\nQuartz ledger procedure ${document}-${section}: record the measured value before closing the register.\n${"Preserve the written measurement and retain the signed receipt. ".repeat(4)}${"Use checklist. ".repeat(document + section)}\n`,
              ).join("\n")
              await Bun.write(path.join(location, `manual-${document}.md`), text)
            }
            for (const permutation of [0, 1, 2]) {
              const db = new Database(":memory:")
              const storage = store({
                async all(query) {
                  return db.query<Record<string, unknown>, Value[]>(query.text).all(...query.values ?? [])
                },
                async batch(queries) {
                  db.transaction(() => {
                    for (const query of queries) db.query(query.text).run(...query.values ?? [])
                  })()
                },
              })
              const api = engine({
                root,
                store: storage,
                async provider() { return "local-test" },
                async complete() { throw new Error("This regression must not call a model") },
              })
              try {
                const collection = await api.register({ kind: "folder", label: "Manuals", location, watch: false })
                await api.approve(collection.id, "", ["local-test"])
                await api.index(collection.id)
                // Retrieval settles real extraction and publication before reordering stored rows.
                await api.retrieve(query)
                const sources = await storage.knowledge(root, "", "local-test")
                expect(sources.filter((item) => item.method === "collection-section")).toHaveLength(documents * sections)
                const current = (await api.collections()).find((item) => item.id === collection.id)!
                expect(current.state).toBe("ready")
                const ordered = permutation === 0 ? sources : permutation === 1 ? sources.toReversed() :
                  [...sources.filter((_, index) => index % 2), ...sources.filter((_, index) => index % 2 === 0)]
                await storage.publish(root, current, ordered)
                const routed = route(query, ordered)
                expect(new Set(routed.map((item) => item.source.detail.document)).size).toBe(Math.min(documents, 3))
                expect(routed).toHaveLength(shape === "sections" ? 8 : 3)
                expect(routed.every((item) => item.score === 2)).toBe(true)
                routes.push(routed.map((item) => normalize(item.source)))
                const selected = await api.retrieve(query)
                expect(selected.budget).toBe(budget)
                expect(selected.tokens).toBe(tokens(selected.text))
                expect(selected.tokens).toBeLessThanOrEqual(budget)
                expect(selected.matches.length).toBeGreaterThan(0)
                expect(selected.matches.length).toBeLessThan(documents * sections)
                expect(selected.audit?.channels?.find((item) => item.name === "domains")?.state)
                  .toBe(routing === "domains" ? "completed" : "disabled")
                for (const match of selected.matches) {
                  expect(match.source.method).toBe("collection-section")
                  expect(match.source.status).toBe("current")
                  expect(sources.find((item) => item.id === match.source.id)).toEqual(match.source)
                  expect(selected.text).toContain(render(match))
                  const original = await Bun.file(path.join(location, match.source.detail.document!)).text()
                  expect(original.split("\n").slice(match.source.start - 1, match.source.end).join("\n").trim())
                    .toBe(match.source.text)
                }
                results.push(selected.matches.map((item) => normalize(item.source)))
                identities.push(collection.id)
              } finally {
                await api.dispose()
                db.close()
              }
            }
          }
          expect(new Set(identities).size).toBe(3)
          for (const result of results) expect(result).toEqual(results.at(0)!)
          if (routing === "domains") for (const result of routes) expect(result).toEqual(routes.at(0)!)
        } finally {
          await rm(dir, { recursive: true, force: true })
        }
      }, 30_000)
    }
  }
}

test("document content and numeric page coordinates resolve ties without collection identity", () => {
  const collection: Collection = {
    id: "first-root", label: "Manual", kind: "folder", location: "/first-root",
    session: "", origin: "interface", include: ["**/*"], exclude: [], watch: false,
    approved: true, providers: [], state: "ready", observed: 0, generation: "current",
    files: 1, chunks: 2, warnings: [],
  }
  const pages = [
    { page: 10, text: "# Later\nQuartz ledger closing procedure." },
    { page: 2, text: "# Earlier\nQuartz ledger opening procedure." },
  ]
  const originals = chunks(collection, "manual.md", new TextEncoder().encode(JSON.stringify(pages)), pages)
  const relocated = chunks({ ...collection, id: "second-root", location: "/second-root" },
    "manual.md", new TextEncoder().encode(JSON.stringify(pages)), pages.toReversed())
  expect(route(query, originals).map((item) => item.source.detail.page)).toEqual(["2", "10"])
  expect(route(query, relocated.toReversed()).map((item) => normalize(item.source)))
    .toEqual(route(query, originals).map((item) => normalize(item.source)))

  const copies = Array.from({ length: 5 }, (_, index) => {
    const text = `Quartz ledger version ${index}.`
    return chunks({ ...collection, id: `copy-${index}` }, "manual.md", new TextEncoder().encode(text), [{ text }])
  }).flat()
  const moved = copies.map((item) => ({
    ...item,
    id: `relocated-${item.id}`,
    evidence: item.evidence.map((key) => `relocated-${key}`),
    detail: { ...item.detail, collection: `relocated-${item.detail.collection}`, location: "/elsewhere" },
  }))
  expect(route(query, copies)).toHaveLength(3)
  expect(route(query, moved.toReversed()).map((item) => normalize(item.source)))
    .toEqual(route(query, copies).map((item) => normalize(item.source)))
})
