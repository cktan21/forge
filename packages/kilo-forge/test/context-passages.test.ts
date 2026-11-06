import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtemp, realpath, rm, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { engine } from "../src/engine"
import { render, select } from "../src/context"
import { store } from "../src/store"
import { tokens } from "../src/util"
import { type Source } from "../src/schema"
import { source } from "../src/parse"

describe("context-long-evidence", () => {
  // Development counterexample: length alone cannot identify irrelevant prose.
  test("long operational evidence remains useful despite a short topical caption", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "forge-long-evidence-")))
    const originals = {
      "procedure.md":
        "The reservoir drain interlock must be verified before service. Close the supply isolation handle and lock it with the maintenance tag. Confirm that the pressure indicator reads zero before releasing the cover. Keep the discharge hose secured inside the collection vessel. Stop immediately if the alarm sounds and notify the duty supervisor. Record the completed inspection on the signed worksheet.",
      "caption.md": "An interlock beside a drain at the reservoir appears in a photograph.",
    }
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
      provider: async () => "length-development",
      complete: async () => {
        throw new Error("No model calls permitted")
      },
    })
    try {
      await Bun.write(
        path.join(root, ".kilo/forge.jsonc"),
        JSON.stringify({ selector: "ranked", budget: 600, exclude: [".kilo/**"] }),
      )
      for (const [file, text] of Object.entries(originals)) await Bun.write(path.join(root, "manuals", file), text)
      const collection = await api.register({ kind: "folder", label: "Manuals", location: "./manuals", watch: false })
      await api.approve(collection.id, "", ["length-development"])
      await api.index(collection.id)
      const selected = await api.retrieve("How does the reservoir drain interlock work?")
      const sources = (await storage.knowledge(root, "", "length-development")).filter(
        (item) => item.method === "collection-section",
      )
      const original = sources.find((item) => item.detail.document === "procedure.md")!
      const costs = sources.map((source) => tokens(render({ source, score: 1, reason: "" })) + 1)
      expect(tokens(render({ source: original, score: 1, reason: "" })) + 1).toBeLessThanOrEqual(600)
      expect(costs.reduce((sum, cost) => sum + cost, 0)).toBeGreaterThan(600)
      expect(selected.matches.map((item) => item.source)).toEqual([original])
      expect(original.text).toBe(originals["procedure.md"])
      expect(selected.tokens).toBe(tokens(selected.text))
      expect(selected.tokens).toBeLessThanOrEqual(600)
      const pinned = await api.retrieve("unrelated request", { pin: [original.id] })
      expect(pinned.matches.at(0)?.source).toEqual(original)
      const excluded = await api.retrieve("How does the reservoir drain interlock work?", { exclude: [original.id] })
      expect(excluded.matches.some((item) => item.source.id === original.id)).toBe(false)
    } finally {
      await api.dispose()
      db.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("context-counterevidence", () => {
  // A lower lexical score does not make an operational exception irrelevant.
  for (const selector of ["ranked", "greedy", "knapsack"] as const) {
    for (const budget of [600, 2400]) {
      test(`preserve settlement counterevidence ${selector}/${budget}`, async () => {
        const root = await realpath(await mkdtemp(path.join(tmpdir(), "forge-counterevidence-")))
        const texts = [
          "The gateway retries requests after transport timeout and preserves the transaction identifier.",
          "Do not retry after settlement has been acknowledged; charge duplication is otherwise possible.",
          "Gateway requests and transport timeout: an index of seminar photographs.",
        ]
        const query =
          "Should the gateway retry requests after transport timeout and preserve the transaction identifier?"
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
        const originals: Source[] = []
        const api = engine({
          root,
          store: storage,
          provider: async () => "development",
          docs: async () => originals,
          complete: async () => {
            throw new Error("No model calls permitted")
          },
        })
        try {
          await Bun.write(
            path.join(root, ".kilo/forge.jsonc"),
            JSON.stringify({ selector, budget, exclude: [".kilo/**", "manuals/**"] }),
          )
          for (const [index, text] of texts.entries()) await Bun.write(path.join(root, "manuals", `${index}.md`), text)
          const collection = await api.register({
            kind: "folder",
            location: "./manuals",
            label: "Manuals",
            watch: false,
          })
          await api.approve(collection.id, "", ["development"])
          await api.index(collection.id)
          await api.retrieve(query)
          originals.push(
            ...(await storage.knowledge(root, "", "development")).filter(
              (item) => item.method === "collection-section",
            ),
          )
          expect(originals).toHaveLength(3)
          const required = originals.filter((item) => texts.slice(0, 2).includes(item.text))
          expect(required).toHaveLength(2)
          expect(
            required.reduce((sum, source) => sum + tokens(render({ source, score: 1, reason: "" })) + 1, 0),
          ).toBeLessThanOrEqual(600)
          const result = await api.retrieve(query, { docs: true })
          expect(result.audit?.channels?.find((item) => item.name === "dependency-docs")).toMatchObject({
            state: "completed",
            candidates: 3,
          })
          for (const source of required)
            expect(result.matches.find((item) => item.source.id === source.id)?.source).toEqual(source)
          expect(result.tokens).toBe(tokens(result.text))
          expect(result.tokens).toBeLessThanOrEqual(budget)
          const exception = required.find((item) => item.text === texts.at(1))!
          const pinned = await api.retrieve("unrelated request", { docs: true, pin: [exception.id] })
          expect(pinned.matches.at(0)?.source).toEqual(exception)
          const excluded = await api.retrieve(query, { docs: true, exclude: [exception.id] })
          expect(excluded.matches.some((item) => item.source.id === exception.id)).toBe(false)
        } finally {
          await api.dispose()
          db.close()
          await rm(root, { recursive: true, force: true })
        }
      })
    }
  }
})

describe("context-conditions", () => {
  // Required conditions can add facts that are absent from the query's wording.
  const controls = [
    {
      name: "approval",
      query:
        "How should operators restore the journal checkpoint, verify the checkpoint checksum, replay transactions and reopen the database?",
      texts: [
        "Operators restore the journal checkpoint, verify the checkpoint checksum, replay transactions and reopen the database.",
        "Journal recovery requires written approval from the duty archivist.",
        "Journal checkpoint: a gallery of historic database diagrams.",
      ],
    },
    {
      name: "cooldown",
      query:
        "How should technicians disconnect the drive power, remove the drive housing, replace the bearing and reconnect the drive power?",
      texts: [
        "Technicians disconnect the drive power, remove the drive housing, replace the bearing and reconnect the drive power.",
        "The drive needs a twenty-minute cooling interval before maintenance.",
        "Drive housing and power: catalog photographs.",
      ],
    },
  ] as const

  for (const control of controls) {
    for (const selector of ["ranked", "greedy", "knapsack"] as const) {
      for (const budget of [800, 2400]) {
        test(`${control.name}/${selector}/${budget}: preserve conditions beyond query features`, async () => {
          const root = await realpath(await mkdtemp(path.join(tmpdir(), "forge-context-conditions-")))
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
          const originals: Source[] = []
          const api = engine({
            root,
            store: storage,
            provider: async () => "development",
            docs: async () => originals,
            complete: async () => {
              throw new Error("No completion permitted")
            },
          })
          try {
            await Bun.write(
              path.join(root, ".kilo/forge.jsonc"),
              JSON.stringify({ selector, budget, exclude: [".kilo/**", "manuals/**"] }),
            )
            for (const [index, text] of control.texts.entries())
              await Bun.write(path.join(root, "manuals", `${index}.md`), text)
            const collection = await api.register({
              kind: "folder",
              location: "./manuals",
              label: "Manuals",
              watch: false,
            })
            await api.approve(collection.id, "", ["development"])
            await api.index(collection.id)
            await api.retrieve(control.query)
            originals.push(
              ...(await storage.knowledge(root, "", "development")).filter(
                (source) => source.method === "collection-section",
              ),
            )
            expect(originals).toHaveLength(3)
            const required = originals.filter((source) =>
              control.texts.slice(0, 2).some((text) => text === source.text),
            )
            expect(required).toHaveLength(2)
            const cost = required.reduce((sum, source) => sum + tokens(render({ source, score: 1, reason: "" })) + 1, 0)
            expect(cost).toBeLessThanOrEqual(800)
            const selected = await api.retrieve(control.query, { docs: true })
            expect(selected.audit?.channels?.find((channel) => channel.name === "dependency-docs")).toMatchObject({
              state: "completed",
              candidates: 3,
            })
            expect(selected.tokens).toBe(tokens(selected.text))
            expect(selected.tokens).toBeLessThanOrEqual(budget)
            for (const source of required)
              expect(selected.matches.find((match) => match.source.id === source.id)?.source).toEqual(source)
            for (const match of selected.matches)
              expect(originals.find((source) => source.id === match.source.id)).toEqual(match.source)
            const condition = required.find((source) => source.text === control.texts.at(1))!
            const pinned = await api.retrieve("unrelated request", { docs: true, pin: [condition.id] })
            expect(pinned.matches.at(0)?.source).toEqual(condition)
            const excluded = await api.retrieve(control.query, { docs: true, exclude: [condition.id] })
            expect(excluded.matches.some((match) => match.source.id === condition.id)).toBe(false)
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

describe("support", () => {
  // Supplemental DEVELOPMENT control: retain a useful supporting original even
  // when the required answer is already present. Never consumes evaluator inputs.
  const query = "How must furnace sensors validate drift and where should operators store calibration records?"
  const originals = {
    "procedure.md":
      "Furnace sensors must validate drift before operators store calibration records. Reject any reading beyond the certified range.",
    "worksheet.md": "For calibration, store the records with the signed worksheet.",
    "exhibition.md": "Store calibration records: archived terminology and illustrations from past exhibitions.",
  }

  for (const routing of [undefined, "domains"] as const) {
    for (const budget of [600, 2400]) {
      test(`supporting original ${routing ?? "default"} ${budget}`, async () => {
        const dir = await mkdtemp(path.join(tmpdir(), "forge-support-"))

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
          provider: async () => "development",
          complete: async () => {
            throw new Error("Development forbids model calls")
          },
        })
        try {
          await mkdir(path.join(root, ".kilo"))
          await mkdir(path.join(root, "manuals"))
          await Bun.write(
            path.join(root, ".kilo/forge.jsonc"),
            JSON.stringify({ budget, exclude: [".kilo/**"], ...(routing ? { routing } : {}) }),
          )
          for (const [file, text] of Object.entries(originals)) await Bun.write(path.join(root, "manuals", file), text)
          const collection = await api.register({
            kind: "folder",
            label: "Manuals",
            location: "./manuals",
            watch: false,
          })
          await api.approve(collection.id, "", ["development"])
          await api.index(collection.id)
          const selected = await api.retrieve(query)
          const sources = (await storage.knowledge(root, "", "development")).filter(
            (item) => item.method === "collection-section",
          )
          const costs = sources.map((source) => ({
            document: source.detail.document,
            bytes: tokens(render({ source, score: 1, reason: "" })) + 1,
          }))
          const statements = [originals["procedure.md"]].map((text) => ({
            text,
            covered: selected.matches.some((item) => item.source.text === text),
          }))
          const precision =
            selected.matches.filter((item) => item.source.detail.document !== "exhibition.md").length /
            selected.matches.length

          expect(sources).toHaveLength(3)
          expect(
            costs.filter((item) => item.document !== "exhibition.md").reduce((sum, item) => sum + item.bytes, 0),
          ).toBeLessThanOrEqual(600)
          expect(costs.reduce((sum, item) => sum + item.bytes, 0)).toBeGreaterThan(600)
          expect(selected.tokens).toBe(tokens(selected.text))
          expect(selected.tokens).toBeLessThanOrEqual(budget)
          expect(selected.audit?.channels?.find((item) => item.name === "domains")?.state).toBe(
            routing ? "completed" : "disabled",
          )
          for (const match of selected.matches) {
            expect(match.source.status).toBe("current")
            expect(sources.find((item) => item.id === match.source.id)).toEqual(match.source)
          }
          expect(statements.every((item) => item.covered)).toBe(true)
          if (budget === 600) expect(precision).toBe(1)
        } finally {
          await api.dispose()
          db.close()
          await rm(root, { recursive: true, force: true })
        }
      })
    }
  }

  test("topic headings cannot multiply passage relationships, but remain searchable", () => {
    const query = { text: "inspect valve seal" }
    const score = (text: string) =>
      select(
        [{ source: source("guide.md", text, "document"), score: 1, reason: "keyword" }],
        10000,
        "ranked",
        [],
        query,
      ).matches.at(0)!.score
    expect(score("Inspect valve seal: historical illustrations.")).toBeLessThan(score("Inspect the valve seal."))
    expect(score("# Inspect valve seal\nHistorical illustrations.")).toBe(
      score("Inspect valve seal: historical illustrations."),
    )
    expect(score("Inspect valve seal: historical illustrations.")).toBeGreaterThan(1)
    expect(score("Inspect valve seal: historical illustrations. ".repeat(10))).toBe(
      score("Inspect valve seal: historical illustrations."),
    )
    expect(score("Inspect valve seal: inspect the valve seal.")).toBe(score("Inspect the valve seal."))
  })

  test("heading hints do not strip code or URI-qualified terms", () => {
    for (const kind of ["code", "symbol", "document"] as const) {
      const text = kind === "document" ? "Use urn:valve:seal with valveSeal." : "valveSeal: inspectValveSeal"
      const item = { source: source("guide.md", text, kind), score: 1, reason: "keyword" }
      const result = select([item], 10000, "ranked", [], { text })
      expect(result.matches.at(0)?.source).toBe(item.source)
      expect(result.matches.at(0)!.score).toBeGreaterThan(2)
    }
  })

  test("heading-aware ranking stays bounded at 100 candidates and the maximum budget", () => {
    const matches = Array.from({ length: 100 }, (_, index) => ({
      source: source(
        `manual-${index}.md`,
        `Inspect valve seal: historical illustrations ${index}.\nInspect the valve seal before restart.`,
        "document",
      ),
      score: 1 / (61 + index),
      reason: "keyword",
    }))
    const started = performance.now()
    for (const method of ["ranked", "greedy"] as const) {
      const result = select(matches, 100000, method, [], { text: "inspect valve seal restart" })
      expect(result.matches).toHaveLength(100)
      expect(result.tokens).toBe(tokens(result.text))
      expect(result.tokens).toBeLessThanOrEqual(100000)
    }
    expect(performance.now() - started).toBeLessThan(2000)
  })
})
