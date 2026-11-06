import { expect, test } from "bun:test"
import { compare, details } from "../src/review"
import { select } from "../src/context"
import { source } from "../src/parse"

const match = (key: string, text = key) => ({ source: source(`${key}.md`, text, "document"), score: 1, reason: "test" })

test("compares selected IDs and versions, not ordering or copied source content", () => {
  const before = { ...select([match("stable"), match("changed", "old private text"), match("removed")], 2000), policy: "old" }
  const after = { ...select([match("added"), match("stable"), match("changed", "new private text")], 3000), policy: "new", reasons: { [match("removed").source.id]: "Excluded by developer" } }
  const lines = compare(after, before).join("\n")
  expect(lines).toContain("1 added, 1 removed, 1 versions changed, 1 unchanged")
  expect(lines).toContain("Excluded by developer")
  expect(lines).toContain("policy: old -> new")
  expect(lines).toContain("budget: 2000 -> 3000")
  expect(lines).toContain(match("changed", "old private text").source.hash)
  expect(lines).not.toContain("old private text")
  expect(lines).not.toContain("new private text")
  expect(before.matches.find((item) => item.source.id === match("changed").source.id)?.source.text).toBe("old private text")
})

test("first review, reorder, absent reasons, and missing provider metadata stay explicit", () => {
  const before = select([match("one"), match("two")], 2000)
  expect(compare(before)).toEqual(["No previous selection in this review."])
  expect(compare({ ...before, matches: [...before.matches].reverse() }, before).at(0)).toContain("0 added, 0 removed, 0 versions changed, 2 unchanged")
  expect(compare(select([], 2000), before).join("\n")).toContain("cause not recorded")
  expect(details(before).join("\n")).toContain("Prepared provider: not recorded")
  expect(details({ ...before, provider: "local", destination: "route" }).join("\n")).toContain("Routing fingerprint: route")
})

test("large comparisons disclose display truncation while keeping full change counts", () => {
  const before = select([], 100_000)
  const after = select(Array.from({ length: 120 }, (_, index) => match(String(index))), 100_000)
  const lines = compare(after, before)
  expect(lines.at(0)).toContain("120 added")
  expect(lines.filter((line) => line.startsWith("Added "))).toHaveLength(100)
  expect(lines).toContain("20 further source changes not displayed.")
})
