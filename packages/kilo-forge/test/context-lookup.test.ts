import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { render, select } from "../src/context"
import { engine } from "../src/engine"
import { source } from "../src/parse"
import { store } from "../src/store"
import { tokens, keywords } from "../src/util"
import { route } from "../src/domains"
import { stem } from "../src/stem"

describe("context-inflections", () => {
  // Author-written development controls, frozen before candidate implementation.
  const controls = [
    ["retry request transaction", "retrying requests transactions", "retried requests transactions"],
    ["validate checkpoint checksum", "validating checkpoints checksums", "validated checkpoints checksums"],
    ["configure connection timeout", "configuring connections timeouts", "configured connections timeouts"],
    ["manage directory permission", "managing directories permissions", "managed directories permissions"],
    ["serialize record message", "serializing records messages", "serialized records messages"],
  ]

  for (const method of ["ranked", "greedy", "knapsack"] as const) {
    for (const queries of controls) {
      test(`${method}: document inflections preserve SQLite-equivalent query scores: ${queries.at(0)}`, () => {
        const db = new Database(":memory:")
        const text = `${queries.at(0)}.`
        const original = { source: source("manual:a", text, "document"), score: 0.37, reason: "Keyword evidence" }
        try {
          db.exec("CREATE VIRTUAL TABLE entries USING fts5(content, tokenize='porter unicode61')")
          db.query("INSERT INTO entries VALUES (?)").run(text)
          const results = queries.map((text) => {
            expect(db.query("SELECT count(*) AS count FROM entries WHERE entries MATCH ?").get(text)).toEqual({
              count: 1,
            })
            const selected = select([original], 600, method, [], { text })
            expect(selected.matches.at(0)?.source).toBe(original.source)
            expect(selected.tokens).toBe(tokens(selected.text))
            return selected.matches.at(0)!.score
          })
          expect(results).toEqual(results.map(() => results.at(0)!))
        } finally {
          db.close()
        }
      })
    }

    test(`${method}: inflected evidence outranks a weaker exact word without discarding either`, () => {
      const original = {
        source: source("manual:z", "The handler retries requests and preserves transaction identifiers.", "document", {
          method: "collection-section",
        }),
        score: 1,
        reason: "Keyword evidence",
      }
      const weak = {
        source: source("manual:a", "A request is a form in the visitor register.", "document", {
          method: "collection-section",
        }),
        score: 1,
        reason: "Keyword evidence",
      }
      const query = { text: "retry request transaction identifier" }
      const budget = Math.max(...[original, weak].map((match) => tokens(render(match)) + 1))
      for (const matches of [
        [weak, original],
        [original, weak],
      ]) {
        const before = structuredClone(matches)
        const selected = select(matches, budget, method, [], query)
        expect(selected.matches.map((match) => match.source)).toEqual([original.source])
        expect(selected.tokens).toBeLessThanOrEqual(budget)
        expect(select(matches, 2400, method, [], query).matches).toHaveLength(2)
        expect(select(matches, budget, method, [weak.source.id], query).matches.at(0)?.source).toBe(weak.source)
        expect(matches).toEqual(before)
      }
    })

    test(`${method}: registered inflections retain exact citations, exclusions and provider scope`, async () => {
      const root = await realpath(await mkdtemp(path.join(tmpdir(), "forge-inflection-registration-")))
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
          throw new Error("No model calls permitted")
        },
      })
      const query = "retry request transaction identifier"
      const text = "The handler retries requests and preserves transaction identifiers."
      try {
        const config = { selector: method, exclude: [".kilo/**", "manuals/**"] }
        await Bun.write(path.join(root, ".kilo/forge.jsonc"), JSON.stringify(config))
        await Bun.write(path.join(root, "manuals/a.md"), "A request is a form in the visitor register.")
        await Bun.write(path.join(root, "manuals/z.md"), text)
        const collection = await api.register({ kind: "folder", location: "./manuals", label: "Manuals", watch: false })
        await api.approve(collection.id, "", ["development"])
        await api.index(collection.id)
        await api.retrieve(query)
        const originals = (await storage.knowledge(root, "", "development")).filter(
          (item) => item.method === "collection-section",
        )
        expect(originals).toHaveLength(2)
        const budget = Math.max(...originals.map((source) => tokens(render({ source, score: 1, reason: "" })) + 1))
        await Bun.write(path.join(root, ".kilo/forge.jsonc"), JSON.stringify({ ...config, budget }))
        await api.refresh(true)
        const original = originals.find((item) => item.text === text)!
        const selected = await api.retrieve(query)
        expect(selected.audit?.channels?.find((item) => item.name === "keyword")).toMatchObject({
          state: "completed",
          candidates: 2,
        })
        expect(selected.matches.map((match) => match.source)).toEqual([original])
        expect(selected.tokens).toBe(tokens(selected.text))
        expect((await api.retrieve("unrelated", { pin: [original.id] })).matches.at(0)?.source).toEqual(original)
        expect(
          (await api.retrieve(query, { exclude: [original.id] })).matches.every(
            (item) => item.source.id !== original.id,
          ),
        ).toBe(true)
        expect((await api.retrieve(query, { provider: "other" })).matches).toEqual([])
        expect(
          (await storage.knowledge(root, "", "development")).filter((item) => item.method === "collection-section"),
        ).toEqual(originals)
      } finally {
        await api.dispose()
        db.close()
        await rm(root, { recursive: true, force: true })
      }
    })
  }

  test("literal identifiers and nonliteral incoming relevance are not broadened by stemming", () => {
    const score = (query: string, text: string, kind: "document" | "code" = "document") =>
      select(
        [
          {
            source: source("manual:a", text, kind),
            score: 0.37,
            reason: "Semantic evidence",
          },
        ],
        600,
        "ranked",
        [],
        { text: query },
      ).matches.at(0)!.score
    expect(score("requests_config", "request configure")).toBe(0.37)
    expect(score("request_config", "requests configuration")).toBe(0.37)
    expect(score("requests_messages", "request message")).toBe(0.37)
    expect(score("r\u00e9quests_m\u00e9ssages", "request message")).toBe(0.37)
    expect(score("credential rotation", "Reissue expired identities.")).toBe(0.37)
    expect(score("retry request transaction", "retrying requests transactions", "code")).toBe(0.37)
  })
})

describe("context-initialisms", () => {
  const controls = [
    { query: "reload http server", plain: "Reload HTTP server.", names: ["HTTPServer", "httpServer"] },
    { query: "renew tls handshake", plain: "Renew TLS handshake.", names: ["TLSHandshake", "tlsHandshake"] },
    { query: "reset xml reader", plain: "Reset XML reader.", names: ["XMLReader", "xmlReader"] },
    { query: "resume rest client", plain: "Resume REST client.", names: ["R\u00c9STClient", "RE\u0301STClient"] },
  ]

  for (const control of controls) {
    for (const method of ["ranked", "greedy", "knapsack"] as const) {
      const verb = control.plain.split(" ").at(0)!
      test(`${method}: initialisms preserve plain-word relationship scores for ${control.query}`, () => {
        const score = (text: string) =>
          select(
            [
              {
                source: source("manual:a", text, "document"),
                score: 1,
                reason: "Original evidence",
              },
            ],
            2400,
            method,
            [],
            { text: control.query },
          ).matches.at(0)!.score
        const expected = score(control.plain)
        for (const name of control.names) {
          expect(score(`${verb} ${name}.`)).toBe(expected)
          expect(score(`${verb} ${name}. `.repeat(3))).toBe(expected)
          expect(score(`${verb} ${name}. Background operations.`)).toBeLessThan(expected)
        }
      })

      test(`${method}: initialism spelling cannot displace an affordable original for ${control.query}`, () => {
        const weak = {
          source: source("manual:b", `${control.plain} Background operations.`, "document"),
          score: 1.02,
          reason: "Original evidence",
        }
        for (const name of control.names) {
          const text = `${verb} ${name}.`
          const original = {
            source: source(
              "manual:a",
              text + " ".repeat(Buffer.byteLength(weak.source.text) - Buffer.byteLength(text)),
              "document",
            ),
            score: 1,
            reason: "Original evidence",
          }
          const matches = [weak, original]
          const before = structuredClone(matches)
          const budget = Math.max(...matches.map((item) => tokens(render(item)) + 1))
          for (const ordered of [matches, [...matches].reverse()]) {
            const selected = select(ordered, budget, method, [], { text: control.query })
            expect(selected.matches.map((item) => item.source)).toEqual([original.source])
            expect(selected.tokens).toBe(tokens(selected.text))
            expect(selected.tokens).toBeLessThanOrEqual(budget)
            expect(
              select(ordered, budget, method, [weak.source.id], { text: control.query }).matches.at(0)?.source,
            ).toBe(weak.source)
            expect(select(ordered, 2400, method, [], { text: control.query }).matches).toHaveLength(2)
          }
          expect(matches).toEqual(before)
        }
      })
    }
  }

  test("initialism literals retain identifier stopwords and incoming nonliteral relevance", () => {
    for (const method of ["ranked", "greedy", "knapsack"] as const) {
      const score = (text: string) =>
        select(
          [
            {
              source: source("manual:a", text, "document"),
              score: 1,
              reason: "Original evidence",
            },
          ],
          2400,
          method,
          [],
          { text },
        ).matches.at(0)!.score
      expect(score("IFConfig")).toBe(score("ifConfig"))
      const item = {
        source: source("manual:a", "Reissue expired credentials.", "document"),
        score: 0.37,
        reason: "Semantic evidence",
      }
      for (const text of ["identity rollover", "IFConfig", "HTTPServer", "", "the and"]) {
        const selected = select([item], 600, method, [], { text })
        expect(selected.matches.at(0)?.source).toBe(item.source)
        expect(selected.matches.at(0)?.score).toBe(item.score)
      }
    }
  })

  for (const method of ["ranked", "greedy", "knapsack"] as const) {
    test(`${method}: production initialism ranking preserves current registered originals`, async () => {
      const root = await realpath(await mkdtemp(path.join(tmpdir(), "forge-initialisms-")))
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
          throw new Error("No model calls permitted")
        },
      })
      try {
        const config = { selector: method, exclude: [".kilo/**", "manuals/**"] }
        await Bun.write(path.join(root, ".kilo/forge.jsonc"), JSON.stringify(config))
        await Bun.write(path.join(root, "manuals/a.md"), "Reload HTTPServer.")
        await Bun.write(path.join(root, "manuals/b.md"), "Reload HTTP server. Background operations.")
        const collection = await api.register({ kind: "folder", location: "./manuals", label: "Manuals", watch: false })
        await api.approve(collection.id, "", ["development"])
        await api.index(collection.id)
        await api.retrieve("reload http server")
        const originals = (await storage.knowledge(root, "", "development")).filter(
          (item) => item.method === "collection-section",
        )
        expect(originals).toHaveLength(2)
        const budget = Math.max(...originals.map((source) => tokens(render({ source, score: 1, reason: "" })) + 1))
        await Bun.write(path.join(root, ".kilo/forge.jsonc"), JSON.stringify({ ...config, budget }))
        await api.refresh(true)
        const selected = await api.retrieve("reload http server")
        expect(selected.audit?.channels?.find((item) => item.name === "keyword")?.state).toBe("completed")
        const original = originals.find((item) => item.text === "Reload HTTPServer.")!
        expect(selected.matches.map((item) => item.source)).toEqual([original])
        expect(selected.tokens).toBe(tokens(selected.text))
        expect(selected.tokens).toBeLessThanOrEqual(budget)
        expect((await api.retrieve("unrelated", { pin: [original.id] })).matches.at(0)?.source).toEqual(original)
        expect(
          (await api.retrieve("reload http server", { exclude: [original.id] })).matches.every(
            (item) => item.source.id !== original.id,
          ),
        ).toBe(true)
        expect((await api.retrieve("reload http server", { provider: "other" })).matches).toEqual([])
        const before = structuredClone(originals)
        expect(
          (await storage.knowledge(root, "", "development")).filter((item) => item.method === "collection-section"),
        ).toEqual(before)
      } finally {
        await api.dispose()
        db.close()
        await rm(root, { recursive: true, force: true })
      }
    })
  }
})

describe("literal-lookup", () => {
  test("distinct structured lookup retains common words without restoring prose stopwords", () => {
    expect(keywords("find src/with.ts")).toContain("with")
    expect(keywords("find withThis")).toEqual(expect.arrayContaining(["with", "this"]))
    expect(keywords("find with_this")).toEqual(expect.arrayContaining(["with", "this"]))
    expect(keywords("find with this guide")).toEqual(["find", "guide"])
    const exact = source("src/with/this.ts", "export const result = 1", "code")
    const brief = source("domain:src/with", `Files: ${exact.uri}`, "summary", {
      method: "domain-index",
      evidence: [exact.id],
    })
    expect(route(exact.uri, [brief, exact]).some((item) => item.source.id === exact.id)).toBe(true)
  })
})

describe("stem", () => {
  test("English word families agree with the actual SQLite Porter tokenizer", () => {
    const words = `caresses ponies ties caress cats feed agreed disabled matting mating meeting milling messing meetings
    sky fly by cry happy relational conditional rational valenci hesitanci digitizer conformabli radicalli
    differentli vileli analogousli vietnamization predication operator feudalism decisiveness hopefulness
    callousness formaliti sensitiviti sensibiliti triplicate formative formalize electriciti electrical
    hopeful goodness revival allowance inference airliner gyroscopic adjustable defensible irritant
    replacement adjustment dependent adoption homologou communism activate angulariti homologous
    effective bowdlerize probate rate cease controll roll hopping tanned falling hissing fizzed failing
    filing invoke invoking invoked retry retrying retries retried request requests transaction transactions
    validate validating validated checkpoint checkpoints checksum checksums configure configuring configured
    connection connections timeout timeouts manage managing managed directory directories permission permissions
    serialize serializing serialized record records message messages identifiers identifier control controls
    safety safe news series species drive driven driving cooldown approval settlement acknowledgement
    hydraulic electronics access accessing memory memories policy policies freshness retrieval selection
    scanner scanning scanned document documentation denied denial remove removal publication publishing
    extraneous numbers boolean pythons javascript typescript sqlite http xml tls topology biology geology`
      .split(/\s+/)
      .filter(Boolean)
    const db = new Database(":memory:")
    try {
      db.exec("CREATE VIRTUAL TABLE entries USING fts5(content, tokenize='porter unicode61')")
      db.exec("CREATE VIRTUAL TABLE vocabulary USING fts5vocab(entries, instance)")
      for (const [index, word] of words.entries())
        db.query("INSERT INTO entries(rowid, content) VALUES (?, ?)").run(index + 1, word)
      for (const [index, word] of words.entries()) {
        expect({ word, stem: stem(word) }).toEqual({
          word,
          stem: db.query<{ term: string }, number>("SELECT term FROM vocabulary WHERE doc = ?").get(index + 1)!.term,
        })
      }
    } finally {
      db.close()
    }
  })

  test("unsupported and bounded tokens remain unchanged", () => {
    for (const word of ["", "a", "is", "42", "HTTP", "request_config", "file.ts", "r\u00e9sum\u00e9", "a".repeat(65)]) {
      expect(stem(word)).toBe(word)
    }
  })
})
