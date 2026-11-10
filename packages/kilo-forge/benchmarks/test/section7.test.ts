import { expect, test } from "bun:test"
import { measurements } from "../section7"

const row = {
  task: "fixture",
  trial: 1,
  arm: "normal",
  state: "completed",
  initial: "same",
  success: true,
  blocked: false,
  error: "",
  elapsed: 1000,
  preparation: 0,
  tokens: 10,
  cost: 0,
  reported: { tokens: 10, cost: 0 },
  prepared: { input: 0, output: 0 },
  usage: { calls: 1 },
  tools: [],
  grading: { passed: 1, total: 1, regression: true, changed: [] },
}
const report = {
  version: 5,
  model: "openai/gpt-5.6-sol",
  started: "2026-11-09",
  fixture: "fixture",
  provenance: {},
  trials: 1,
  tasks: 1,
  limitations: [],
  rows: ["normal", "generic", "forge"].map((arm) => ({ ...row, arm })),
}

test("Section 7 uses measured counts and rejects wrong model families or experiment types", () => {
  const value = measurements(report)
  expect(value.metrics.map((arm) => arm.successes)).toEqual([1, 1, 1])
  expect(value.metrics.map((arm) => arm.median)).toEqual([1, 1, 1])
  expect(() => measurements({ ...report, model: "openai/gpt-6-astra" })).toThrow("GPT-5.x")
  expect(() => measurements({ ...report, version: 4 })).toThrow("preparation-only")
})

test("Section 7 keeps partial outcomes and unknown usage without inventing comparisons", () => {
  const value = measurements({
    ...report,
    rows: [{ ...row, tokens: null, cost: null, known: { preparation: true, coding: false } }],
  })
  expect(value.metrics.at(0)?.attempted).toBe(1)
  expect(value.metrics.at(0)?.runs).toBe(0)
  expect(value.metrics.at(1)?.attempted).toBe(0)
  expect(value.metrics.at(1)?.median).toBeNull()
  expect(value.summary.unmatched).toBe(1)
})
