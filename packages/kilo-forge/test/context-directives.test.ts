import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { engine } from "../src/engine"
import { store, type Value } from "../src/store"
import { render } from "../src/context"

// Synthetic passage regressions, not evidence of live model quality.
const cases = [
  {
    name: "ledger",
    query: "parcel ledger checksum recovery",
    required: [
      "Validate parcel ledger checksum: compare the footer digest before accepting a batch.",
      "Perform parcel ledger recovery: replay only entries after the durable sequence marker.",
    ],
    supporting: "The parcel ledger sequence marker is persisted after the footer digest has been verified.",
    distractor: "Parcel ledger checksum recovery is the title of a conference display. The display lists speakers, seating assignments and sponsor banners.",
  },
  {
    name: "kiln",
    query: "ceramic kiln soak ramp",
    required: [
      "Set ceramic kiln soak: hold the chamber at the target temperature for forty minutes.",
      "Set ceramic kiln ramp: limit the temperature increase to three degrees each minute.",
    ],
    supporting: "The ceramic kiln thermocouple reading is sampled each minute to verify the temperature increase.",
    distractor: "Ceramic kiln soak ramp is the name of a museum exhibit. Its brochure lists ticket prices, opening dates and visitor parking instructions.",
  },
  {
    name: "reader",
    query: "archive reader offset framing",
    required: [
      "Check archive reader offset: reject positions beyond the end of the current segment.",
      "Check archive reader framing: require a complete length prefix before consuming a record.",
    ],
    supporting: "The archive reader length prefix counts payload bytes and excludes the prefix itself.",
    distractor: "Archive reader offset framing is the topic of a typography poster. Its description lists typefaces, ink colours and paper suppliers.",
  },
]

for (const item of cases) {
  for (const form of ["colon", "prose"] as const) {
    for (const location of ["one", "relocated"] as const) {
      for (const routing of ["default", "domains"] as const) {
        for (const budget of [600, 2400]) {
          describe(`${item.name}/${form}/${location}/${routing}/${budget}`, () => {
            test("retains feasible directives and measures passage precision", async () => {
              const key = `${item.name}-${form}-${location}-${routing}-${budget}`
              const home = await mkdtemp(path.join(tmpdir(), "forge-directives-"))
              const root = path.join(home, key)
              await mkdir(path.join(root, ".kilo"), { recursive: true })
              await Bun.write(path.join(root, ".kilo/forge.jsonc"), JSON.stringify({ budget, ...(routing === "domains" ? { routing } : {}) }))
              const folder = path.join(home, `${key}-documents`)
              await mkdir(folder, { recursive: true })
              const required = item.required.map((text) => form === "colon" ? text : text.replace(": ", " and "))
              const texts = [...required, item.supporting, item.distractor]
              const names = location === "one" ? ["a.md", "b.md", "c.md", "d.md"] : ["z.md", "y.md", "x.md", "w.md"]
              for (const [index, text] of texts.entries()) await Bun.write(path.join(folder, names.at(index)!), text)
              const db = new Database(path.join(home, "catalog.sqlite"))
              const catalog = store({
                all: async (query) => db.query<Record<string, unknown>, Value[]>(query.text).all(...query.values ?? []),
                batch: async (queries) => {
                  db.transaction(() => {
                    for (const query of queries) db.query(query.text).run(...query.values ?? [])
                  })()
                },
              })
              const app = engine({
                root, store: catalog,
                provider: async () => "development",
                complete: async () => { throw new Error("Model completion is forbidden in development retrieval") },
              })
              try {
                const collection = await app.register({ kind: "folder", label: "Manual", location: folder, watch: false })
                await app.approve(collection.id, "", ["development"])
                await app.index(collection.id)
                const result = await app.retrieve(item.query, { signal: AbortSignal.timeout(10_000) })
                const sources = await catalog.knowledge(root, "", "development")
                const originals = sources.filter((source) => required.includes(source.text))
                const cost = originals.reduce((sum, source) => sum + Buffer.byteLength(render({ source, score: 1, reason: "Feasibility only" })) + 1, 0)
                const selected = result.matches.map((match) => match.source.text)
                const coverage = required.filter((text) => selected.includes(text)).length
                const relevant = selected.filter((text) => [...required, item.supporting].includes(text)).length
                const precision = selected.length ? relevant / selected.length : 0
                const citations = result.matches.every((match) => sources.some((source) => source.id === match.source.id && source.hash === match.source.hash && source.text === match.source.text && source.status === "current"))
                expect(originals).toHaveLength(2)
                expect(cost).toBeLessThanOrEqual(600)
                expect(citations).toBe(true)
                expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(budget)
                expect(result.tokens).toBe(Buffer.byteLength(result.text))
                expect({
                  coverage,
                  precision,
                  supporting: budget === 600 || selected.includes(item.supporting),
                }).toEqual({ coverage: 2, precision: 1, supporting: true })
              } finally {
                await app.dispose()
                db.close()
                await rm(home, { recursive: true, force: true })
              }
            }, 15_000)
          })
        }
      }
    }
  }
}
