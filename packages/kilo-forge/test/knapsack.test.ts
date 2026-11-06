import { describe, expect, test } from "bun:test"
import { render, select } from "../src/context"
import { type Match, type Source } from "../src/schema"
import { permutations } from "./permutations"
import { order } from "../src/order"

describe("conflict-aware selection", () => {
  function item(id: string, uri: string, score = 1, cost = 200, start = 1, end = start): Match {
    const source = {
      id,
      uri,
      kind: "document",
      label: uri,
      hash: id,
      start,
      end,
      text: "",
      status: "current",
      observed: 0,
      method: "file",
      inferred: false,
      evidence: [],
      detail: {},
    } satisfies Source
    const match = { source, score, reason: "DP development" }
    source.text = `${id}: `.padEnd(cost - Buffer.byteLength(render(match)) - 1, ".")
    expect(Buffer.byteLength(render(match)) + 1).toBe(cost)
    return match
  }

  function check(items: Match[], budget: number, pins: string[] = []) {
    const before = JSON.stringify(items)
    const result = select(items, budget, "knapsack", pins)
    expect(JSON.stringify(items)).toBe(before)
    expect(result.tokens).toBe(Buffer.byteLength(result.text))
    expect(result.tokens).toBeLessThanOrEqual(budget)
    expect(new Set(result.matches.map((match) => match.source.id)).size).toBe(result.matches.length)
    for (const pin of pins) expect(result.matches.some((match) => match.source.id === pin)).toBe(true)
    for (const match of result.matches)
      expect(items.find((item) => item.source.id === match.source.id)?.source).toEqual(match.source)
    return {
      ids: result.matches.map((match) => match.source.id).sort(),
      objective: result.matches.reduce((sum, match) => sum + match.score, 0),
    }
  }

  test("conflicting alternatives preserve feasible objectives across permutations", () => {
    const items = [item("B", "z.md"), item("A", "a.md"), item("C", "a.md", 2, 200, 1, 2)]
    for (const input of permutations(items)) {
      const key = input.map((match) => match.source.id).join("")
      const result = check(input, 400)
      if (key === "BAC") expect(result).toEqual({ ids: ["B", "C"], objective: 3 })
      // The existing one-state DP already misses B+C in ABC order.
      expect(result.objective).toBeGreaterThanOrEqual(key === "ABC" ? 2 : 3)
      expect(result.ids.includes("A") && result.ids.includes("C")).toBe(false)
    }
  })

  test("pins retain overlap exclusion and remaining feasible choices in every permutation", () => {
    const items = [item("B", "z.md"), item("A", "a.md"), item("C", "a.md", 2, 200, 1, 2)]
    for (const input of permutations(items)) {
      expect(check(input, 400, ["A"])).toEqual({ ids: ["A", "B"], objective: 2 })
      expect(check(input, 400, ["B"])).toEqual({ ids: ["B", "C"], objective: 3 })
      expect(check(input, 400, ["C"])).toEqual({ ids: ["B", "C"], objective: 3 })
    }
  })

  test("DP disjoint equal-priority alternatives remain canonical in all permutations", () => {
    const items = [item("z", "z.md"), item("a", "a.md"), item("m", "m.md")]
    for (const input of permutations(items)) {
      expect(check(input, 200)).toEqual({ ids: ["a"], objective: 1 })
      expect(check(input, 400)).toEqual({ ids: ["a", "m"], objective: 2 })
    }
  })

  test("DP overlapping twins may be canonicalized when all external conflicts agree", () => {
    const items = [item("z", "same.md"), item("a", "same.md"), item("C", "other.md", 2)]
    for (const input of permutations(items)) expect(check(input, 400)).toEqual({ ids: ["C", "a"], objective: 3 })
  })

  test("DP disjoint twins with a common enclosing conflict retain feasible value", () => {
    const items = [
      item("z", "same.md", 1, 200, 1),
      item("a", "same.md", 1, 200, 3),
      item("C", "same.md", 2, 200, 1, 3),
      item("D", "other.md", 3),
    ]
    for (const input of permutations(items)) {
      const result = check(input, 400)
      expect(result.objective).toBe(5)
      expect(result.ids).toEqual(["C", "D"])
    }
  })

  test("DP conflict-distinct equal totals cannot replace a partial state on canonical order alone", () => {
    const items = [item("B", "z.md", 2, 400), item("A", "a.md"), item("D", "b.md"), item("C", "a.md", 3, 200, 1, 2)]
    expect(check(items, 600)).toEqual({ ids: ["B", "C"], objective: 5 })
  })

  test("DP conflict-free unequal-cost and multi-item objective ties stay precise", () => {
    const items = [item("a", "a.md"), item("b", "b.md"), item("z", "z.md", 2, 400)]
    for (const input of permutations(items)) {
      expect(check(input, 400)).toEqual({ ids: ["a", "b"], objective: 2 })
      const stronger = input.map((match) => (match.source.id === "z" ? { ...match, score: 3 } : match))
      expect(check(stronger, 400)).toEqual({ ids: ["z"], objective: 3 })
    }
    for (const input of permutations([item("z", "z.md", 1, 200), item("a", "a.md", 1, 300)])) {
      expect(check(input, 300)).toEqual({ ids: ["a"], objective: 1 })
    }
  })

  test("DP equal-priority canonicalization does not cross the original 100-item admission cap", () => {
    const items = Array.from({ length: 100 }, (_, index) => item(`z${index}`, `z${index}.md`))
    expect(check([...items, item("extra", "a.md")], 200).ids).not.toContain("extra")
    const result = check([...items, item("strong", "b.md", 1000)], 200)
    expect(result.ids).not.toContain("strong")
    expect(result.ids.length).toBeGreaterThan(0)
  })

  test("tie-heavy input preserves objective and bytes", () => {
    const items = Array.from({ length: 20 }, (_, index) =>
      item(String(index).padStart(3, "0"), `${String(index).padStart(3, "0")}.md`),
    )
    expect(check(items, 2000).objective).toBe(10)
    expect(check(items.toReversed(), 2000).ids).toEqual(check(items, 2000).ids)
  })
})

describe("canonical-equivalent originals", () => {
  function item(id: string, score: number, cost: number) {
    const source = {
      id,
      uri: `knowledge:${id}`,
      hash: id,
      kind: "document",
      label: "same",
      start: 1,
      end: 1,
      text: "Same original.",
      status: "current",
      observed: 0,
      method: "collection-section",
      inferred: false,
      evidence: [],
      detail: { collection: id, document: "same.md", fileHash: "same" },
    } satisfies Source
    const match = { source, score, reason: "canonical equivalence" }
    source.uri = source.uri.padEnd(source.uri.length + cost - Buffer.byteLength(render(match)) - 1, "x")
    expect(Buffer.byteLength(render(match)) + 1).toBe(cost)
    return match
  }

  test("DP canonical-equivalent distinct originals retain shorter-list preference", () => {
    const items = [item("A", 1, 200), item("B", 1, 200), item("C", 2, 400)]
    for (const a of items) for (const b of items) expect(order(a.source, b.source)).toBe(0)
    for (const input of permutations(items)) {
      const result = select(input, 400, "knapsack")
      expect(result.matches.map((match) => match.source.id)).toEqual(["C"])
      expect(result.tokens).toBe(399)
      expect(result.matches.reduce((sum, match) => sum + match.score, 0)).toBe(2)
    }
  })

  test("DP proper prefixes do not acquire equivalent zero-score originals", () => {
    const items = [item("A", 0, 200), item("B", 2, 200)]
    for (const input of permutations(items)) {
      const result = select(input, 400, "knapsack")
      expect(result.matches.map((match) => match.source.id)).toEqual(["B"])
      expect(result.tokens).toBe(199)
    }
  })
})

describe("zero-score stability", () => {
  function item(id: string, score: number, cost = 200) {
    const source: { -readonly [K in keyof Source]: Source[K] } = {
      id,
      uri: `${id}.md`,
      label: id,
      kind: "document",
      hash: id,
      start: 1,
      end: 1,
      text: "",
      status: "current",
      observed: 0,
      method: "collection-section",
      inferred: false,
      evidence: [],
      detail: {},
    }
    const match = { source, score, reason: "zero-score development" }
    source.text = `${id}: original \u03bb. `.padEnd(cost - Buffer.byteLength(render(match)) - 2, ".")
    expect(Buffer.byteLength(render(match)) + 1).toBe(cost)
    return match
  }

  function check(items: Match[], budget: number, pins: string[] = []) {
    const before = JSON.stringify(items)
    const result = select(items, budget, "knapsack", pins)
    expect(JSON.stringify(items)).toBe(before)
    expect(result.text).toBe(result.matches.map(render).join("\n"))
    expect(result.tokens).toBe(Buffer.byteLength(result.text))
    expect(result.tokens).toBeLessThanOrEqual(budget)
    expect(new Set(result.matches.map((match) => match.source.id)).size).toBe(result.matches.length)
    for (const match of result.matches) expect(items.includes(match)).toBe(true)
    return result.matches.map((match) => match.source.id).sort()
  }

  for (const cost of [200, 275]) {
    test(`zero-score originals cannot enter equal-objective ties at cost ${cost}`, () => {
      const items = [item("annex", 0, cost), item("manual", 4, 300), item("zoning", 0, 250)]
      for (const budget of [600, 2400]) {
        for (const input of permutations(items)) expect(check(input, budget)).toEqual(["manual"])
      }
    })
  }

  test("all-zero knapsack remains empty, including signed zero", () => {
    const items = [item("annex", 0), item("manual", -0), item("zoning", 0)]
    for (const budget of [0, 199, 600, 2400]) {
      for (const input of permutations(items)) expect(check(input, budget)).toEqual([])
    }
  })

  test("tiny positive scores and distinct original identities survive zero-score competition", () => {
    const items = [item("annex", 0), item("manual", 2 ** -20), item("zoning", 2 ** -20)]
    // Distinct registrations may share canonical metadata without sharing identity.
    for (const match of items) {
      match.source.detail = { collection: match.source.id, document: "shared.md", fileHash: "shared" }
    }
    for (const input of permutations(items)) {
      expect(check(input, 600)).toEqual(["manual", "zoning"])
      expect(check(input, 2400)).toEqual(["manual", "zoning"])
    }
  })

  test("positive-only unequal-cost ties retain canonical selected originals", () => {
    const items = [item("annex", 1, 250), item("manual", 1, 350), item("zoning", 2, 600)]
    for (const input of permutations(items)) expect(check(input, 600)).toEqual(["annex", "manual"])
  })

  test("zero-score pins retain identity, overlap exclusion and budget errors", () => {
    const pin = item("annex", 0)
    const overlap = item("overlap", 9)
    overlap.source.uri = pin.source.uri
    const items = [pin, overlap, item("manual", 3)]
    for (const input of permutations(items)) {
      expect(check(input, 600, ["annex"])).toEqual(["annex", "manual"])
      expect(() => select(input, 199, "knapsack", ["annex"])).toThrow("exceeding")
    }
    pin.source.status = "stale"
    expect(() => select(items, 2400, "knapsack", ["annex"])).toThrow("unavailable")
    expect(() => select(items, 2400, "knapsack", ["missing"])).toThrow("unavailable")
  })

  test("zero-score ties do not admit stale, empty, duplicate or beyond-cap evidence", () => {
    const current = item("manual", 3)
    const stale = item("stale", 100)
    stale.source.status = "stale"
    const empty = item("empty", 100)
    empty.source.text = ""
    expect(check([item("annex", 0), stale, empty, current, current], 600)).toEqual(["manual"])
    const zeros = Array.from({ length: 100 }, (_, index) => item(`zero${index}`, 0))
    expect(check([...zeros, current], 600)).toEqual([])
  })

  test("ranked and greedy retain their existing zero-score inclusion behavior", () => {
    const items = [item("annex", 0), item("manual", 3)]
    for (const method of ["ranked", "greedy"] as const) {
      for (const input of permutations(items)) {
        const result = select(input, 600, method)
        expect(result.matches.map((match) => match.source.id)).toEqual(["manual", "annex"])
        expect(result.tokens).toBe(399)
      }
    }
  })

  test("small conflict-free subsets retain the exact nonzero objective and stable identity sets", () => {
    // Enumerate subsets independently of the production recurrence.
    for (const scores of [
      [0, 1, 3, 0],
      [1, 2, 3, 4],
      [0, 0.5, 0.5, 1],
      [-1, 0, 2, 1],
    ]) {
      const costs = [150, 225, 300, 375]
      const items = scores.map((score, index) => item(`entry${index}`, score, costs.at(index)))
      for (const budget of [300, 600, 2400]) {
        const subsets = Array.from({ length: 16 }, (_, mask) => items.filter((_, index) => mask & (1 << index))).filter(
          (set) => set.reduce((sum, match) => sum + Buffer.byteLength(render(match)) + 1, 0) <= budget,
        )
        const optimum = Math.max(...subsets.map((set) => set.reduce((sum, match) => sum + match.score, 0)))
        const choices = new Set<string>()
        for (const input of permutations(items)) {
          const ids = check(input, budget)
          const chosen = items.filter((match) => ids.includes(match.source.id))
          expect(chosen.reduce((sum, match) => sum + match.score, 0)).toBe(optimum)
          expect(chosen.every((match) => match.score > 0)).toBe(true)
          choices.add(JSON.stringify(ids))
        }
        expect(choices.size).toBe(1)
      }
    }
  })
})
