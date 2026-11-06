import { expect, test } from "bun:test"
import { audit } from "../src/audit"
import { summary, channels } from "../src/selection"
import { select } from "../src/context"
import { source } from "../src/parse"

test("selection records preserve scoped candidate versions and reasons without copying source text", () => {
  const matches = Array.from({ length: 4 }, (_, index) => ({
    source: source(`file-${index}.ts`, `source-private-text-${index} ${"text ".repeat(100)}`, "code"),
    score: 1, reason: "BM25 path and content match",
  }))
  const selected = { ...select(matches, 800, "ranked"), policy: "policy-at-selection", provider: "local" }
  const value = audit(matches, selected, 2)
  expect(value.total).toBe(4)
  expect(value.candidates.some((item) => item.state === "selected")).toBe(true)
  expect(value.candidates.some((item) => item.state === "omitted" && item.reason.includes("budget"))).toBe(true)
  expect(value.policy).toBe("policy-at-selection")
  expect(value.withheld).toBe(2)
  for (const item of value.candidates) expect(item.hash).toBe(matches.find((match) => match.source.id === item.source)!.source.hash)
  expect(JSON.stringify(value)).not.toContain("source-private-text")
  expect(summary()).toContain("unavailable")
})

test("history bounds prioritize selected pins, deduplicate IDs, and retain retrieval plus pin reasons", () => {
  const matches = Array.from({ length: 600 }, (_, index) => ({
    source: source(`file-${index}.ts`, `unique source ${index}`, "code"), score: 1, reason: "Keyword candidate",
  }))
  const pin = { ...matches.at(-1)!, reason: "Required by developer" }
  const selected = select([pin, ...matches], 1000, "ranked", [pin.source.id])
  const value = audit(matches, selected)
  expect(value.candidates).toHaveLength(512)
  expect(value.total).toBe(600)
  expect(value.unrecorded).toBe(88)
  expect(value.candidates.at(0)).toMatchObject({
    source: pin.source.id, state: "selected", retrieval: "Keyword candidate; Required by developer",
  })
  expect(summary(value)).toContain("88 records outside the history limit")
  expect(new Set(value.candidates.map((item) => item.source)).size).toBe(512)
})

test("channel metadata preserves pre-fusion ranks without retaining withheld identities or passages", () => {
  const matches = ["visible", "withheld"].map((key) => ({
    source: source(`${key}.ts`, `${key} private passage`, "code"), score: 42, reason: "Lexical hit",
  }))
  const visible = matches.at(0)!
  const result = audit([visible], select([visible], 1000), 1, [
    { name: "keyword", state: "completed", matches: [matches.at(1)!, visible] },
    { name: "semantic", state: "completed", matches: [{ ...visible, score: 0.9, reason: "Embedding hit" }], withheld: 2 },
    { name: "memory", state: "failed", matches: [] },
  ])
  expect(result.candidates.at(0)?.channels).toEqual([
    { name: "keyword", rank: 2, score: 42, reason: "Lexical hit" },
    { name: "semantic", rank: 1, score: 0.9, reason: "Embedding hit" },
  ])
  expect(result.channels).toEqual([
    { name: "keyword", state: "completed", candidates: 1, withheld: 1 },
    { name: "semantic", state: "completed", candidates: 1, withheld: 2 },
    { name: "memory", state: "failed", candidates: 0, withheld: 0 },
  ])
  expect(JSON.stringify(result)).not.toContain(matches.at(1)!.source.id)
  expect(JSON.stringify(result)).not.toContain("private passage")
  expect(channels(result).join("\n")).toContain("not exhaustive corpus coverage")
  expect(channels().at(0)).toContain("unavailable")
  expect(audit([visible], select([visible], 1000)).channels).toBeUndefined()
})
