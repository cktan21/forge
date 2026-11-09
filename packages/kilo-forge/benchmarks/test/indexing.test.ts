import { expect, test } from "bun:test"
import { indexing } from "../indexing"

test("indexing measurements count actual file reads, parsing and cold/delta equivalence", async () => {
  const report = await indexing(30)
  expect(report.modelCalls).toBe(0)
  expect(report.rows.map((row) => row.read)).toEqual([30, 0, 1, 30])
  expect(report.rows.map((row) => row.parsed)).toEqual([30, 0, 1, 30])
  expect(report.rows.at(0)?.generation).toBe(report.rows.at(1)?.generation)
  expect(report.rows.at(2)?.generation).toBe(report.rows.at(3)?.generation)
})
