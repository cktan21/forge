import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { engine } from "../src/engine"
import { render, select } from "../src/context"
import { store } from "../src/store"
import { tokens } from "../src/util"
import { type Match } from "../src/schema"
import { source } from "../src/parse"

describe("answer-and-lookup", () => {
  // Model-free regression controls, not independent retrieval evaluation.
  const controls = [
    {
      name: "ballast",
      query: "What must ballast inspection record and where is its signed certificate kept?",
      lookup: "Which gallery explains ballast inspection record terminology?",
      originals: {
        "measurement.md": "Inspection of ballast requires recording the measured density.",
        "custody.md": "Keep its signed certificate in the harbor vault.",
        "gallery.md":
          "Ballast inspection record and signed certificate: a gallery explaining terminology and historic illustrations. Exhibits are arranged by date, with a bibliography and curator notes.",
      },
      required: [
        "Inspection of ballast requires recording the measured density.",
        "Keep its signed certificate in the harbor vault.",
      ],
    },
    {
      name: "kiln",
      query: "How is kiln pressure released and when can the chamber latch open?",
      lookup: "Which exhibition covers kiln pressure and chamber latch terminology?",
      originals: {
        "vent.md": "Release pressure in the kiln through the bleed port.",
        "interlock.md": "The chamber latch opens only after the gauge reaches zero.",
        "gallery.md":
          "Kiln pressure released and chamber latch open: an exhibition of terminology, illustrations and historic equipment. Exhibits are arranged by date, with a bibliography and curator notes.",
      },
      required: [
        "Release pressure in the kiln through the bleed port.",
        "The chamber latch opens only after the gauge reaches zero.",
      ],
    },
    {
      name: "orchard",
      query: "Who approves orchard sampling and where are the sample receipts filed?",
      lookup: "Which catalog lists orchard sampling and sample receipts terminology?",
      originals: {
        "authority.md": "Sampling in the orchard needs approval from the agronomist.",
        "filing.md": "File receipts for each sample in the green binder.",
        "gallery.md":
          "Orchard sampling and sample receipts filed: a catalog of terminology, historic illustrations and seasonal themes. Exhibits are arranged by date, with a bibliography and curator notes.",
      },
      required: [
        "Sampling in the orchard needs approval from the agronomist.",
        "File receipts for each sample in the green binder.",
      ],
    },
  ] as const

  for (const control of controls) {
    for (const routing of [undefined, "domains"] as const) {
      for (const budget of [600, 2400]) {
        for (const objective of ["answer", "lookup"] as const) {
          test(`answer and lookup ${control.name} ${objective} ${routing ?? "default"} ${budget}`, async () => {
            const dir = await mkdtemp(path.join(tmpdir(), "forge-lookup-"))

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
              provider: async () => "lookup-development",
              complete: async () => {
                throw new Error("Development retrieval forbids model calls")
              },
            })
            try {
              await mkdir(path.join(root, ".kilo"))
              await mkdir(path.join(root, "manuals"))
              await Bun.write(
                path.join(root, ".kilo/forge.jsonc"),
                JSON.stringify({
                  budget,
                  exclude: [".kilo/**"],
                  ...(routing ? { routing } : {}),
                }),
              )
              for (const [file, text] of Object.entries(control.originals)) {
                await Bun.write(path.join(root, "manuals", file), text)
              }
              const collection = await api.register({
                kind: "folder",
                label: "Manuals",
                location: "./manuals",
                watch: false,
              })
              await api.approve(collection.id, "", ["lookup-development"])
              await api.index(collection.id)
              const query = objective === "answer" ? control.query : control.lookup
              const selected = await api.retrieve(query)
              const sources = await storage.knowledge(root, "", "lookup-development")
              const originals = sources.filter((source) => source.method === "collection-section")
              const relevant = originals.filter((source) =>
                objective === "answer"
                  ? source.detail.document !== "gallery.md"
                  : source.detail.document === "gallery.md",
              )
              const statements = (objective === "answer" ? control.required : [control.originals["gallery.md"]]).map(
                (text) => ({ text, covered: selected.matches.some((match) => match.source.text.includes(text)) }),
              )
              const costs = originals.map((source) => ({
                document: source.detail.document,
                bytes: tokens(render({ source, score: 1, reason: "Development feasibility" })) + 1,
              }))
              const precision = selected.matches.length
                ? selected.matches.filter((match) => relevant.some((source) => source.id === match.source.id)).length /
                  selected.matches.length
                : 0

              expect(originals).toHaveLength(3)
              expect(
                relevant.reduce((sum, source) => sum + tokens(render({ source, score: 1, reason: "" })) + 1, 0),
              ).toBeLessThanOrEqual(600)
              expect(costs.reduce((sum, item) => sum + item.bytes, 0)).toBeGreaterThan(600)
              expect(selected.tokens).toBe(tokens(selected.text))
              expect(selected.tokens).toBeLessThanOrEqual(budget)
              expect(selected.audit?.channels?.find((channel) => channel.name === "domains")?.state).toBe(
                routing ? "completed" : "disabled",
              )
              for (const match of selected.matches) {
                expect(match.source.status).toBe("current")
                expect(match.source.method).toBe("collection-section")
                expect(originals.find((source) => source.id === match.source.id)).toEqual(match.source)
                expect(Object.values(control.originals).some((text) => text === match.source.text)).toBe(true)
              }
              expect(statements.filter((statement) => !statement.covered)).toEqual([])
              // At 2400 all originals may fit; strict precision is checked at 600.
              if (budget === 600 && objective === "answer") expect(precision).toBe(1)
            } finally {
              await api.dispose()
              db.close()
              await rm(root, { recursive: true, force: true })
            }
          })
        }
      }
    }
  }
})

describe("location", () => {
  // Model-free location controls, not independent retrieval evaluation.
  const controls = [
    {
      name: "bridge",
      originals: {
        "balance.md": "Balance the resistance bridge against the reference resistor.",
        "record.md": "Write the bridge offset in the instrument log.",
        "survey.md":
          "A survey discusses how to balance the resistance bridge and write the bridge offset. It traces the vocabulary used in trade publications and compares photographs of teaching instruments across several decades.",
        "delivery.md": "Weigh the parcel before signing its delivery receipt.",
      },
      queries: [
        {
          name: "operation",
          text: "How do I balance the resistance bridge and write the bridge offset?",
          relevant: ["balance.md", "record.md"],
        },
        {
          name: "survey",
          text: "Which survey compares photographs of teaching instruments and trade publications?",
          relevant: ["survey.md"],
        },
      ],
    },
    {
      name: "distillation",
      originals: {
        "coolant.md": "Maintain coolant flow through the condenser during distillation.",
        "outlet.md": "The condenser outlet must remain open throughout distillation.",
        "index.md":
          "Condenser coolant flow and outlet conditions during distillation are indexed in a historical bibliography. Entries list authors, publishers and the dates of laboratory exhibitions.",
        "delivery.md": "Open the delivery gate before moving the trolley.",
      },
      queries: [
        {
          name: "operation",
          text: "What coolant flow and outlet conditions apply to the condenser during distillation?",
          relevant: ["coolant.md", "outlet.md"],
        },
        {
          name: "index",
          text: "Which bibliography lists authors and publishers of laboratory exhibitions?",
          relevant: ["index.md"],
        },
      ],
    },
    {
      name: "ledger",
      originals: {
        "owner.md": "The archive registrar owns the accession ledger.",
        "copy.md": "Its backup is kept in the east strongroom.",
        "exhibit.md": "An exhibit depicts the accession ledger and its backup.",
        "delivery.md": "The courier owns the delivery trolley.",
      },
      queries: [
        {
          name: "operation",
          text: "Who owns the accession ledger and where is its backup kept?",
          relevant: ["owner.md", "copy.md"],
        },
        {
          name: "exhibit",
          text: "Which exhibit depicts the accession ledger and its backup?",
          relevant: ["exhibit.md"],
        },
      ],
    },
    {
      name: "sterilizer",
      originals: {
        "inspection.md": "The sterilizer bypass is permitted during inspection.",
        "operation.md": "The sterilizer bypass is not permitted during operation.",
        "survey.md":
          "A historical survey discusses sterilizer bypass inspection and operation. It compares the appearance of factory notices and describes the changing layout of equipment displays.",
        "delivery.md": "Inspection of the delivery trolley is required every week.",
      },
      queries: [
        {
          name: "operation",
          text: "When is the sterilizer bypass permitted?",
          relevant: ["inspection.md", "operation.md"],
        },
        {
          name: "survey",
          text: "Which historical survey compares factory notices and equipment displays?",
          relevant: ["survey.md"],
        },
      ],
    },
  ]

  for (const control of controls) {
    for (const objective of control.queries) {
      for (const routing of [undefined, "domains"] as const) {
        for (const budget of [600, 2400]) {
          test(`location ${control.name} ${objective.name} ${routing ?? "default"} ${budget}`, async () => {
            const dir = await mkdtemp(path.join(tmpdir(), "forge-location-"))

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
              provider: async () => "location-development",
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
              for (const [file, text] of Object.entries(control.originals)) {
                await Bun.write(path.join(root, "manuals", file), text)
              }
              const collection = await api.register({
                kind: "folder",
                label: "Manuals",
                location: "./manuals",
                watch: false,
              })
              await api.approve(collection.id, "", ["location-development"])
              await api.index(collection.id)
              const selected = await api.retrieve(objective.text)
              const sources = (await storage.knowledge(root, "", "location-development")).filter(
                (item) => item.method === "collection-section",
              )
              const statements = objective.relevant.map((file) => ({
                text: Object.entries(control.originals).find(([key]) => key === file)![1],
                covered: selected.matches.some((item) => item.source.detail.document === file),
              }))
              const precision = selected.matches.length
                ? selected.matches.filter((item) => objective.relevant.includes(String(item.source.detail.document)))
                    .length / selected.matches.length
                : 0
              const costs = sources.map((source) => ({
                file: source.detail.document,
                bytes: tokens(render({ source, score: 1, reason: "" })) + 1,
              }))

              expect(sources).toHaveLength(4)
              expect(
                costs
                  .filter((item) => objective.relevant.includes(String(item.file)))
                  .reduce((sum, item) => sum + item.bytes, 0),
              ).toBeLessThanOrEqual(600)
              expect(selected.tokens).toBe(tokens(selected.text))
              expect(selected.tokens).toBeLessThanOrEqual(budget)
              expect(selected.audit?.channels?.find((item) => item.name === "domains")?.state).toBe(
                routing ? "completed" : "disabled",
              )
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
  }
})

describe("procedure", () => {
  // Independently authored DEVELOPMENT inputs, not confirmatory evaluation data.
  const controls = [
    {
      name: "calibration",
      query: "How should technicians reset the sensor offset before restarting the conveyor?",
      lookup: "Where are sensor history and offset charts catalogued?",
      statements: [
        "Reset the sensor offset with the conveyor stopped.",
        "Before restarting the conveyor, record the reference reading.",
        "Technicians must keep the guard closed during calibration.",
      ],
      detail:
        "Use a certified gauge for this measurement. A second person signs the worksheet, which remains attached to the instrument throughout the maintenance visit.",
      distractor:
        "Conveyor overview: technicians, sensor history, offset charts, restarting schedules, reset terminology and calibration topics are catalogued here.",
    },
    {
      name: "restoration",
      query: "How do operators verify the archive manifest before restoring a damaged segment?",
      lookup: "Where are manifest formats and segment diagrams catalogued?",
      statements: [
        "Verify the archive manifest against its stored digest.",
        "Before restoring a damaged segment, quarantine the existing copy.",
        "Operators must retain the quarantine until validation completes.",
      ],
      detail:
        "Keep the incident ticket open throughout this procedure. A second person signs the recovery worksheet and attaches the diagnostic output to the ticket.",
      distractor:
        "Archive overview: operators, damaged media, manifest formats, restoring history, segment diagrams, verify terminology and validation topics are catalogued here.",
    },
    {
      name: "ownership",
      query: "Which team owns the optical alignment record and where is the reference copy stored?",
      lookup: "Where are team charts and reference diagrams catalogued?",
      statements: [
        "The metrology team owns the optical alignment record.",
        "The reference copy is stored in the instrument cabinet.",
        "The workshop ledger contains only an unverified duplicate.",
      ],
      detail:
        "Each sheet carries a serial number and the date of the last inspection. The custodian keeps superseded sheets in a separate drawer for historical comparison.",
      distractor:
        "Optical overview: alignment history, team charts, record formats, reference diagrams, copy terminology, stored reports and ownership topics are catalogued here.",
    },
  ] as const

  async function fixture(
    control: (typeof controls)[number],
    budget: number,
    routing?: "domains",
    query: string = control.query,
  ) {
    const dir = await mkdtemp(path.join(tmpdir(), "forge-procedure-"))

    const root = await realpath(dir)
    await mkdir(path.join(root, ".kilo"))
    await mkdir(path.join(root, "manuals"))
    await Bun.write(
      path.join(root, ".kilo/forge.jsonc"),
      JSON.stringify({ budget, exclude: [".kilo/**"], ...(routing ? { routing } : {}) }),
    )
    const originals = {
      "procedure.md": [...control.statements, control.detail].join("\n"),
      "overview.md": control.distractor,
      "unrelated.md":
        "Stop the label printer. Replace the ribbon. Check the paper tray before printing the shipping docket.",
    }
    for (const [name, text] of Object.entries(originals)) await Bun.write(path.join(root, "manuals", name), text)
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
      provider: async () => "development-provider",
      complete: async () => {
        throw new Error("Development retrieval must never invoke a model")
      },
    })
    try {
      const collection = await api.register({ kind: "folder", label: "Manuals", location: "./manuals", watch: false })
      await api.approve(collection.id, "", ["development-provider"])
      await api.index(collection.id)
      // retrieve settles the real asynchronous registration extraction job.
      const selected = await api.retrieve(query)
      const sources = await storage.knowledge(root, "", "development-provider")
      return {
        root,
        api,
        storage,
        sources,
        selected,
        originals,
        async [Symbol.asyncDispose]() {
          await api.dispose()
          db.close()
          await rm(root, { recursive: true, force: true })
        },
      }
    } catch (err) {
      await api.dispose()
      db.close()
      await rm(root, { recursive: true, force: true })
      throw err
    }
  }

  for (const control of controls) {
    for (const routing of [undefined, "domains"] as const) {
      test(`development ${control.name}: topical lookup, ${routing ?? "default"}`, async () => {
        await using f = await fixture(control, 600, routing, control.lookup)
        expect(f.selected.matches.some((item) => item.source.detail.document === "overview.md")).toBe(true)
        expect(f.selected.matches.some((item) => item.source.detail.document === "procedure.md")).toBe(false)
        expect(f.selected.tokens).toBe(tokens(f.selected.text))
        expect(f.selected.tokens).toBeLessThanOrEqual(600)
      })
      for (const budget of [600, 2400]) {
        test(`development ${control.name}: original obligations at ${budget} bytes, ${routing ?? "default"}`, async () => {
          await using f = await fixture(control, budget, routing)
          const original = f.sources.find(
            (item) => item.method === "collection-section" && item.detail.document === "procedure.md",
          )!
          expect(original).toBeDefined()
          expect(original.text).toBe(f.originals["procedure.md"])
          expect(
            tokens(render({ source: original, score: 1, reason: "development feasibility" })) + 1,
          ).toBeLessThanOrEqual(600)
          const distractor = f.sources.find(
            (item) => item.method === "collection-section" && item.detail.document === "overview.md",
          )!
          expect(
            tokens(render({ source: original, score: 1, reason: "" })) +
              tokens(render({ source: distractor, score: 1, reason: "" })) +
              2,
          ).toBeGreaterThan(600)
          const statements = control.statements.map((text) => ({
            text,
            covered: f.selected.matches.some((match) => match.source.text.includes(text)),
          }))

          expect(f.selected.tokens).toBe(tokens(f.selected.text))
          expect(f.selected.tokens).toBeLessThanOrEqual(budget)
          expect(f.selected.audit?.channels?.find((item) => item.name === "domains")?.state).toBe(
            routing ? "completed" : "disabled",
          )
          for (const match of f.selected.matches) {
            expect(match.source.method).toBe("collection-section")
            expect(match.source.status).toBe("current")
            expect(f.sources.find((source) => source.id === match.source.id)).toEqual(match.source)
            expect(Object.values(f.originals)).toContain(match.source.text)
          }
          expect(statements.filter((item) => !item.covered)).toEqual([])
          if (budget === 600) expect(f.selected.matches.map((item) => item.source.id)).toEqual([original.id])
        })
      }
    }
  }

  function score(text: string, query: string, metadata: Partial<Match["source"]> = {}) {
    const match: Match = {
      source: {
        id: "development",
        kind: "document",
        label: "",
        uri: "development:passage",
        hash: "development",
        text,
        start: 1,
        end: 1,
        observed: 0,
        method: "development",
        status: "current",
        inferred: false,
        evidence: [],
        detail: {},
        ...metadata,
      },
      score: 0.37,
      reason: "Development relevance control",
    }
    return select([match], 10000, "ranked", [], { text: query }).matches.at(0)!.score
  }

  test("development relationships reward ordered content without rewarding repetition", () => {
    const query = "inspect valve seal"
    const ordered = score("Inspect the valve seal.", query)
    const reversed = score("Seal valve inspect.", query)
    expect(ordered).toBeGreaterThan(reversed)
    expect(ordered).toBeLessThanOrEqual(2 * reversed)
    expect(score("Inspect the valve seal. ".repeat(20), query)).toBe(ordered)
    expect(score("Inspect the valve seal.", `${query}. ${query}.`)).toBe(ordered)
    expect(score("Inspect the valve seal.", `${query} ${query}`)).toBe(ordered)
    expect(score("Valve seal inspection.", "monitor valveSeal valveSeal")).toBe(
      score("Valve seal inspection.", "monitor valveSeal"),
    )
    expect(score("Valve valve valve.", "valve valve")).toBe(score("Valve valve valve.", "valve"))
  })

  test("development relationships cannot be assembled across clauses or metadata", () => {
    const query = "inspect valve seal"
    const plain = score("Seal valve inspect.", query)
    expect(score("Inspect. Valve. Seal.", query)).toBe(plain)
    expect(score("Inspect, valve, seal.", query)).toBe(plain)
    expect(
      score("Seal valve inspect.", query, {
        label: query,
        uri: `development:${query}`,
        detail: { heading: query },
      }),
    ).toBe(plain)
  })

  test("development relationships preserve accent and camel-case normalization", () => {
    const query = "resume align valve seal"
    expect(score("Resume align valve seal.", query)).toBe(score("R\u00e9sum\u00e9Align valveSeal.", query))
    expect(score("Seal valve align resume.", query)).toBeLessThan(score("Resume align valve seal.", query))
  })

  test("development relationships preserve absent, single-term and nonliteral scores", () => {
    for (const query of ["", "the and", "valve", "gaskets"]) {
      expect(score("Inspect the valve seal.", query)).toBe(0.37)
    }
  })
})

describe("remediation", () => {
  // Remediation DEVELOPMENT only. Freeze this file before inspecting outcomes.
  // Relevance is specified independently for each query, not inferred from ranking.
  const controls = [
    {
      name: "observatory",
      originals: {
        "datum.md": "Measure antenna azimuth from the engraved north mark.",
        "approval.md": "The duty astronomer signs the alignment sheet.",
        "exhibit.md":
          "The museum explores antenna azimuth measurement and alignment sheet signatures through photographs of observatory life. Visitors can browse descriptions of old instruments and portraits from the opening ceremony.",
        "printer.md":
          "Disconnect the ticket printer before replacing its ribbon. Check the paper tray and restart the printer.",
      },
      queries: [
        {
          name: "answer",
          text: "How is antenna azimuth measured and who signs the alignment sheet?",
          required: ["datum.md", "approval.md"],
          relevant: ["datum.md", "approval.md"],
        },
        {
          name: "lookup",
          text: "Where can visitors browse photographs and portraits of observatory life?",
          required: ["exhibit.md"],
          relevant: ["exhibit.md"],
        },
      ],
    },
    {
      name: "laboratory",
      originals: {
        "blank.md": "Zero the spectrometer against a solvent blank before scanning.",
        "worksheet.md": "Record the blank reading on the spectrometer worksheet.",
        "history.md":
          "This essay discusses how to zero the spectrometer and record the blank reading as subjects in laboratory history. It compares the vocabulary used in old advertisements and reviews the changing appearance of scientific instruments.",
        "shipping.md":
          "Sign the delivery docket and weigh the carton before loading. Keep the receipt until the courier arrives.",
      },
      queries: [
        {
          name: "procedure",
          text: "How do I zero the spectrometer and record the blank reading?",
          required: ["blank.md"],
          relevant: ["blank.md", "worksheet.md"],
        },
        {
          name: "support",
          text: "Where do I record the spectrometer blank reading?",
          required: ["worksheet.md"],
          relevant: ["blank.md", "worksheet.md"],
        },
        {
          name: "history",
          text: "Which essay compares old advertisements for scientific instruments?",
          required: ["history.md"],
          relevant: ["history.md"],
        },
      ],
    },
    {
      name: "depot",
      originals: {
        "owner.md": "The signaling team owns the relay diagram.",
        "copy.md": "The certified diagram is kept in the west cabin.",
        "catalog.md":
          "Relay diagram ownership and certified diagram storage are themes of the depot catalog. Its captions describe historical drawing styles, cabin photographs and the changing duties of railway staff over several decades.",
        "repair.md": "Drain the water tank before opening the housing. Replace the gasket and tighten each screw.",
      },
      queries: [
        {
          name: "fact",
          text: "Who owns the relay diagram and where is the certified diagram kept?",
          required: ["owner.md", "copy.md"],
          relevant: ["owner.md", "copy.md"],
        },
        {
          name: "catalog",
          text: "Which catalog describes historical drawing styles and railway staff?",
          required: ["catalog.md"],
          relevant: ["catalog.md"],
        },
      ],
    },
    {
      name: "vault",
      originals: {
        "limit.md": "Seed vault humidity must remain below thirty percent.",
        "response.md": "If humidity rises, close the vault intake and notify the curator.",
        "review.md":
          "Seed vault humidity limits and intake responses appear in a review of botanical architecture. The review describes the appearance of storage rooms and compares floor plans from several gardens.",
        "kitchen.md":
          "Close the kitchen door and notify the cook before cleaning the oven. Check the gloves for damage.",
      },
      queries: [
        {
          name: "fact",
          text: "What is the seed vault humidity limit?",
          required: ["limit.md"],
          relevant: ["limit.md", "response.md"],
        },
        {
          name: "procedure",
          text: "What should happen if humidity rises in the seed vault?",
          required: ["response.md"],
          relevant: ["limit.md", "response.md"],
        },
        {
          name: "review",
          text: "Which review compares botanical architecture and garden floor plans?",
          required: ["review.md"],
          relevant: ["review.md"],
        },
      ],
    },
  ] as const

  for (const control of controls) {
    for (const objective of control.queries) {
      for (const format of ["prose", "markdown"] as const) {
        for (const routing of [undefined, "domains"] as const) {
          for (const budget of [600, 2400]) {
            test(`remediation ${control.name} ${objective.name} ${format} ${routing ?? "default"} ${budget}`, async () => {
              const dir = await mkdtemp(path.join(tmpdir(), "forge-remediation-"))

              const root = await realpath(dir)
              const db = new Database(":memory:")
              const storage = store({
                all: async (query) =>
                  db
                    .query<Record<string, unknown>, (string | number | null)[]>(query.text)
                    .all(...(query.values ?? [])),
                batch: async (queries) => {
                  db.transaction(() => {
                    for (const query of queries) db.query(query.text).run(...(query.values ?? []))
                  })()
                },
              })
              const api = engine({
                root,
                store: storage,
                provider: async () => "remediation-development",
                complete: async () => {
                  throw new Error("No model calls permitted in development")
                },
              })
              try {
                await mkdir(path.join(root, ".kilo"))
                await mkdir(path.join(root, "manuals"))
                await Bun.write(
                  path.join(root, ".kilo/forge.jsonc"),
                  JSON.stringify({ budget, exclude: [".kilo/**"], ...(routing ? { routing } : {}) }),
                )
                const originals = Object.fromEntries(
                  Object.entries(control.originals).map(([file, text]) => [
                    file,
                    format === "markdown" ? `# ${file.replace(".md", "")}\n\n${text}` : text,
                  ]),
                )
                for (const [file, text] of Object.entries(originals))
                  await Bun.write(path.join(root, "manuals", file), text)
                const collection = await api.register({
                  kind: "folder",
                  label: "Manuals",
                  location: "./manuals",
                  watch: false,
                })
                await api.approve(collection.id, "", ["remediation-development"])
                await api.index(collection.id)
                const selected = await api.retrieve(objective.text)
                const current = (await storage.knowledge(root, "", "remediation-development")).filter(
                  (item) => item.method === "collection-section",
                )
                const statements = objective.required.map((file) => ({
                  file,
                  text: Object.entries(control.originals)
                    .find(([key]) => key === file)!
                    .at(1),
                  covered: selected.matches.some((item) => item.source.detail.document === file),
                }))
                const precision = selected.matches.length
                  ? selected.matches.filter((item) =>
                      objective.relevant.some((file) => file === item.source.detail.document),
                    ).length / selected.matches.length
                  : 0
                const costs = current.map((source) => ({
                  file: source.detail.document,
                  bytes: tokens(render({ source, score: 1, reason: "" })) + 1,
                }))
                // Repeated requests exercise the actual store and retrieval path.
                const repeated = await api.retrieve(objective.text)
                const duplicate = await api.retrieve(`${objective.text} ${objective.text}`)

                expect(current).toHaveLength(4)
                expect(
                  costs
                    .filter((item) => objective.relevant.some((file) => file === item.file))
                    .reduce((sum, item) => sum + item.bytes, 0),
                ).toBeLessThanOrEqual(600)
                expect(selected.tokens).toBe(tokens(selected.text))
                expect(selected.tokens).toBeLessThanOrEqual(budget)
                expect(selected.audit?.channels?.find((item) => item.name === "domains")?.state).toBe(
                  routing ? "completed" : "disabled",
                )
                for (const item of selected.matches) {
                  expect(item.source.status).toBe("current")
                  expect(current.find((source) => source.id === item.source.id)).toEqual(item.source)
                  expect(Object.values(originals).some((text) => text.includes(item.source.text))).toBe(true)
                }
                expect(repeated.matches.map((item) => item.source.id)).toEqual(
                  selected.matches.map((item) => item.source.id),
                )
                expect(duplicate.matches.map((item) => item.source.id)).toEqual(
                  selected.matches.map((item) => item.source.id),
                )
                expect(statements.filter((item) => !item.covered)).toEqual([])
                if (budget === 600 && objective.relevant.length > 1) expect(precision).toBe(1)
              } finally {
                await api.dispose()
                db.close()
                await rm(root, { recursive: true, force: true })
              }
            })
          }
        }
      }
    }
  }

  test("remediation explicit code and symbol paths compete with incidental body terms", () => {
    for (const kind of ["code", "symbol"] as const) {
      const exact = {
        source: source("src/mesh/openChannel.ts", "export const state = new Map()", kind),
        score: 1,
        reason: "BM25 path match",
      }
      const incidental = {
        source: source("notes.md", "The mesh has an open channel in the illustration.", "document"),
        score: 1,
        reason: "BM25 content match",
      }
      const budget = Math.max(tokens(render(exact)), tokens(render(incidental))) + 1
      for (const method of ["ranked", "greedy", "knapsack"] as const) {
        expect(
          select([incidental, exact], budget, method, [], { text: exact.source.uri }).matches.map(
            (item) => item.source.id,
          ),
        ).toEqual([exact.source.id])
      }
    }
  })

  test("remediation topical overlap does not grow superlinearly", () => {
    const score = (text: string) =>
      select(
        [
          {
            source: source("notes.md", text, "document"),
            score: 1,
            reason: "keyword",
          },
        ],
        10000,
        "ranked",
        [],
        { text: "nebula cobalt prism quartz" },
      ).matches.at(0)!.score
    expect(score("Quartz prism cobalt nebula.")).toBeLessThanOrEqual(2 * score("Cobalt nebula."))
  })

  test.each([
    {
      name: "heading",
      uri: "reference.md",
      text: "# Zephyr protocol\n\nUse the numbered form.",
      query: "Zephyr protocol",
    },
    { name: "path", uri: "telemetry/retention.md", text: "Keep a signed copy.", query: "telemetry retention" },
    { name: "stem", uri: "policy.md", text: "Retries cease after three attempts.", query: "retry" },
    { name: "accent", uri: "building.md", text: "The caf\u00e9 opens at seven.", query: "cafe" },
    { name: "identifier", uri: "connect.ts", text: "export function openChannel() { return 1 }", query: "openChannel" },
  ])("remediation production lexical $name fallback remains available", async ({ uri, text, query }) => {
    const dir = await mkdtemp(path.join(tmpdir(), "forge-remediation-lexical-"))

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
      complete: async () => {
        throw new Error("No model calls permitted")
      },
    })
    try {
      await mkdir(path.join(root, ".kilo"))
      await mkdir(path.dirname(path.join(root, uri)), { recursive: true })
      await Bun.write(path.join(root, uri), text)
      for (const routing of [undefined, "domains"] as const) {
        for (const budget of [600, 2400]) {
          await Bun.write(
            path.join(root, ".kilo/forge.jsonc"),
            JSON.stringify({ budget, exclude: [".kilo/**"], ...(routing ? { routing } : {}) }),
          )
          await api.refresh(true)
          const selected = await api.retrieve(query)
          expect(selected.matches.some((item) => item.source.uri === uri)).toBe(true)
          expect(selected.matches.every((item) => item.source.status === "current")).toBe(true)
          expect(selected.tokens).toBe(tokens(selected.text))
          expect(selected.tokens).toBeLessThanOrEqual(budget)
        }
      }
    } finally {
      await api.dispose()
      db.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
