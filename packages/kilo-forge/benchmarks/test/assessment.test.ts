import { expect, test } from "bun:test"
import { assess, key } from "../assessment"
import { arms } from "../harness"

const artifact = { path: "protocol.md", sha256: "a".repeat(64) }
const observed = arms.map((arm) => ({ task: "fixture", trial: 1, arm }))
const document = {
  version: 1,
  protocol: artifact,
  method: "manual-archived-evidence",
  rows: observed.map((row) => ({
    ...row,
    reviewer: "reviewer-1",
    evidence: [{ ...artifact, path: `${row.task}-${row.trial}-${row.arm}/messages.json` }],
    retrieval: { expected: ["src/a.ts", "src/b.ts"], retrieved: ["src/a.ts", "src/noise.ts"] },
    intent: {
      constraints: [
        { id: "atomic", text: "A failed batch leaves all stored values unchanged.", preserved: true },
        { id: "order", text: "Return results in request order.", preserved: false },
      ],
    },
  })),
}

test("manual assessments expose reviewed denominators and actual path and constraint ratios", () => {
  const result = assess(document, observed, observed, arms)
  expect(result.document?.rows.at(0)?.reviewer).toBe("reviewer-1")
  for (const arm of result.arms) {
    expect(arm.eligible).toBe(1)
    expect(arm.retrieval).toEqual({
      reviewed: 1,
      matched: 1,
      hits: 1,
      retrieved: 2,
      expected: 2,
      precision: 0.5,
      recall: 0.5,
    })
    expect(arm.intent).toEqual({
      reviewed: 1,
      matched: 1,
      passed: 1,
      total: 2,
      preservation: 0.5,
      preserved: 0,
    })
  }
})

test("absent and empty documents are unknown, not zero or pass", () => {
  for (const value of [undefined, { ...document, rows: [] }]) {
    for (const arm of assess(value, observed, observed, arms).arms) {
      expect(arm.retrieval.precision).toBeNull()
      expect(arm.retrieval.recall).toBeNull()
      expect(arm.intent.preservation).toBeNull()
      expect(arm.intent.preserved).toBeNull()
      expect(arm.retrieval.matched).toBe(0)
    }
  }
  expect(() => assess(null, observed, observed, arms)).toThrow()
})

test("pooled metrics retain path and constraint denominators across different tasks", () => {
  const extra = document.rows.map((row) => ({
    ...row,
    task: "second",
    retrieval: { expected: ["src/a.ts"], retrieved: ["src/a.ts"] },
    intent: { constraints: [row.intent.constraints.at(0)!] },
  }))
  const runs = [...observed, ...extra]
  const result = assess({ ...document, rows: [...document.rows, ...extra] }, runs, runs, arms)
  expect(result.arms.at(0)?.retrieval).toMatchObject({
    reviewed: 2,
    matched: 2,
    hits: 2,
    retrieved: 3,
    expected: 3,
    precision: 2 / 3,
    recall: 2 / 3,
  })
  expect(result.arms.at(0)?.intent).toMatchObject({
    reviewed: 2,
    matched: 2,
    passed: 2,
    total: 3,
    preservation: 2 / 3,
    preserved: 1,
  })
})

test("unknown assessment fields are errors rather than silently discarded annotations", () => {
  expect(() => assess({ ...document, invented: 1 }, observed, observed, arms)).toThrow()
  expect(() =>
    assess(
      {
        ...document,
        rows: [{ ...document.rows.at(0), retrival: { expected: ["a.ts"] } }],
      },
      observed,
      observed,
      arms,
    ),
  ).toThrow()
})

test("metric completeness matches the same available task/trial group across every arm", () => {
  const rows = document.rows.map((row) => (row.arm === "forge" ? { ...row, intent: undefined } : row))
  const result = assess({ ...document, rows }, observed, observed, arms)
  expect(result.arms.every((arm) => arm.retrieval.matched === 1)).toBe(true)
  expect(result.arms.every((arm) => arm.intent.matched === 0 && arm.intent.preservation == null)).toBe(true)
  expect(result.arms.at(0)?.intent.reviewed).toBe(1)
  expect(result.arms.at(2)?.intent.reviewed).toBe(0)
  const excluded = assess(document, observed, [], arms)
  expect(excluded.document?.rows).toHaveLength(3)
  expect(excluded.arms.every((arm) => arm.eligible === 0 && arm.retrieval.precision == null)).toBe(true)
})

test("reviewing different repetitions does not create an unpaired comparison", () => {
  const runs = [...observed, ...observed.map((row) => ({ ...row, trial: 2 }))]
  const rows = document.rows.map((row) => ({ ...row, trial: row.arm === "forge" ? 2 : 1 }))
  expect(assess({ ...document, rows }, runs, runs, arms).arms.every((arm) => arm.retrieval.matched === 0)).toBe(true)
})

test("empty retrieved paths mean unknown precision and zero recall, while empty rubrics are invalid", () => {
  const rows = document.rows.map((row) => ({ ...row, retrieval: { ...row.retrieval, retrieved: [] } }))
  expect(assess({ ...document, rows }, observed, observed, arms).arms.at(0)?.retrieval).toMatchObject({
    precision: null,
    recall: 0,
    matched: 1,
    retrieved: 0,
    expected: 2,
  })
  for (const change of [{ retrieval: { expected: [], retrieved: [] } }, { intent: { constraints: [] } }]) {
    expect(() =>
      assess({ ...document, rows: [{ ...document.rows.at(0), ...change }] }, observed, observed, arms),
    ).toThrow()
  }
})

test("invalid IDs, duplicates, absent provenance and nonboolean judgments fail closed", () => {
  const row = document.rows.at(0)!
  const invalid = [
    { task: "" },
    { task: "../fixture" },
    { task: " fixture" },
    { task: "unknown" },
    { trial: 0 },
    { trial: 1.5 },
    { trial: Infinity },
    { trial: NaN },
    { trial: 2 },
    { arm: "other" },
    { reviewer: "" },
    { reviewer: " " },
    { evidence: [] },
    { evidence: [{ path: "/absolute/messages.json", sha256: artifact.sha256 }] },
    { evidence: [{ ...artifact, sha256: "invalid" }] },
    { evidence: [artifact, artifact] },
    { retrieval: undefined, intent: undefined },
    { intent: { constraints: [{ id: "x", text: "Explicit constraint", preserved: "true" }] } },
    { intent: { constraints: [{ id: "x", text: "", preserved: true }] } },
    { intent: { constraints: [row.intent.constraints.at(0), row.intent.constraints.at(0)] } },
  ]
  for (const change of invalid)
    expect(() => assess({ ...document, rows: [{ ...row, ...change }] }, observed, observed, arms)).toThrow()
  expect(() => assess({ ...document, rows: [row, row] }, observed, observed, arms)).toThrow("Duplicate")
  expect(() => assess(document, [...observed, observed.at(0)!], observed, arms)).toThrow("Duplicate")
  expect(() => assess({ ...document, method: "llm-score" }, observed, observed, arms)).toThrow()
  expect(() => assess({ ...document, protocol: undefined }, observed, observed, arms)).toThrow()
  expect(() => key({ ...observed.at(0)!, trial: Number.MAX_SAFE_INTEGER + 1 })).toThrow()
})

test("paths must be canonical relative file labels, without duplicates or traversal", () => {
  const row = document.rows.at(0)!
  for (const file of [
    "",
    " ",
    "/src/a.ts",
    "../a.ts",
    "src/../a.ts",
    "./a.ts",
    "src//a.ts",
    "src/",
    "C:/a.ts",
    "src\\a.ts",
    "src/\na.ts",
  ]) {
    for (const field of ["expected", "retrieved"]) {
      expect(() =>
        assess(
          {
            ...document,
            rows: [{ ...row, retrieval: { ...row.retrieval, [field]: [file] } }],
          },
          observed,
          observed,
          arms,
        ),
      ).toThrow()
    }
  }
  expect(() =>
    assess(
      {
        ...document,
        rows: [{ ...row, retrieval: { expected: ["a.ts"], retrieved: ["a.ts", "a.ts"] } }],
      },
      observed,
      observed,
      arms,
    ),
  ).toThrow("Duplicate")
})

test("task relevance and explicit intent rubrics cannot change between arms or trials", () => {
  const row = document.rows.at(0)!
  for (const change of [
    { retrieval: { expected: ["different.ts"], retrieved: [] } },
    { intent: { constraints: [{ ...row.intent.constraints.at(0)!, text: "A post-hoc replacement" }] } },
  ]) {
    expect(() =>
      assess(
        {
          ...document,
          rows: [row, { ...document.rows.at(1), ...change }],
        },
        observed,
        observed,
        arms,
      ),
    ).toThrow(/differ/)
  }
  const rows = document.rows.map((row) => ({
    ...row,
    retrieval: { ...row.retrieval, expected: [...row.retrieval.expected].reverse() },
    intent: { constraints: [...row.intent.constraints].reverse() },
  }))
  expect(
    assess({ ...document, rows: [row, ...rows.slice(1)] }, observed, observed, arms).arms.at(0)?.retrieval.recall,
  ).toBe(0.5)
})
