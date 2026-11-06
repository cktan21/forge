import { expect, test } from "bun:test"
import { select, fuse, render } from "../src/context"
import { source } from "../src/parse"
import { tokens } from "../src/util"

test("all selectors bound serialized evidence and omit stale sources", () => {
  const candidates = ["one", "two", "three"].map((name, index) => ({ source: source(`${name}.ts`, `export const ${name} = ${index}`, "code"), score: index + 1, reason: "fixture" }))
  candidates.push({ source: { ...source("old.ts", "stale", "code"), status: "stale" }, score: 100, reason: "stale" })
  const budget = tokens(render(candidates[1]!)) + tokens(render(candidates[2]!)) + 2
  for (const method of ["ranked", "greedy", "knapsack"] as const) {
    const result = select(candidates, budget, method)
    expect(result.tokens).toBeLessThanOrEqual(budget)
    expect(result.matches.every((item) => item.source.status === "current")).toBe(true)
    expect(result.matches.length).toBe(2)
  }
  expect(select(candidates, 0).matches).toEqual([])
})

test("fusion rewards corroboration and selection removes duplicate evidence", () => {
  const a = { source: source("a.ts", "alpha", "code"), score: 1, reason: "lexical" }
  const b = { source: source("b.ts", "beta", "code"), score: 1, reason: "semantic" }
  const fused = fuse([[a, b], [b]])
  expect(fused.at(0)?.source.id).toBe(b.source.id)
  const result = select([a, a, b], 10000)
  expect(result.matches.length).toBe(2)
})

test("oversized files cannot suppress affordable child excerpts", () => {
  const file = source("big.ts", "x".repeat(30_000), "code", { start: 1, end: 1000 })
  const child = source("big.ts", "export const answer = 42", "symbol", { id: "child", start: 20, end: 20 })
  for (const method of ["ranked", "greedy", "knapsack"] as const) {
    const result = select([{ source: file, score: 10, reason: "file" }, { source: child, score: 1, reason: "symbol" }], 1000, method)
    expect(result.matches.map((item) => item.source.id)).toEqual(["child"])
  }
})

test("an affordable unselected parent cannot suppress a useful child", () => {
  const parent = { source: source("file.ts", "p".repeat(400), "code", { start: 1, end: 100 }), score: 2, reason: "parent" }
  const child = { source: source("file.ts", "child", "symbol", { start: 20, end: 20 }), score: 1, reason: "child" }
  const other = { source: source("other.ts", "o".repeat(200), "code"), score: 100, reason: "other" }
  const budget = tokens(render(parent)) + 1
  expect(tokens(render(other)) + tokens(render(child)) + 2).toBeLessThanOrEqual(budget)
  for (const method of ["ranked", "greedy", "knapsack"] as const) {
    for (const candidates of [[parent, child, other], [other, child, parent]]) {
      const result = select(candidates, budget, method)
      expect(result.matches.map((item) => item.source.id).sort()).toEqual([other.source.id, child.source.id].sort())
      expect(result.omitted).toEqual([parent.source.id])
      expect(result.tokens).toBe(tokens(result.text))
      expect(result.tokens).toBeLessThanOrEqual(budget)
    }
  }
})

test("selected containment and duplicate evidence are excluded in either order", () => {
  const parent = { source: source("file.ts", "parent", "code", { start: 1, end: 100 }), score: 1, reason: "parent" }
  const child = { source: source("file.ts", "child", "symbol", { start: 20, end: 20 }), score: 10, reason: "child" }
  const duplicate = { ...child, source: { ...child.source, id: "duplicate", uri: "copy.ts" }, score: 2 }
  for (const method of ["ranked", "greedy", "knapsack"] as const) {
    for (const candidates of [[parent, child], [child, parent], [duplicate, child], [child, duplicate], [child, child]]) {
      const result = select(candidates, 10_000, method)
      expect(result.matches.map((item) => item.source.id)).toEqual([child.source.id])
    }
    const result = select([{ ...parent, score: 100 }, child], 10_000, method)
    expect(result.matches.map((item) => item.source.id)).toEqual([parent.source.id])
  }
})

test("every selector budgets serialized UTF-8 evidence including separators", () => {
  const candidates = [
    { source: source("file.ts", "\u4e2d".repeat(20), "code", { start: 1, end: 100 }), score: 3, reason: "parent" },
    { source: source("file.ts", "\u4e2d", "symbol", { start: 2, end: 2 }), score: 2, reason: "child" },
    { source: source("other.ts", "\ud83d\ude00", "code"), score: 1, reason: "other" },
  ]
  const maximum = candidates.reduce((sum, match) => sum + tokens(render(match)) + 1, 0)
  for (const method of ["ranked", "greedy", "knapsack"] as const) {
    for (let budget = 0; budget <= maximum; budget++) {
      const result = select(candidates, budget, method)
      expect(result.tokens).toBe(tokens(result.text))
      expect(result.tokens).toBeLessThanOrEqual(budget)
      expect(result.text).toBe(result.matches.map(render).join("\n"))
      const ids = result.matches.map((match) => match.source.id)
      expect(ids.includes(candidates[0]!.source.id) && ids.includes(candidates[1]!.source.id)).toBe(false)
    }
  }
})
