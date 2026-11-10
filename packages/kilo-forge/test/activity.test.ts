import { expect, test } from "bun:test"
import { activity, combine } from "../src/activity"

test("activity retains a bounded window per section and full counts", () => {
  const log = activity()
  log.add({ action: "Read locally", path: "first.ts", detail: "Actual file bytes read" })
  const first = log.snapshot()
  for (let index = 0; index < 250; index++) log.add({ action: "Retrieved candidate", path: `${index}.ts`, detail: "Keyword" })
  expect(first.entries).toHaveLength(1)
  expect(first.total).toBe(1)
  expect(log.snapshot().entries).toHaveLength(21)
  expect(log.snapshot().entries.at(0)?.path).toBe("first.ts")
  expect(log.snapshot().counts).toEqual({ repository: 1, retrieval: 250 })
  expect(log.snapshot().total).toBe(251)
})

test("activity strips controls, redacts secrets, omits absent paths, and ignores cancellation", () => {
  const controller = new AbortController()
  const log = activity(undefined, controller.signal)
  log.add({ action: "Search started", detail: "keyword" })
  expect(Object.hasOwn(log.snapshot().entries.at(0)!, "path")).toBe(false)
  log.add({ action: "Read locally", path: "guide\n.md", detail: "password=private-canary" })
  expect(log.snapshot().entries.at(1)).toMatchObject({ path: "guide .md", detail: "password=[REDACTED]" })
  controller.abort()
  log.add({ action: "Selected for model", path: "late.ts", detail: "Late response" })
  expect(log.snapshot().total).toBe(2)
})

test("combined turn activity keeps complete counts and the latest samples from every call", () => {
  const first = activity()
  first.add({ action: "Read locally", path: "first.ts", detail: "Actual file bytes read" })
  for (let index = 0; index < 25; index++) first.add({ action: "Retrieved candidate", path: `${index}.ts`, detail: "Keyword" })
  const second = activity()
  for (let index = 25; index < 50; index++) second.add({ action: "Retrieved candidate", path: `${index}.ts`, detail: "Keyword" })
  second.add({ action: "Selected for model", path: "selected.ts:10-20", detail: "Selected excerpt" })
  const log = combine([first.snapshot(), second.snapshot()])
  expect(log.total).toBe(52)
  expect(log.counts).toEqual({ repository: 1, retrieval: 50, context: 1 })
  expect(log.entries).toHaveLength(22)
  expect(log.entries.at(0)?.path).toBe("first.ts")
  expect(log.entries.at(1)?.path).toBe("30.ts")
  expect(log.entries.at(-1)?.path).toBe("selected.ts:10-20")
  expect(first.snapshot().entries).toHaveLength(21)
})

test("combined activity supports older logs without per-section counts", () => {
  expect(combine([
    { total: 1, entries: [{ action: "Read locally", path: "old.ts", detail: "Local read" }] },
    { total: 8, counts: { search: 8, checks: 0 }, entries: [{ action: "Search complete", detail: "Matches retrieved" }] },
  ])).toMatchObject({ total: 9, counts: { repository: 1, search: 8, checks: 0 } })
  expect(combine([])).toEqual({ total: 0, counts: {}, entries: [] })
})
