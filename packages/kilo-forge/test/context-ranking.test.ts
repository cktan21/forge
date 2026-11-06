import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fuse, render, select } from "../src/context"
import { engine } from "../src/engine"
import { knowledge } from "../src/knowledge"
import { source } from "../src/parse"
import { store } from "../src/store"
import { tokens } from "../src/util"

describe("context-query", () => {
  test("query relevance beats cheap weak hits and relationship corroboration without rewriting evidence", () => {
    const relevant = {
      source: source("guide.md", "Reconnect sessions after transient disconnects using bounded jitter.", "document"),
      score: 1,
      reason: "keyword",
    }
    const weak = { source: source("settings.ts", "export const reconnect = true", "code"), score: 1, reason: "keyword" }
    const noise = { source: source("layout.md", "The panel is amber.", "document"), score: 1, reason: "keyword" }
    const candidates = fuse([fuse([[relevant, weak, noise]]), [weak]])
    const before = structuredClone(candidates)
    const budget = tokens(render(relevant)) + 1
    expect(tokens(render(weak))).toBeLessThan(tokens(render(relevant)))
    expect(candidates.at(0)?.source.id).toBe(weak.source.id)
    for (const method of ["ranked", "greedy", "knapsack"] as const) {
      const result = select(candidates, budget, method, [], { text: "Find the transient reconnect disconnects policy" })
      expect(result.matches.map((item) => item.source)).toEqual([relevant.source])
      expect(result.matches.at(0)?.source).toBe(relevant.source)
      expect(result.reasons?.[noise.source.id]).toBe("Not selected within the evidence budget")
      expect(result.tokens).toBe(tokens(result.text))
      expect(result.tokens).toBeLessThanOrEqual(budget)
    }
    expect(candidates).toEqual(before)
  })

  test("distinct whole terms handle identifiers and Unicode without substring or repetition boosts", () => {
    const candidates = [
      source("a.md", "\u7f51\u7edc \u8d85\u65f6 reconnectSession", "document"),
      source("b.md", "\u7f51\u7edc ".repeat(100), "document"),
      source("c.md", "interconnected sessions", "document"),
    ].map((source) => ({ source, score: 1, reason: "keyword" }))
    const result = select(candidates, 10_000, "ranked", [], {
      text: "\u7f51\u7edc \u8d85\u65f6 reconnectSession reconnectSession",
    })
    expect(result.matches.at(0)!.score).toBeGreaterThan(1)
    expect(result.matches.slice(1).map((item) => item.score)).toEqual([1, 1])
    expect(select(candidates, 10_000, "ranked", [], { text: "\u7f51\u7edc \u8d85\u65f6 reconnectSession" })).toEqual(
      result,
    )
    expect(result.matches.map((item) => item.source)).toEqual(candidates.map((item) => item.source))
    expect(result.omitted).toEqual([])
  })

  test("non-lexical candidates remain eligible but still obey freshness and budget", () => {
    const candidates = [
      { source: source("a.md", "Credential rotation procedure.", "document"), score: 1, reason: "semantic" },
      {
        source: { ...source("b.md", "Outdated instruction.", "document"), status: "stale" as const },
        score: 100,
        reason: "memory",
      },
      { source: source("c.md", "Large unrelated material.".repeat(100), "document"), score: 100, reason: "dependency" },
    ]
    for (const method of ["ranked", "greedy", "knapsack"] as const) {
      const result = select(candidates, 200, method, [], { text: "Explain identity rollover" })
      expect(result.matches.map((item) => item.source)).toEqual([candidates.at(0)!.source])
      expect(result.reasons?.[candidates.at(1)!.source.id]).toBe("Source is not current")
      expect(result.tokens).toBeLessThanOrEqual(200)
    }
  })

  test("required unrelated pins reserve budget without pruning other channel evidence", () => {
    const candidates = ["amber", "teal", "violet"].map((text) => ({
      source: source(`${text}.md`, text, "document"),
      score: 1,
      reason: "keyword",
    }))
    const pin = candidates.at(0)!
    for (const method of ["ranked", "greedy", "knapsack"] as const) {
      const result = select(candidates, tokens(render(pin)) + 1, method, [pin.source.id], {
        text: "Explain credentials",
      })
      expect(result.matches.map((item) => item.source)).toEqual([pin.source])
      expect(result.reasons?.[candidates.at(1)!.source.id]).toBe("Not selected within the evidence budget")
      expect(select(candidates, 1000, method, [pin.source.id], { text: "Explain credentials" }).matches).toHaveLength(3)
      expect(() => select(candidates, 1, method, [pin.source.id], { text: "credentials" })).toThrow(
        "Pinned excerpts need",
      )
      expect(() => select(candidates, 1000, method, ["missing"], { text: "credentials" })).toThrow(
        "Pinned excerpt is unavailable",
      )
    }
  })

  test("query-free and non-substantive queries preserve original selection behavior", () => {
    const candidates = ["amber", "teal"].map((text, score) => ({
      source: source(`${text}.md`, text, "document"),
      score,
      reason: "overview",
    }))
    for (const method of ["ranked", "greedy", "knapsack"] as const) {
      const original = select(candidates, 1000, method)
      expect(select(candidates, 1000, method, [], { text: "" })).toEqual(original)
      expect(select(candidates, 1000, method, [], { text: "the and for" })).toEqual(original)
      expect(select(candidates, 1000, method, [], { text: "reconnect" })).toEqual(original)
    }
  })

  test("complete query terms and metadata remain meaningful beyond former truncation limits", () => {
    const item = source(
      `${"directory/".repeat(30)}needle/signal.md`,
      `${"padding ".repeat(1000)}needle signal`,
      "document",
      {
        label: `${"x".repeat(240)} longIdentifier`,
        detail: { heading: `${"x".repeat(240)} hidden heading` },
      },
    )
    const candidates = [{ source: item, score: 1, reason: "keyword" }]
    expect(select(candidates, 20_000, "ranked", [], { text: "needle" }).matches.at(0)?.source).toBe(item)
    for (const text of [
      "hidden heading",
      "longIdentifier",
      item.uri,
      `${"absent ".repeat(1000)}needle signal`,
      `${Array.from({ length: 65 }, (_, index) => `absent${index}`).join(" ")} needle signal`,
    ]) {
      const result = select(candidates, 20_000, "ranked", [], { text })
      expect(result.matches.at(0)?.source).toBe(item)
      expect(result.matches.at(0)!.score).toBeGreaterThan(1)
    }
  })

  test("query ranking preserves affordable children when an overlapping parent cannot fit", () => {
    const parent = {
      source: source("a.ts", `connect session ${"padding ".repeat(1000)}`, "code", { start: 1, end: 100 }),
      score: 100,
      reason: "keyword",
    }
    const child = {
      source: source("a.ts", "connect session", "symbol", { id: "child", start: 5, end: 5 }),
      score: 1,
      reason: "keyword",
    }
    for (const method of ["ranked", "greedy", "knapsack"] as const) {
      const result = select([parent, child], 200, method, [], { text: "connect session" })
      expect(result.matches.map((item) => item.source.id)).toEqual(["child"])
      expect(result.tokens).toBeLessThanOrEqual(200)
    }
  })

  test.each([
    { name: "Porter stemming", query: "retry", uri: "guide.md", text: "Retries stop after exhaustion." },
    { name: "reverse stemming", query: "retries", uri: "guide.md", text: "Retry after exhaustion." },
    { name: "directory path", query: "billing", uri: "billing/guide.md", text: "Use bounded waits." },
    { name: "Unicode diacritics", query: "cafe", uri: "guide.md", text: "The caf\u00e9 closes at noon." },
    { name: "decomposed diacritics", query: "cafe", uri: "guide.md", text: "The cafe\u0301 closes at noon." },
    {
      name: "complete identifier",
      query: "reconnectSession",
      uri: "guide.md",
      text: "Use reconnectSession after disconnects.",
    },
  ])("production preserves keyword $name matches through query selection", async ({ query, uri, text }) => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "forge-query-keyword-")))
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
      await mkdir(path.dirname(path.join(root, uri)), { recursive: true })
      await mkdir(path.join(root, ".kilo"))
      await Bun.write(path.join(root, uri), text)
      for (const budget of [600, 2400]) {
        await Bun.write(
          path.join(root, ".kilo/forge.jsonc"),
          JSON.stringify({ budget, exclude: [".kilo/forge.jsonc"] }),
        )
        await api.refresh(true)
        const keywords = await storage.search(root, query)
        expect(keywords.some((match) => match.source.uri === uri)).toBe(true)
        for (const method of ["ranked", "greedy", "knapsack"] as const) {
          const selected = select(keywords, budget, method, [], { text: query })
          expect(selected.matches.some((match) => match.source.uri === uri)).toBe(true)
          expect(
            selected.matches.every((match) =>
              keywords.some((item) => item.source === match.source && match.score >= item.score),
            ),
          ).toBe(true)
          expect(selected.tokens).toBe(tokens(selected.text))
          expect(selected.tokens).toBeLessThanOrEqual(budget)
        }
        const selected = await api.retrieve(query)
        expect(selected.audit?.channels?.find((channel) => channel.name === "keyword")?.candidates).toBeGreaterThan(0)
        expect(selected.matches.some((match) => match.source.uri === uri)).toBe(true)
        expect(selected.tokens).toBeLessThanOrEqual(budget)
      }
    } finally {
      await api.dispose()
      db.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  test("production preserves associated public documentation without literal overlap and respects exclusions", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "forge-query-public-")))
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
      await Bun.write(
        path.join(root, ".kilo/forge.jsonc"),
        JSON.stringify({ budget: 600, exclude: [".kilo/forge.jsonc"] }),
      )
      await Bun.write(path.join(root, "transport.ts"), "export const endpoint = true")
      await Bun.write(path.join(root, "guide.md"), "transport requires bounded waits.")
      for (const query of ["Add public endpoint throttling", "endpoint"]) {
        const selected = await api.retrieve(query)
        expect(selected.matches.some((match) => match.source.uri === "guide.md")).toBe(true)
        expect(selected.tokens).toBeLessThanOrEqual(600)
        const excluded = selected.matches
          .filter((match) => match.source.uri === "guide.md")
          .map((match) => match.source.id)
        const blocked = await api.retrieve(query, { exclude: excluded })
        expect(blocked.matches.every((match) => !excluded.includes(match.source.id))).toBe(true)
        expect(selected.audit?.channels?.find((channel) => channel.name === "public-docs")?.candidates).toBeGreaterThan(
          0,
        )
      }
    } finally {
      await api.dispose()
      db.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  test("production query selection preserves original citations, default routing, pins, authorization and scope", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "forge-query-")))
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
    const library = knowledge(root, storage)
    let denied = false
    const api = engine({
      root,
      store: storage,
      provider: async () => "approved",
      authorize: async () => {
        if (denied) throw new Error("Denied")
      },
      complete: async () => {
        throw new Error("No model calls permitted")
      },
    })
    try {
      await mkdir(path.join(root, ".kilo"))
      await Bun.write(
        path.join(root, ".kilo/forge.jsonc"),
        JSON.stringify({ budget: 600, exclude: [".kilo/forge.jsonc"] }),
      )
      const item = await api.register({
        kind: "upload",
        label: "Connection guide",
        location: "guide.md",
        session: "chat",
        content: Buffer.from(
          "# Appearance\nThe panel is amber.\n# Connections\nReconnect sessions after transient disconnects using bounded jitter.",
        ).toString("base64"),
      })
      await api.approve(item.id, "chat", ["approved"])
      await library.index(item.id, "chat")
      const originals = await storage.knowledge(root, "chat", "approved")
      const relevant = originals.find((item) => item.detail.heading === "Connections")!
      const noise = originals.find((item) => item.detail.heading === "Appearance")!
      const query = "Find the transient reconnect disconnects policy"
      const result = await api.retrieve(query, { session: "chat" })
      expect(result.matches.find((item) => item.source.id === relevant.id)?.source).toEqual(relevant)
      expect(result.tokens).toBeLessThanOrEqual(600)
      expect(result.audit?.channels?.find((item) => item.name === "domains")?.state).toBe("disabled")
      expect(result.reasons?.[noise.id]).not.toBe("No substantive query-term overlap")
      expect((await api.retrieve(query, { session: "other" })).matches).toEqual([])
      expect((await api.retrieve(query, { session: "chat", provider: "other" })).matches).toEqual([])
      expect(
        (await api.retrieve(query, { session: "chat", exclude: [relevant.id] })).matches.every(
          (item) => item.source.id !== relevant.id,
        ),
      ).toBe(true)
      await api.configure({ ...(await api.policy("chat")), pin: [noise.id] })
      expect((await api.retrieve(query, { session: "chat" })).matches.some((item) => item.source.id === noise.id)).toBe(
        true,
      )
      const failure = await api.retrieve(query, { session: "chat", exclude: [noise.id] }).then(
        () => undefined,
        (err: unknown) => err,
      )
      expect(String(failure)).toContain("Pinned excerpt is excluded")
      await api.configure({ ...(await api.policy("chat")), pin: [] })
      denied = true
      const blocked = await api.retrieve(query, { session: "chat" })
      expect(blocked.matches).toEqual([])
      expect(blocked.audit?.candidates).toEqual([])
      expect(JSON.stringify(blocked)).not.toContain(relevant.id)
    } finally {
      await Promise.all([api.dispose(), library.dispose()])
      db.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  test("production retains semantic, typed memory and dependency documentation without lexical overlap", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "forge-query-channels-")))
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
    const code = source("auth.ts", "export const secret = 1", "code")
    const memory = source("memory:chat", "Rotate credentials periodically.", "document", {
      method: "kilo-memory-recall",
      detail: { session: "chat" },
    })
    const docs = source("documentation:manual", "Reissue expired credentials.", "document", {
      method: "dependency-docs",
    })
    const hidden = source("documentation:private", "Private credentials.", "document", {
      method: "dependency-docs",
      detail: { session: "other" },
    })
    const api = engine({
      root,
      store: storage,
      semantic: async () => [{ source: code, score: 1, reason: "Embedding similarity" }],
      memory: async () => [memory],
      docs: async () => [docs, hidden],
      complete: async () => {
        throw new Error("No model calls permitted")
      },
    })
    try {
      await Bun.write(path.join(root, code.uri), code.text)
      const result = await api.retrieve("identity rollover", { session: "chat", docs: true })
      expect(result.matches.map((item) => item.source.text).sort()).toEqual([code.text, memory.text, docs.text].sort())
      expect(
        result.audit?.channels
          ?.filter((item) => ["semantic", "memory"].includes(item.name))
          .every((item) => item.candidates === 1),
      ).toBe(true)
      expect(JSON.stringify(result)).not.toContain(hidden.id)
      expect(JSON.stringify(result)).not.toContain(hidden.text)
      const excluded = result.matches.map((item) => item.source.id)
      const blocked = await api.retrieve("identity rollover", { session: "chat", docs: true, exclude: excluded })
      expect(blocked.matches.every((item) => !excluded.includes(item.source.id))).toBe(true)
      await Bun.write(path.join(root, code.uri), "export const changed = 2")
      const stale = await api.retrieve("identity rollover", { session: "chat" })
      expect(stale.matches.every((item) => item.source.text !== code.text)).toBe(true)
    } finally {
      await api.dispose()
      db.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("context-relevance", () => {
  test("common query words cannot displace two affordable discriminative passages", () => {
    const first = {
      source: source("a.md", "Quasar masking removes identifying material from the index.", "document"),
      score: 1 / 61,
      reason: "keyword",
    }
    const second = {
      source: source("b.md", "Quasar retirement clears persisted entries before completion.", "document"),
      score: 1 / 62,
      reason: "keyword",
    }
    const weak = {
      source: source("c.md", "Operators must verify the display before starting any operation.", "document"),
      score: 1 / 65,
      reason: "keyword",
    }
    const background = Array.from({ length: 8 }, (_, index) => ({
      source: source(`notes/${index}.md`, `Staff must record station ${index} status before opening.`, "document"),
      score: 1 / (70 + index),
      reason: "keyword",
    }))
    const candidates = [first, second, weak, ...background]
    const before = structuredClone(candidates)
    const minimum = tokens(render(first)) + tokens(render(second)) + 2
    const query = { text: "What must quasar masking exclude, and what happens before quasar retirement completes?" }
    for (const method of ["ranked", "greedy", "knapsack"] as const) {
      for (const matches of [candidates, [...candidates].reverse()]) {
        for (const budget of [minimum, minimum + 17, minimum + 43]) {
          const result = select(matches, budget, method, [], query)
          expect(result.matches.map((match) => match.source.id).sort()).toEqual(
            [first.source.id, second.source.id].sort(),
          )
          expect(result.tokens).toBe(tokens(result.text))
          expect(result.tokens).toBeLessThanOrEqual(budget)
        }
      }
    }
    expect(candidates).toEqual(before)
  })

  test("document frequency ignores duplicate views, repetition, stale sources and input order", () => {
    const first = { source: source("guide.md", "Quasar masking retirement.", "document"), score: 1, reason: "keyword" }
    const second = { source: source("notes.md", "Masking settings.", "document"), score: 1, reason: "keyword" }
    const candidates = [first, second]
    const query = { text: "quasar masking retirement" }
    const original = select(candidates, 10000, "ranked", [], query)
    const duplicate = {
      ...first,
      source: { ...first.source, id: "window", start: 1, end: 2, text: first.source.text.repeat(8) },
    }
    const stale = { ...first, source: { ...first.source, id: "stale", uri: "old.md", status: "stale" as const } }
    for (const matches of [
      [...candidates, duplicate, stale],
      [stale, duplicate, second, first],
      [...candidates, first, first],
    ]) {
      const result = select(matches, 10000, "ranked", [], query)
      expect(result.matches.map((match) => match.score)).toEqual(original.matches.map((match) => match.score))
      expect(result.matches.map((match) => match.source.uri)).toEqual(original.matches.map((match) => match.source.uri))
    }
  })

  test("common-only overlap preserves the incoming relevance margin without a lexical gate", () => {
    const candidates = [
      { source: source("a.md", "Credential rotation.", "document"), score: 3, reason: "semantic" },
      {
        source: source("b.md", "Operators must check status before starting.", "document"),
        score: 2,
        reason: "keyword",
      },
      ...Array.from({ length: 8 }, (_, index) => ({
        source: source(`notes/${index}.md`, `Staff must check station ${index} before use.`, "document"),
        score: 1,
        reason: "keyword",
      })),
    ]
    const query = { text: "What must happen before identity rollover?" }
    for (const method of ["ranked", "greedy", "knapsack"] as const) {
      for (const budget of [170, 319, 701, 3000]) {
        expect(select(candidates, budget, method, [], query)).toEqual(select(candidates, budget, method))
      }
    }
  })

  test("frequency weighting is independent of budget and a unique full identifier stays useful", () => {
    const first = {
      source: source("a.md", "Use reconnectSession for bounded reconnects.", "document"),
      score: 1,
      reason: "keyword",
    }
    const weak = { source: source("b.md", "Reconnect settings.", "document"), score: 1, reason: "keyword" }
    const query = { text: "reconnectSession" }
    const minimum = tokens(render(first)) + 1
    const scores = [minimum, minimum + 1, minimum * 2, minimum * 4].map((budget) => {
      const result = select([weak, first], budget, "ranked", [], query)
      expect(result.matches.at(0)?.source).toBe(first.source)
      return result.matches.at(0)!.score
    })
    expect(new Set(scores).size).toBe(1)
    expect(scores.at(0)!).toBeGreaterThan(first.score)
  })
})

describe("context-pair-density", () => {
  // Supplemental implementation checks, not pre-edit frozen development controls.
  test("pair credit is bounded by body density without suppressing base relevance", () => {
    const score = (text: string, kind: "document" | "code" = "document") =>
      select(
        [
          {
            source: source("guide.md", text, kind),
            score: 1,
            reason: "development",
          },
        ],
        2400,
        "ranked",
        [],
        { text: "inspect valve seal" },
      ).matches.at(0)!.score
    const compact = "Inspect the valve seal."
    const expanded = `${compact} Additional background describes materials, manufacturers, suppliers and historical installations.`
    const reversed =
      "Seal valve inspect. Additional background describes materials, manufacturers, suppliers and historical installations."
    expect(score(compact)).toBeGreaterThan(score(expanded))
    expect(score(expanded)).toBeGreaterThan(score(reversed))
    expect(score(reversed)).toBe(6)
    expect(score(`${expanded} `.repeat(5))).toBe(score(expanded))
    expect(score(compact, "code")).toBe(score(expanded, "code"))
  })

  test("length normalization preserves single-term channel scores and pinned originals", () => {
    const matches = ["Inspect the valve seal.", "The valve is not available during operation."].map((text, index) => ({
      source: source(`${index}.md`, text, "document", { method: "collection-section" }),
      score: 0.37,
      reason: "development",
    }))
    for (const method of ["ranked", "greedy", "knapsack"] as const) {
      const result = select(matches, 600, method, [], { text: "valve" })
      expect(result.matches).toHaveLength(2)
      expect(result.matches.every((item) => item.score === 0.37)).toBe(true)
      const pinned = select(matches, 600, method, [matches.at(1)!.source.id], { text: "unrelated phrase" })
      expect(pinned.matches.at(0)?.source).toEqual(matches.at(1)!.source)
    }
  })
})

describe("context-normalization", () => {
  const cases = [
    {
      query: "rotate session key",
      plain: "Rotate session key.",
      variants: ["Rotate sessionKey.", "RotateSessionKey."],
    },
    { query: "reload shard map", plain: "Reload shard map.", variants: ["Reload shardMap.", "ReloadShardMap."] },
    { query: "check cache epoch", plain: "Check cache epoch.", variants: ["Check cacheEpoch.", "CheckCacheEpoch."] },
    {
      query: "resume client lease",
      plain: "Resume client lease.",
      variants: ["R\u00e9sum\u00e9 clientLease.", "Re\u0301sume\u0301ClientLease."],
    },
  ]

  for (const control of cases) {
    for (const method of ["ranked", "greedy", "knapsack"] as const) {
      test(`${method}: density counts lexical terms once for ${control.query}`, () => {
        const score = (text: string) =>
          select(
            [
              {
                source: source("manual:a", text, "document"),
                score: 1,
                reason: "Original passage",
              },
            ],
            2400,
            method,
            [],
            { text: control.query },
          ).matches.at(0)!.score
        const expected = score(control.plain)
        for (const text of control.variants) {
          expect(score(text)).toBe(expected)
          expect(score(`${text} ${text}`)).toBe(expected)
          expect(score(`${text} Background supplier materials.`)).toBeLessThan(expected)
        }
      })

      test(`${method}: normalization cannot displace the compact original for ${control.query}`, () => {
        const weak = {
          source: source("manual:b", `${control.plain} Background.`, "document"),
          score: 1.02,
          reason: "Original passage",
        }
        for (const text of [control.plain, ...control.variants]) {
          // Equal serialized sizes isolate scoring from the selectors' byte costs.
          const padded = text + " ".repeat(Math.max(0, Buffer.byteLength(weak.source.text) - Buffer.byteLength(text)))
          const original = { source: source("manual:a", padded, "document"), score: 1, reason: "Original passage" }
          const candidates = [weak, original]
          const before = structuredClone(candidates)
          const budget = Math.max(...candidates.map((item) => Buffer.byteLength(render(item)) + 1))
          for (const order of [candidates, [...candidates].reverse()]) {
            const result = select(order, budget, method, [], { text: control.query })
            expect(result.matches.map((item) => item.source)).toEqual([original.source])
            expect(result.tokens).toBe(Buffer.byteLength(result.text))
            expect(result.tokens).toBeLessThanOrEqual(budget)
            const pinned = select(order, budget, method, [weak.source.id], { text: control.query })
            expect(pinned.matches.map((item) => item.source)).toEqual([weak.source])
          }
          expect(candidates).toEqual(before)
        }
      })
    }
  }

  test("literal lookup and nonliteral base relevance survive density normalization", () => {
    for (const method of ["ranked", "greedy", "knapsack"] as const) {
      const original = source("manual:a", "Call renewClientLease before retrying.", "document")
      const match = { source: original, score: 0.37, reason: "Semantic or keyword evidence" }
      for (const text of ["renewClientLease", "renew client lease", "identity rollover", "", "the and"]) {
        const result = select([match], 600, method, [], { text })
        expect(result.matches.at(0)?.source).toBe(original)
        expect(result.matches.at(0)!.score).toBeGreaterThanOrEqual(match.score)
      }
    }
  })
})

describe("context-assertions", () => {
  const matches = (texts: string[]) =>
    texts.map((text, index) => ({
      source: source(`${index}.md`, text, "document", { method: "collection-section" }),
      score: 1 / 61,
      reason: "keyword",
    }))

  for (const method of ["ranked", "greedy", "knapsack"] as const) {
    test(`inline instructions retain their subject before a colon: ${method}`, () => {
      const items = matches([
        "Validate sensor output: compare the measured voltage with the reference.",
        "Sensor output validation is the title of a presentation. It lists speakers and sponsors.",
      ])
      const result = select(items, 2400, method, [], { text: "sensor output validation" })
      expect(result.matches.map((item) => item.source)).toEqual([items.at(0)!.source])
    })

    test(`explicit reference lookup keeps the reference rather than its subject: ${method}`, () => {
      const items = matches([
        "The operator owns the calibration sheet.",
        "An illustration depicts the calibration sheet.",
      ])
      const result = select(items, 2400, method, [], { text: "Which illustration depicts the calibration sheet?" })
      expect(result.matches.map((item) => item.source)).toEqual([items.at(1)!.source])
    })

    test(`topic filtering preserves conditions, semantic matches and pins: ${method}`, () => {
      const items = matches([
        "Validate sensor output: compare the measured voltage with the reference.",
        "Sensor output requires approval from the safety officer.",
        "Sensor output: an illustration of historic instruments.",
      ])
      const query = { text: "How should I validate sensor output?" }
      expect(
        select(items, 2400, method, [], query)
          .matches.map((item) => item.source.id)
          .sort(),
      ).toEqual(
        items
          .slice(0, 2)
          .map((item) => item.source.id)
          .sort(),
      )
      expect(select(items, 2400, method, [items.at(2)!.source.id], query).matches.at(0)?.source).toEqual(
        items.at(2)!.source,
      )
      const semantic = { ...items.at(2)!, reason: "Collection semantic index" }
      expect(select([semantic], 2400, method, [], query).matches.at(0)?.source).toEqual(semantic.source)
    })
  }
})
