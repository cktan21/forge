import { expect, test } from "bun:test"
import { activity } from "../src/activity"

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
