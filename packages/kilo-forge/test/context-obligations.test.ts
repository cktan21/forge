import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { render, select } from "../src/context"
import { engine } from "../src/engine"
import { source } from "../src/parse"
import { store } from "../src/store"
import { tokens } from "../src/util"

describe("distinct-evidence", () => {
  // Source-counterexample development controls, not independent retrieval evaluation.
  const controls = [
    {
      name: "obligation",
      query: "cooling pump",
      texts: ["The cooling pump circulates water.", "The cooling pump must be isolated before opening its housing."],
    },
    {
      name: "value",
      query: "chamber pressure",
      texts: ["The chamber pressure is 12 kPa during calibration.", "The chamber pressure is 18 kPa during operation."],
    },
    {
      name: "negation",
      query: "sensor bypass",
      texts: [
        "The sensor bypass is permitted during inspection.",
        "The sensor bypass is not permitted during operation.",
      ],
    },
  ] as const
  const methods = ["ranked", "greedy", "knapsack"] as const

  async function fixture() {
    const dir = await mkdtemp(path.join(tmpdir(), "forge-distinct-"))

    const root = await realpath(dir)
    const db = new Database(":memory:")
    const storage = store({
      all: async (query) =>
        db.query<Record<string, unknown>, (string | number | null)[]>(query.text).all(...(query.values ?? [])),
      batch: async (queries) => {
        db.transaction(() => {
          for (const query of queries) db.query(query.text).run(...(query.values ?? []))
        })()
      },
    })
    const api = engine({
      root,
      store: storage,
      provider: async () => "distinct-development",
      complete: async () => {
        throw new Error("No model calls permitted")
      },
    })
    await mkdir(path.join(root, ".kilo"))
    return {
      root,
      storage,
      api,
      async [Symbol.asyncDispose]() {
        await api.dispose()
        db.close()
        await rm(root, { recursive: true, force: true })
      },
    }
  }

  for (const control of controls) {
    for (const method of methods) {
      for (const routing of [undefined, "domains"] as const) {
        for (const budget of [600, 2400]) {
          test(`distinct ${control.name} ${method} ${routing ?? "default"} ${budget}`, async () => {
            await using f = await fixture()
            await Bun.write(
              path.join(f.root, ".kilo/forge.jsonc"),
              JSON.stringify({
                budget,
                selector: method,
                exclude: [".kilo/**"],
                ...(routing ? { routing } : {}),
              }),
            )
            await mkdir(path.join(f.root, "manuals"))
            for (const [index, text] of control.texts.entries())
              await Bun.write(path.join(f.root, `manuals/${index}.md`), text)
            const collection = await f.api.register({
              kind: "folder",
              label: "Manuals",
              location: "./manuals",
              watch: false,
            })
            await f.api.approve(collection.id, "", ["distinct-development"])
            await f.api.index(collection.id)
            const selected = await f.api.retrieve(control.query)
            const originals = (await f.storage.knowledge(f.root, "", "distinct-development")).filter(
              (item) => item.method === "collection-section",
            )
            expect(originals).toHaveLength(2)
            expect(
              originals.reduce((sum, source) => sum + tokens(render({ source, score: 1, reason: "" })) + 1, 0),
            ).toBeLessThanOrEqual(600)
            const pinned = await f.api.retrieve(control.query, { pin: [originals.at(0)!.id] })

            for (const result of [selected, pinned]) {
              expect(result.tokens).toBe(tokens(result.text))
              expect(result.tokens).toBeLessThanOrEqual(budget)
              expect(result.audit?.channels?.find((item) => item.name === "domains")?.state).toBe(
                routing ? "completed" : "disabled",
              )
              for (const item of result.matches)
                expect(originals.find((source) => source.id === item.source.id)).toEqual(item.source)
              expect(control.texts.every((text) => result.matches.some((item) => item.source.text === text))).toBe(true)
            }
            const matches = originals.map((source) => ({ source, score: 1, reason: "original" }))
            for (const pins of [[], [originals.at(0)!.id]]) {
              expect(select(matches, budget, method, pins, { text: control.query }).matches).toHaveLength(2)
            }
          })
        }
      }
    }
  }

  for (const method of methods) {
    test(`distinct shared-query base relevance ${method}`, () => {
      const matches = [
        "The cooling pump circulates water.",
        "The cooling pump must be isolated before opening its housing.",
        "Annual attendance records are stored here.",
      ].map((text, index) => ({
        source: source(`${index}.md`, text, "document", { method: "collection-section" }),
        score: index === 2 ? 0.1 : 1,
        reason: "development",
      }))
      const budget = matches.slice(0, 2).reduce((sum, item) => sum + tokens(render(item)) + 1, 0)
      expect(matches.reduce((sum, item) => sum + tokens(render(item)) + 1, 0)).toBeGreaterThan(budget)
      for (const candidates of [matches, [...matches].reverse()]) {
        const selected = select(candidates, budget, method, [], { text: "cooling pump" })
        expect(selected.matches.map((item) => item.source.id).sort()).toEqual(
          matches
            .slice(0, 2)
            .map((item) => item.source.id)
            .sort(),
        )
        expect(selected.tokens).toBeLessThanOrEqual(budget)
      }
    })
  }

  for (const uri of ["src/with.ts", "src/with/this.ts", "src/withThis.ts"]) {
    for (const method of methods) {
      test(`distinct exact common-word path ${uri} ${method}`, async () => {
        await using f = await fixture()
        await mkdir(path.dirname(path.join(f.root, uri)), { recursive: true })
        for (let index = 0; index < 110; index++)
          await Bun.write(path.join(f.root, `src/item${index}.ts`), `export const item${index} = ${index}`)
        await Bun.write(path.join(f.root, uri), "export const result = 731")
        for (const routing of [undefined, "domains"] as const) {
          for (const budget of [600, 2400]) {
            await Bun.write(
              path.join(f.root, ".kilo/forge.jsonc"),
              JSON.stringify({
                budget,
                selector: method,
                exclude: [".kilo/**"],
                ...(routing ? { routing } : {}),
              }),
            )
            await f.api.refresh(true)
            const lexical = await f.storage.search(f.root, uri, 100, { domains: routing === "domains" })
            const selected = await f.api.retrieve(uri)

            expect(lexical.at(0)?.source.uri).toBe(uri)
            expect(selected.matches.some((item) => item.source.uri === uri)).toBe(true)
            expect(selected.matches.every((item) => item.source.status === "current")).toBe(true)
            expect(selected.tokens).toBe(tokens(selected.text))
            expect(selected.tokens).toBeLessThanOrEqual(budget)
            const exact = lexical.find((item) => item.source.uri === uri)!
            expect(
              select(lexical, budget, method, [], { text: uri }).matches.some((item) => item.source.uri === uri),
            ).toBe(true)
            const pinned = await f.api.retrieve("unrelated attendance", { pin: [exact.source.id] })
            expect(pinned.matches.some((item) => item.source.id === exact.source.id)).toBe(true)
            expect(pinned.tokens).toBeLessThanOrEqual(budget)
          }
        }
      }, 30000)
    }
  }
})

describe("allfit", () => {
  // Additional DEVELOPMENT controls, frozen before any remediation production edit.
  const controls = [
    {
      name: "seismograph",
      query: "How is the seismograph trace checked and where is its chart kept?",
      originals: {
        "check.md": "Check the seismograph trace against the test pulse.",
        "chart.md": "Keep its chart in the control room.",
        "index.md": "# Seismograph trace and chart\nA gallery of old diagrams.",
      },
    },
    {
      name: "airlock",
      query: "Who owns the airlock gauge and where is its spare kept?",
      originals: {
        "owner.md": "The diving crew owns the airlock gauge.",
        "spare.md": "Its spare is kept in the blue locker.",
        "index.md": "An exhibit depicts the airlock gauge and its spare.",
      },
    },
  ] as const

  for (const control of controls) {
    for (const routing of [undefined, "domains"] as const) {
      for (const budget of [600, 2400]) {
        test(`all-fit development ${control.name} ${routing ?? "default"} ${budget}`, async () => {
          const dir = await mkdtemp(path.join(tmpdir(), "forge-allfit-"))

          const root = await realpath(dir)
          const db = new Database(":memory:")
          const storage = store({
            all: async (query) =>
              db.query<Record<string, unknown>, (string | number | null)[]>(query.text).all(...(query.values ?? [])),
            batch: async (queries) => {
              db.transaction(() => {
                for (const query of queries) db.query(query.text).run(...(query.values ?? []))
              })()
            },
          })
          const api = engine({
            root,
            store: storage,
            provider: async () => "allfit-development",
            complete: async () => {
              throw new Error("No model calls permitted")
            },
          })
          try {
            await mkdir(path.join(root, ".kilo"))
            await mkdir(path.join(root, "manuals"))
            await Bun.write(
              path.join(root, ".kilo/forge.jsonc"),
              JSON.stringify({ budget, exclude: [".kilo/**"], ...(routing ? { routing } : {}) }),
            )
            for (const [file, text] of Object.entries(control.originals))
              await Bun.write(path.join(root, "manuals", file), text)
            const collection = await api.register({
              kind: "folder",
              label: "Manuals",
              location: "./manuals",
              watch: false,
            })
            await api.approve(collection.id, "", ["allfit-development"])
            await api.index(collection.id)
            const selected = await api.retrieve(control.query)
            const sources = (await storage.knowledge(root, "", "allfit-development")).filter(
              (item) => item.method === "collection-section",
            )
            const cost = sources.reduce((sum, source) => sum + tokens(render({ source, score: 1, reason: "" })) + 1, 0)
            const statements = Object.entries(control.originals)
              .filter(([file]) => file !== "index.md")
              .map(([file, text]) => ({
                file,
                text,
                covered: selected.matches.some((item) => item.source.text.includes(text)),
              }))
            const precision =
              selected.matches.filter((item) => item.source.detail.document !== "index.md").length /
              selected.matches.length

            expect(sources).toHaveLength(3)
            expect(cost).toBeLessThanOrEqual(600)
            expect(selected.tokens).toBe(tokens(selected.text))
            expect(selected.tokens).toBeLessThanOrEqual(budget)
            for (const item of selected.matches) {
              expect(item.source.status).toBe("current")
              expect(sources.find((source) => source.id === item.source.id)).toEqual(item.source)
            }
            expect(statements.every((item) => item.covered)).toBe(true)
            expect(precision).toBe(1)
          } finally {
            await api.dispose()
            db.close()
            await rm(root, { recursive: true, force: true })
          }
        })
      }
    }
  }
})
