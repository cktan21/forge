import { describe, expect, test } from "bun:test"
import { Database, SQLiteError } from "bun:sqlite"
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { brief } from "../src/briefs"
import { fuse, render, select } from "../src/context"
import { route } from "../src/domains"
import { engine } from "../src/engine"
import { chunks } from "../src/extract"
import { source } from "../src/parse"
import { type Collection, Source, decode } from "../src/schema"
import { store, type Value } from "../src/store"
import { hash, id, tokens } from "../src/util"
import { permutations } from "./permutations"
import { order, ordering } from "../src/order"

describe("ordering", () => {
  // Authored development controls only. No independent evaluation inputs or labels.
  const roots = ["short", `nested/${"long-workspace-".repeat(8)}`, "relocated/\u6587\u6863-\ud83d\udd0e"]
  const methods = ["ranked", "greedy", "knapsack"] as const
  const query = "copper lantern"
  const collection: Collection = {
    id: "development",
    label: "Manual",
    kind: "folder",
    location: "/development",
    session: "",
    origin: "interface",
    include: ["**/*"],
    exclude: [],
    watch: false,
    approved: true,
    providers: ["local"],
    state: "ready",
    observed: 0,
    generation: "development",
    files: 1,
    chunks: 0,
    warnings: [],
  }

  function normalize(item: Source) {
    return {
      document: item.detail.document ?? item.uri,
      hash: item.detail.fileHash ?? item.hash,
      page: Number(item.detail.page ?? 0),
      start: item.start,
      end: item.end,
      heading: item.detail.heading ?? "",
      text: item.text,
      label: item.label,
    }
  }

  function matches(root: string) {
    return ["a", "b", "c"].map((name) => {
      const text = `Copper lantern entry ${name}.`
      const items = chunks(
        { ...collection, id: id(root), location: root },
        `${name}.md`,
        new TextEncoder().encode(text),
        [{ text }],
      )
      return { source: items.at(1)!, score: 1, reason: "development equal rank" }
    })
  }

  async function setup(name: string, cfg: object = {}) {
    const root = path.join(await realpath(await mkdtemp(path.join(tmpdir(), "forge-ordering-"))), name)
    await mkdir(path.join(root, ".kilo"), { recursive: true })
    await Bun.write(
      path.join(root, ".kilo/forge.jsonc"),
      JSON.stringify({ exclude: ["manuals/**", ".kilo/**"], ...cfg }),
    )
    const db = new Database(":memory:")
    const fault = { armed: false, errors: [] as SQLiteError[] }
    const storage = store({
      async all(query) {
        // Break only the keyword SELECT, leaving schema and catalog transactions intact.
        const broken = fault.armed && query.text.startsWith("SELECT s.body, bm25(forge_search,")
        const text = broken ? query.text.replace("SELECT ", "SELECT , ") : query.text
        try {
          return db.query<Record<string, unknown>, Value[]>(text).all(...(query.values ?? []))
        } catch (err) {
          if (broken && err instanceof SQLiteError) fault.errors.push(err)
          throw err
        }
      },
      async batch(queries) {
        db.transaction(() => {
          for (const query of queries) db.query(query.text).run(...(query.values ?? []))
        })()
      },
    })
    const api = engine({
      root,
      store: storage,
      async provider() {
        return "local"
      },
      async complete() {
        throw new Error("Development controls must not call models")
      },
    })
    return {
      root,
      db,
      storage,
      api,
      fault,
      async close() {
        await api.dispose()
        db.close()
        await rm(root, { recursive: true, force: true })
      },
    }
  }

  async function register(fixture: Awaited<ReturnType<typeof setup>>, count: number) {
    const location = path.join(fixture.root, "manuals")
    await mkdir(location, { recursive: true })
    for (let index = 0; index < count; index++) {
      await Bun.write(
        path.join(location, `entry-${String(index).padStart(3, "0")}.md`),
        `Copper lantern record ${String(index).padStart(3, "0")}.`,
      )
    }
    const item = await fixture.api.register({ kind: "folder", label: "Manual", location, watch: false })
    await fixture.api.approve(item.id, "", ["local"])
    await fixture.api.index(item.id)
    await fixture.api.retrieve(query)
    const sources = await fixture.storage.knowledge(fixture.root, "", "local")
    expect(sources.filter((item) => item.method === "collection-section")).toHaveLength(count)
    const current = (await fixture.api.collections()).find((value) => value.id === item.id)!
    expect(current.state).toBe("ready")
    return { current, sources }
  }

  test("development SQL stabilizes 110 equal BM25 originals before the top-100 cap", async () => {
    const rows: Array<{ root: string; permutation: number; documents: string[]; ranks: number[] }> = []
    for (const root of roots) {
      const fixture = await setup(`sql/${root}`, { budget: 600 })
      try {
        const input = await register(fixture, 110)
        for (const [permutation, items] of [
          input.sources,
          input.sources.toReversed(),
          [...input.sources.filter((_, index) => index % 2), ...input.sources.filter((_, index) => index % 2 === 0)],
        ].entries()) {
          await fixture.storage.publish(fixture.root, input.current, items)
          const ranks = fixture.db
            .query<{ rank: number }, []>(
              'SELECT bm25(forge_search, 0, 0, 2, 1) AS rank FROM forge_search WHERE forge_search MATCH \'"copper" OR "lantern"\'',
            )
            .all()
            .map((row) => row.rank)
          expect(ranks).toHaveLength(110)
          expect(new Set(ranks).size).toBe(1)
          const selected = await fixture.storage.search(fixture.root, query, 100, { provider: "local" })
          expect(selected).toHaveLength(100)
          expect(new Set(selected.map((item) => item.source.id)).size).toBe(100)
          expect(selected.map((item) => item.score)).toEqual(Array.from({ length: 100 }, (_, index) => 1 / (index + 1)))
          rows.push({ root, permutation, documents: selected.map((item) => item.source.detail.document!), ranks })
        }
      } finally {
        await fixture.close()
      }
    }

    const expected = Array.from({ length: 100 }, (_, index) => `entry-${String(index).padStart(3, "0")}.md`)
    for (const row of rows) expect(row.documents).toEqual(expected)
  }, 60_000)

  test("development SQL preserves exact URI priority and unequal BM25 priority", async () => {
    const fixture = await setup("sql-primary")
    try {
      const items = [
        source("z.md", "Copper lantern.", "document"),
        source("a.md", `Copper lantern. ${"unrelated ".repeat(100)}`, "document"),
        ...Array.from({ length: 110 }, (_, index) => source(`src/item-${index}.ts`, "export const other = 1", "code")),
        source("src/with.ts", `export const value = 1 // ${"padding ".repeat(100)}`, "code"),
      ]
      await fixture.storage.replace({
        root: fixture.root,
        generation: "development",
        revision: "development",
        observed: 0,
        files: items.length,
        partial: false,
        warnings: [],
        sources: items,
        relations: [],
      })
      const ranked = await fixture.storage.search(fixture.root, query, 100)
      const exact = await fixture.storage.search(fixture.root, "src/with.ts", 100)

      expect(ranked.map((item) => item.source.uri)).toEqual(["z.md", "a.md"])
      expect(exact.at(0)?.source.uri).toBe("src/with.ts")
    } finally {
      await fixture.close()
    }
  })

  test("development symmetric fusion resolves equal scores without root identity", () => {
    const rows = roots.flatMap((root) =>
      permutations(matches(root)).map((items) => {
        const result = fuse([items, items.toReversed()])
        // Only the symmetric outer pair ties; the middle rank has a distinct score.
        expect(result.at(0)?.score).toBe(result.at(1)?.score)
        expect(result.at(1)!.score).toBeGreaterThan(result.at(2)!.score)
        const tied = [items.at(0)!, items.at(2)!].map((item) => item.source.detail.document!).sort()
        return { root, expected: tied, selected: result.slice(0, 2).map((item) => item.source.detail.document!) }
      }),
    )

    for (const row of rows) expect(row.selected).toEqual(row.expected)
  })

  for (const method of methods) {
    test(`development ${method} ties are invariant across every input permutation and root`, () => {
      const rows = roots.flatMap((root) =>
        permutations(matches(root)).map((items) => {
          const budget = tokens(render(items.at(0)!)) + 1
          expect(new Set(items.map((item) => tokens(render(item)))).size).toBe(1)
          const selected = select(items, budget, method)
          expect(selected.tokens).toBe(tokens(selected.text))
          expect(selected.tokens).toBeLessThanOrEqual(budget)
          return {
            root,
            input: items.map((item) => item.source.detail.document),
            selected: selected.matches.map((item) => normalize(item.source)),
          }
        }),
      )

      for (const row of rows) expect(row.selected).toEqual([normalize(matches(roots.at(0)!).at(0)!.source)])
    })

    test(`development ${method} retains strict score priority, pins, and byte costs`, () => {
      const costs = roots.map((root) => {
        const items = matches(root)
        const stronger = { ...items.at(2)!, score: 2 }
        const budget = tokens(render(stronger)) + 1
        for (const input of permutations([items.at(0)!, items.at(1)!, stronger])) {
          expect(select(input, budget, method).matches.map((item) => item.source.id)).toEqual([stronger.source.id])
          expect(select(input, budget, method, [items.at(1)!.source.id]).matches.map((item) => item.source.id)).toEqual(
            [items.at(1)!.source.id],
          )
        }
        const unicode = { ...stronger, source: { ...stronger.source, text: "\u6587\u6863 \ud83d\udd0e" } }
        const selected = select([unicode], 600, method)
        expect(selected.text).toBe(render(unicode))
        expect(selected.tokens).toBe(Buffer.byteLength(selected.text, "utf8"))
        return { costs: items.map((item) => tokens(render(item)) + 1), unicode: selected.tokens }
      })

      for (const cost of costs) expect(cost).toEqual(costs.at(0)!)
    })
  }

  test("development equivalent originals preserve distinct registrations and existing deduplication", () => {
    const items = ["first", "second"].map((root) => matches(root).at(0)!)
    expect(items.at(0)!.source.id).not.toBe(items.at(1)!.source.id)
    expect(normalize(items.at(0)!.source)).toEqual(normalize(items.at(1)!.source))
    expect(fuse([items])).toHaveLength(2)
    for (const method of methods) expect(select(items, 2400, method).matches).toHaveLength(1)
  })

  test("development brief selection uses content after 30 equal numeric coordinates", () => {
    const pages = Array.from({ length: 30 }, (_, index) => ({
      page: 2,
      text: `# Entry ${String(index).padStart(2, "0")}\nCopper lantern record ${String(index).padStart(2, "0")}.`,
    }))
    const rows = roots.flatMap((root) => {
      const items = chunks(
        { ...collection, id: id(root), location: root },
        "manual.pdf",
        new TextEncoder().encode(JSON.stringify(pages)),
        pages,
      )
      const parent = items.at(0)!
      expect(items.slice(1).every((item) => item.start === 1 && item.end === 2 && item.detail.page === "2")).toBe(true)
      return [items, items.toReversed()].map((input) => {
        const result = brief(parent, input)
        expect(result.ids).toHaveLength(24)
        expect(result.count).toBe(30)
        return {
          root,
          headings: result.ids.map((key) => items.find((item) => item.id === key)!.detail.heading),
          text: result.text,
        }
      })
    })

    for (const row of rows) {
      expect(row.headings).toEqual(Array.from({ length: 24 }, (_, index) => `Entry ${String(index).padStart(2, "0")}`))
      expect(row.text).toBe(rows.at(0)!.text)
    }
  })

  test("development routes preserve numeric page order and distinguish equal-name document content", () => {
    const rows = roots.map((root) => {
      const pages = [
        { page: 10, text: "Copper lantern later." },
        { page: 2, text: "Copper lantern prior." },
      ]
      const items = chunks(
        { ...collection, id: id(root), location: root },
        "manual.pdf",
        new TextEncoder().encode(JSON.stringify(pages)),
        pages,
      )
      expect(route(query, items.toReversed()).map((item) => item.source.detail.page)).toEqual(["2", "10"])
      const copies = ["a", "b", "c", "d"].flatMap((name) => {
        const text = `Copper lantern copy ${name}.`
        return chunks(
          { ...collection, id: id(root, name), location: root },
          "same.md",
          new TextEncoder().encode(text),
          [{ text }],
        )
      })
      const selected = route(query, copies.toReversed())
      return selected.map((item) => item.source.detail.fileHash!)
    })

    const expected = ["a", "b", "c", "d"]
      .map((name) => hash(`Copper lantern copy ${name}.`))
      .sort()
      .slice(0, 3)
    for (const row of rows) expect(row).toEqual(expected)
  })

  test("development keyword fault preserves catalog replacement and adapter isolation", async () => {
    const fixture = await setup("fault-isolation")
    const healthy = await setup("fault-isolation-healthy")
    try {
      const original = source("manual.md", "Copper lantern original.", "document")
      const updated = source("manual.md", "Copper lantern updated.", "document")
      const snapshot = {
        root: fixture.root,
        generation: "development",
        revision: "original",
        observed: 0,
        files: 1,
        partial: false,
        warnings: [],
        sources: [original],
        relations: [],
      }
      await fixture.storage.replace(snapshot)
      await healthy.storage.replace({ ...snapshot, root: healthy.root })
      expect((await fixture.storage.search(fixture.root, query)).map((item) => item.source)).toEqual([original])
      fixture.fault.armed = true
      const replacement = { ...snapshot, revision: "updated", sources: [updated] }
      const replaced = await fixture.storage.replace(replacement)
      expect(replaced).toBeUndefined()
      expect(await fixture.storage.snapshot(fixture.root)).toEqual(replacement)
      expect(
        fixture.db
          .query<{ count: number }, []>("SELECT count(*) AS count FROM forge_search WHERE forge_search MATCH 'updated'")
          .get()?.count,
      ).toBe(1)
      const err = await fixture.storage.search(fixture.root, query).catch((err: unknown) => err)
      expect(err).toBeInstanceOf(SQLiteError)
      expect(fixture.fault.errors).toHaveLength(1)
      expect(fixture.fault.errors.at(0)?.code).toBe("SQLITE_ERROR")
      expect(fixture.fault.errors.at(0)?.message).toContain("syntax error")
      expect((await healthy.storage.search(healthy.root, query)).map((item) => item.source)).toEqual([original])
      expect(healthy.fault.errors).toHaveLength(0)
      fixture.fault.armed = false
      expect((await fixture.storage.search(fixture.root, query)).map((item) => item.source)).toEqual([updated])
    } finally {
      await fixture.close()
      await healthy.close()
    }
  })

  for (const method of methods) {
    test(`development real SQLite-failure fallback stabilizes ${method} selection before its cap`, async () => {
      const rows: Array<{ root: string; permutation: number; selected: string[] }> = []
      for (const root of roots) {
        for (const permutation of [0, 1]) {
          const fixture = await setup(`fallback-${method}/${root}`, { candidates: 2, budget: 600, selector: method })
          try {
            const input = await register(fixture, 6)
            await fixture.storage.publish(
              fixture.root,
              input.current,
              permutation ? input.sources.toReversed() : input.sources,
            )
            // Preserve the pre-fault retrieval; it is not a barrier against future refreshes.
            await fixture.api.retrieve(query)
            fixture.fault.armed = true
            const published = await fixture.storage.publish(
              fixture.root,
              input.current,
              permutation ? input.sources.toReversed() : input.sources,
            )
            expect(published).toBeUndefined()
            const result = await fixture.api.retrieve(query)
            expect(fixture.fault.errors).toHaveLength(1)
            expect(fixture.fault.errors.at(0)).toBeInstanceOf(SQLiteError)
            expect(fixture.fault.errors.at(0)?.code).toBe("SQLITE_ERROR")
            expect(fixture.fault.errors.at(0)?.message).toContain("syntax error")
            expect(result.audit?.channels?.find((item) => item.name === "keyword")?.state).toBe("fallback")
            expect(result.tokens).toBe(tokens(result.text))
            expect(result.tokens).toBeLessThanOrEqual(600)
            rows.push({ root, permutation, selected: result.matches.map((item) => item.source.detail.document!) })
          } finally {
            await fixture.close()
          }
        }
      }

      for (const row of rows) expect(row.selected).toEqual(rows.at(0)!.selected)
      for (const row of rows) expect([...row.selected].sort()).toEqual(["entry-000.md", "entry-001.md"])
    }, 60_000)
  }

  for (const routing of [undefined, "domains"] as const) {
    for (const budget of [600, 2400]) {
      test(`development registered originals: ${routing ?? "default"}/${budget} relocation and publication`, async () => {
        const rows: Array<{
          root: string
          permutation: number
          selected: ReturnType<typeof normalize>[]
          bytes: number
        }> = []
        for (const root of roots) {
          const fixture = await setup(`retrieval-${routing ?? "default"}-${budget}/${root}`, { routing, budget })
          try {
            const input = await register(fixture, 6)
            for (const [permutation, items] of [input.sources, input.sources.toReversed()].entries()) {
              await fixture.storage.publish(fixture.root, input.current, items)
              const result = await fixture.api.retrieve(query)
              expect(result.budget).toBe(budget)
              expect(result.tokens).toBe(tokens(result.text))
              expect(result.tokens).toBeLessThanOrEqual(budget)
              expect(result.matches.length).toBeGreaterThan(0)
              for (const match of result.matches) {
                expect(match.source.method).toBe("collection-section")
                expect(match.source.status).toBe("current")
                expect(input.sources.find((item) => item.id === match.source.id)).toEqual(match.source)
                expect(
                  (await Bun.file(path.join(fixture.root, "manuals", match.source.detail.document!)).text()).trim(),
                ).toBe(match.source.text)
              }
              rows.push({
                root,
                permutation,
                selected: result.matches.map((item) => normalize(item.source)),
                bytes: result.tokens,
              })
            }
          } finally {
            await fixture.close()
          }
        }

        for (const row of rows) {
          expect(row.selected).toEqual(rows.at(0)!.selected)
          expect(row.bytes).toBe(rows.at(0)!.bytes)
        }
      }, 60_000)
    }
  }
})

describe("ordering-parity", () => {
  function original(opts: Partial<Source> = {}) {
    return source("knowledge:root/manual", "copper lantern", "document", {
      hash: "same",
      label: "manual",
      start: 1,
      end: 2,
      method: "collection-section",
      detail: { collection: "root", document: "manual", fileHash: "same" },
      ...opts,
    })
  }

  function sql(items: readonly Source[]) {
    const db = new Database(":memory:")
    try {
      return db
        .query<{ body: string }, [string]>(
          `SELECT s.body FROM (SELECT value AS body FROM json_each(?)) s ORDER BY ${ordering}`,
        )
        .all(JSON.stringify(items))
        .map((row) => decode(Source, JSON.parse(row.body)))
    } finally {
      db.close()
    }
  }

  test("ordering SQL and TypeScript agree on every field and precedence", () => {
    const base = original()
    const pairs: Array<[Source, Source]> = [
      [
        original({ detail: { ...base.detail, document: "a" }, text: "z" }),
        original({ detail: { ...base.detail, document: "b" }, text: "a" }),
      ],
      [
        original({ detail: { collection: "root" }, label: "a", uri: "z" }),
        original({ detail: { collection: "root" }, label: "b", uri: "a" }),
      ],
      [original({ detail: {}, uri: "a", label: "z" }), original({ detail: {}, uri: "b", label: "a" })],
      [
        original({ detail: { ...base.detail, fileHash: "a" }, start: 20 }),
        original({ detail: { ...base.detail, fileHash: "b" }, start: 1 }),
      ],
      [
        original({ detail: { collection: "root" }, hash: "a", start: 20 }),
        original({ detail: { collection: "root" }, hash: "b", start: 1 }),
      ],
      [
        original({ detail: { ...base.detail, page: "2" }, start: 20 }),
        original({ detail: { ...base.detail, page: "10" }, start: 1 }),
      ],
      [original({ start: 2, end: 20 }), original({ start: 10, end: 1 })],
      [original({ end: 2, text: "z" }), original({ end: 10, text: "a" })],
      [
        original({ detail: { ...base.detail, heading: "a" }, text: "z" }),
        original({ detail: { ...base.detail, heading: "b" }, text: "a" }),
      ],
      [original({ text: "a", label: "z" }), original({ text: "b", label: "a" })],
      [original({ label: "a" }), original({ label: "b" })],
    ]
    for (const [a, b] of pairs) {
      expect(order(a, b)).toBeLessThan(0)
      expect(order(b, a)).toBeGreaterThan(0)
      for (const input of [
        [a, b],
        [b, a],
      ]) {
        expect(sql(input)).toEqual([a, b])
        expect(input.toSorted(order)).toEqual([a, b])
      }
    }
  })

  test("ordering uses UTF-8 bytes for case, accents, NUL and supplementary characters", () => {
    const names = ["", "A", "Z", "a", "a\u0000a", "a\u0000b", "z", "\u00e9", "\ue000", "\ud800\udc00"]
    for (const field of ["document", "fileHash", "heading", "text", "label", "uri", "hash"]) {
      const items = names.map((name) => {
        const base = original()
        if (["document", "fileHash", "heading"].includes(field)) {
          return { ...base, detail: { ...base.detail, [field]: name } }
        }
        return { ...base, [field]: name, ...(field === "uri" || field === "hash" ? { detail: {} } : {}) }
      })
      expect(items.toReversed().toSorted(order)).toEqual(items)
      expect(sql(items.toReversed())).toEqual(items)
    }
  })

  test("ordering numeric pages match SQLite conversion and missing-field defaults", () => {
    const values = [
      undefined,
      "",
      "0",
      "02",
      " 2 ",
      "-1",
      "2.5",
      "1e2",
      "bad",
      "12pages",
      "1e",
      "0x10",
      "\t3",
      "Infinity",
      "\u00a02",
    ]
    const items = values.map((page, index) =>
      original({
        text: String(index).padStart(2, "0"),
        detail: { collection: "root", ...(page == null ? {} : { page }) },
      }),
    )
    for (const input of [items, items.toReversed()]) expect(sql(input)).toEqual(input.toSorted(order))
    expect(
      order(
        original({ detail: { collection: "root" } }),
        original({
          detail: { collection: "root", page: "0", heading: "" },
        }),
      ),
    ).toBe(0)
  })

  test("canonical equality never becomes registration identity or fusion deduplication", () => {
    const items = ["short", "deep/long/root", "\u6587\u6863"].map((root) =>
      original({
        id: root,
        uri: `knowledge:${root}/manual`,
        detail: { collection: root, location: `/${root}`, document: "manual", fileHash: "same" },
      }),
    )
    for (const a of items) for (const b of items) expect(order(a, b)).toBe(0)
    const before = JSON.stringify(items)
    expect(fuse(items.map((source) => [{ source, score: 1, reason: "same rank" }]))).toHaveLength(3)
    expect(JSON.stringify(items)).toBe(before)
  })

  test("repository domain route and expansion caps use ties only", () => {
    const files = Array.from({ length: 10 }, (_, index) =>
      source(`src/${String(index).padStart(2, "0")}.md`, "copper lantern", "document"),
    )
    const briefs = ["a", "b", "c", "d"].map((name) =>
      source(`domain:${name}`, "copper lantern", "summary", {
        method: "domain-index",
        evidence: files.map((item) => item.id),
      }),
    )
    const expected = route("copper lantern", [...briefs, ...files]).map((item) => item.source.id)
    for (const input of permutations(briefs)) {
      const result = route("copper lantern", [...files.toReversed(), ...input])
      expect(result.map((item) => item.source.id)).toEqual(expected)
      expect(result.filter((item) => item.source.method === "domain-index").map((item) => item.source.uri)).toEqual([
        "domain:a",
        "domain:b",
        "domain:c",
      ])
      expect(
        result
          .filter((item) => item.source.method !== "domain-index")
          .slice(0, 8)
          .map((item) => item.source.uri),
      ).toEqual(files.slice(0, 8).map((item) => item.uri))
    }
    const stronger = { ...briefs.at(3)!, text: "copper lantern ember" }
    expect(route("copper lantern ember", [...briefs.slice(0, 3), stronger, ...files]).at(0)?.source.id).toBe(
      stronger.id,
    )
  })
})
