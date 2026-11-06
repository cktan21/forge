import { expect, test } from "bun:test"
import { benchmark } from "../knowledge"
import { documents } from "../documents"

test("registered-document evaluation isolates arms and preserves comparable evidence identities", async () => {
  const result = await benchmark(documents.slice(0, 1), { budgets: [2400], trials: 2 })
  expect(result.modelCalls).toBe(0)
  expect(result.scope).toContain("No held-out or coding-quality claim")
  expect(result.rows).toHaveLength(12)
  expect(result.rows.map((row) => row.routing)).toEqual([
    "flat",
    "flat",
    "flat",
    "domains",
    "domains",
    "domains",
    "domains",
    "domains",
    "domains",
    "flat",
    "flat",
    "flat",
  ])
  expect(result.rows.every((row) => row.tokens <= row.budget)).toBe(true)
  for (const trial of [0, 1]) {
    const rows = result.rows.filter((row) => row.trial === trial && row.task === "authorization")
    const first = rows.at(0)!
    const second = rows.at(1)!
    expect(first.missing).toEqual([])
    expect(second.missing).toEqual([])
    for (const page of ["1", "2"]) {
      const before = first.citations.find((item) => item.document === "reference.pdf" && item.page === page)
      const after = second.citations.find((item) => item.document === "reference.pdf" && item.page === page)
      expect(before).toBeDefined()
      expect(after).toEqual(before)
    }
  }
}, 30_000)

test("registered-document evaluation rejects absent labels and invalid trial budgets", async () => {
  const fixture = {
    name: "invalid",
    files: { "entry.ts": "export const value = 1" },
    tasks: [{ id: "missing", query: "value", required: ["not-indexed.md#Absent"], supporting: [] }],
  }
  const failure = await benchmark([fixture], { trials: 1, budgets: [600] }).then(
    () => undefined,
    (err) => err,
  )
  expect(failure).toBeInstanceOf(Error)
  expect(failure.message).toContain("Missing indexed evidence label")
  for (const opts of [{ trials: 0 }, { budgets: [] }, { budgets: [0] }]) {
    const failure = await benchmark([fixture], opts).then(
      () => undefined,
      (err) => err,
    )
    expect(failure).toBeInstanceOf(Error)
  }
})
