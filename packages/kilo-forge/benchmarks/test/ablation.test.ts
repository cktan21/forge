import { expect, test } from "bun:test"
import { arms, free, order, tools } from "../ablation"
import { summarize } from "../report"

const cost = { input: 0, output: 0, cache: { read: 0, write: 0 } }
const model = { id: "named/model:free", isFree: true, cost }

test("free-only guard rejects paid, missing, unknown and routed pricing", () => {
  expect(() => free(model)).not.toThrow()
  for (const value of [
    undefined,
    { ...model, isFree: undefined },
    { ...model, isFree: false },
    { ...model, autoRouting: { models: ["other"] } },
    { ...model, id: "kilo-auto/free" },
    { ...model, id: "openrouter/free" },
    ...["input", "output"].map((key) => ({ ...model, cost: { ...cost, [key]: 1 } })),
    { ...model, cost: { ...cost, input: NaN } },
    { ...model, cost: { ...cost, cache: { read: 0, write: 1 } } },
    { ...model, cost: { ...cost, tiers: [{ ...cost, output: 1, tier: { type: "context" as const, size: 200000 } }] } },
    { ...model, cost: { ...cost, experimentalOver200K: { ...cost, input: 1 } } },
  ])
    expect(() => free(value)).toThrow()
})

test("paired order balances position and reverses on the next trial", () => {
  expect(order(0, 1)).toEqual(["normal", "forge"])
  expect(order(1, 1)).toEqual(["forge", "normal"])
  for (let index = 0; index < 4; index++) expect(order(index, 2)).toEqual([...order(index, 1)].reverse())
  expect(tools).toHaveLength(4)
})

const row = {
  task: "fixture",
  trial: 1,
  initial: "same",
  success: true,
  error: "",
  blocked: false,
  elapsed: 100,
  preparation: 0,
  tokens: 10,
  cost: 0,
  state: "completed",
  prepared: { input: 0, output: 0 },
  usage: { calls: 1 },
  grading: { passed: 1, total: 1, regression: true, changed: [] },
}
const report = {
  version: 4,
  arms,
  started: "2026-11-09T00:00:00Z",
  model: model.id,
  trials: 1,
  tasks: 1,
  fixture: "fixture",
  limitations: ["Synthetic regression fixture, not live inference"],
  rows: arms.map((arm) => ({
    ...row,
    arm,
    tools: arm === "forge" ? [{ tool: tools.at(0)!, status: "completed" }] : [],
  })),
}

test("tools-only reporting exposes actual Forge adoption and rejects preparation or baseline leakage", () => {
  const result = summarize(report)
  expect(result.arms.at(1)?.forge).toEqual({ attempted: 1, completed: 1, runs: 1 })
  expect(result.comparison).toEqual({
    pairs: 1,
    wins: 0,
    losses: 0,
    both: 1,
    neither: 0,
    points: 0,
    seconds: 0,
    measured: 1,
    tokens: 0,
  })
  expect(result.text).toContain("Tools-only ablation")
  expect(result.text).not.toContain("This legacy report")
  expect(() => summarize({ ...report, rows: report.rows.map((item) => ({ ...item, preparation: 1 })) })).toThrow(
    "must not include",
  )
  expect(() =>
    summarize({
      ...report,
      rows: report.rows.map((item) => ({ ...item, tools: [{ tool: "forge_search_code", status: "error" }] })),
    }),
  ).toThrow("Normal baseline used a Forge tool")
})

test("paired effects retain failures but compare efficiency only for jointly solved tasks", () => {
  const failed = { ...row, success: false, grading: { passed: 0, total: 1, regression: true, changed: [] } }
  const result = summarize({
    ...report,
    trials: 3,
    rows: [
      ...report.rows.map((item) => ({
        ...item,
        elapsed: item.arm === "forge" ? 2000 : 5000,
        tokens: item.arm === "forge" ? 10 : 20,
      })),
      { ...failed, arm: "normal", trial: 2 },
      { ...row, arm: "forge", trial: 2, elapsed: 100000 },
      { ...row, arm: "normal", trial: 3 },
      { ...failed, arm: "forge", trial: 3, elapsed: 1 },
    ],
  })
  expect(result.comparison).toEqual({
    pairs: 3,
    wins: 1,
    losses: 1,
    both: 1,
    neither: 0,
    points: 0,
    seconds: -3,
    measured: 1,
    tokens: -10,
  })
  const partial = summarize({ ...report, rows: report.rows.slice(0, 1) }, true)
  expect(partial.comparison?.pairs).toBe(0)
  expect(partial.comparison?.points).toBeNull()
  expect(partial.comparison?.seconds).toBeNull()
})
