import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { argumentsFor, summarize } from "../report"
import { dataset as metadata } from "../repositories"
import { tasks } from "../tasks"

const report = {
  started: "2026-10-24T00:00:00Z",
  model: "fixture",
  trials: 1,
  tasks: 1,
  fixture: "fixture",
  limitations: ["Test data only"],
  rows: [
    {
      task: "fixture",
      trial: 1,
      arm: "normal",
      initial: "same-files",
      success: true,
      error: "",
      blocked: false,
      elapsed: 10000,
      preparation: 0,
      tokens: 1000,
      cost: 0.01,
      prepared: { input: 0, output: 0 },
      usage: { calls: 2 },
      grading: { passed: 6, total: 6, regression: true, changed: ["src/code.ts", "tests/test.ts", "docs/api.md"] },
    },
    {
      task: "fixture",
      trial: 1,
      arm: "forge",
      initial: "same-files",
      success: false,
      error: "Clarification required",
      blocked: true,
      elapsed: 5000,
      preparation: 5000,
      tokens: 400,
      cost: 0.002,
      prepared: { input: 300, output: 100 },
      usage: { calls: 0 },
      grading: { passed: 1, total: 6, regression: true, changed: [] },
    },
  ],
}

test("report counts blocked attempts without presenting them as efficiency wins", () => {
  const result = summarize(report)
  expect(result.arms.at(0)?.successes).toBe(1)
  expect(result.arms.at(1)?.successes).toBe(0)
  expect(result.arms.at(1)?.blocked).toBe(1)
  expect(result.arms.at(1)?.overhead).toBe(400)
  expect(result.text).toContain("not an efficiency win")
  expect(result.text).toContain("| fixture | 1 | forge | BLOCKED |")
})

test("report refuses incomplete comparisons or different starting code", () => {
  expect(() => summarize({ ...report, rows: report.rows.slice(0, 1) })).toThrow("complete normal/Forge pairs")
  expect(() =>
    summarize({
      ...report,
      rows: report.rows.map((row) => ({ ...row, initial: row.arm })),
    }),
  ).toThrow("different files")
})

test("report rejects a normal baseline that executed a Forge tool", () => {
  expect(() =>
    summarize({
      ...report,
      rows: report.rows.map((row) => ({
        ...row,
        tools: row.arm === "normal" ? [{ tool: "forge_search_code", status: "completed" }] : [],
      })),
    }),
  ).toThrow("Normal baseline used a Forge tool")
})

test("partial reports retain unmatched attempts without contaminating paired aggregates", () => {
  const extra = { ...report.rows.at(0)!, trial: 2, success: false, error: "PROMOTION_MODEL_LIMIT_REACHED" }
  const result = summarize({ ...report, trials: 2, rows: [...report.rows, extra] }, true)
  expect(result.unmatched).toBe(1)
  expect(result.arms.at(0)?.runs).toBe(1)
  expect(result.arms.at(0)?.tokens).toBe(1000)
  expect(result.text).toContain("Recorded 3 of 4 planned attempts")
  expect(result.text).toContain("UNAVAILABLE (unpaired)")
  expect(result.text).toContain("Anonymous model quota exhausted")
  expect(result.text).toContain("2400 reported tokens")
})

const triple = {
  ...report,
  version: 2,
  arms: ["normal", "generic", "forge"],
  provenance: { revision: "fixture-revision", configuration: "fixture-config" },
  rows: [...report.rows, { ...report.rows.at(0)!, arm: "generic" }],
}

test("three-arm reports compare complete triples and retain provenance", () => {
  const result = summarize(triple)
  expect(result.arms.map((arm) => arm.arm)).toEqual(["normal", "generic", "forge"])
  expect(result.arms.every((arm) => arm.runs === 1)).toBe(true)
  expect(result.text).toContain("Recorded 3 of 3 planned attempts")
  expect(result.text).toContain("fixture-revision")
  expect(() => summarize({ ...triple, rows: report.rows })).toThrow("complete normal/generic/Forge triples")
  expect(summarize({ ...triple, rows: report.rows }, true).arms.every((arm) => arm.runs === 0)).toBe(true)
})

test("four-arm reports require matched groups and equal standard coding tools", () => {
  const value = { ...triple, version: 3, arms: ["normal", "generic", "forge", "investigative"], rows: [...triple.rows, { ...report.rows.at(0)!, arm: "investigative" }] }
  const result = summarize(value)
  expect(result.arms).toHaveLength(4)
  expect(result.text).toContain("four-arm groups")
  expect(result.text).toContain("predeclared protocol")
  expect(() => summarize({ ...value, rows: triple.rows })).toThrow("complete four-arm groups")
  expect(() => summarize({ ...value, rows: value.rows.map((row) => ({ ...row, tools: row.arm === "investigative" ? [{ tool: "forge_search_code", status: "completed" }] : [] })) })).toThrow("baseline used a Forge tool")
})

test("unavailable providers exclude the entire triple, including successful partners", () => {
  const result = summarize({
    ...triple,
    rows: triple.rows.map((row) =>
      row.arm !== "generic"
        ? row
        : {
            ...row,
            success: false,
            error: "HTTP 401 Unauthorized",
            failure: "auth",
            tokens: null,
            cost: null,
            reported: { tokens: 120, cost: 0.001 },
            known: { preparation: false, coding: true },
          },
    ),
  })
  expect(result.arms.every((arm) => arm.runs === 0 && arm.successes === 0)).toBe(true)
  expect(result.arms.at(1)?.unavailable).toBe(1)
  expect(result.text).toContain("1520 reported tokens")
  expect(result.text).toContain("unknown token or cost totals")
  expect(result.text).toContain("UNAVAILABLE (excluded group)")
  expect(result.text).not.toContain("NaN")
})

test("workflow failures remain in denominators with unknown totals, not invented zero usage", () => {
  const result = summarize({
    ...triple,
    rows: triple.rows.map((row) =>
      row.arm !== "forge"
        ? row
        : {
            ...row,
            blocked: false,
            error: "Invalid inspect",
            failure: "workflow",
            tokens: null,
            cost: null,
            known: { preparation: false, coding: true },
            reported: { tokens: 0, cost: 0 },
          },
    ),
  })
  expect(result.arms.at(2)?.runs).toBe(1)
  expect(result.arms.at(2)?.tokens).toBeNull()
  expect(result.arms.at(2)?.cost).toBeNull()
  expect(result.arms.at(2)?.overhead).toBeNull()
})

test("empty and in-flight partial reports make no model-failure claims", () => {
  const empty = summarize({ ...triple, rows: [] }, true)
  expect(empty.text).toContain("Recorded 0 of 3")
  const result = summarize(
    {
      ...triple,
      rows: [{ ...triple.rows.at(0)!, success: false, state: "running", grading: null, tokens: null, cost: null }],
    },
    true,
  )
  expect(result.arms.at(0)?.unavailable).toBe(1)
  expect(result.text).toContain("incomplete")
  expect(result.text).toContain("UNAVAILABLE (unpaired)")
})

test("legacy failed preparation zero usage is treated as unknown", () => {
  const result = summarize({
    ...report,
    rows: report.rows.map((row) =>
      row.arm === "normal"
        ? row
        : {
            ...row,
            blocked: false,
            error: "Invalid inspect",
            tokens: 0,
            cost: 0,
            prepared: { input: 0, output: 0 },
          },
    ),
  })
  expect(result.arms.at(1)?.tokens).toBeNull()
  expect(result.text).toContain("Legacy reports did not reliably measure")
})

test("duplicates, mismatched files and generic Forge tool usage fail closed even in partial mode", () => {
  expect(() => summarize({ ...triple, rows: [...triple.rows, triple.rows.at(0)] }, true)).toThrow("Duplicate")
  expect(() =>
    summarize(
      {
        ...triple,
        rows: triple.rows.map((row) => ({ ...row, initial: row.arm })),
      },
      true,
    ),
  ).toThrow("different files")
  expect(() =>
    summarize({
      ...triple,
      rows: triple.rows.map((row) => ({
        ...row,
        tools: row.arm === "generic" ? [{ tool: "forge_search_code", status: "completed" }] : [],
      })),
    }),
  ).toThrow("Generic baseline used a Forge tool")
})

const assessments = {
  version: 1,
  protocol: { path: "protocol.md", sha256: "a".repeat(64) },
  method: "manual-archived-evidence",
  rows: triple.rows.map((row) => ({
    task: row.task,
    trial: row.trial,
    arm: row.arm,
    reviewer: "human-reviewer",
    evidence: [{ path: `${row.arm}/messages.json`, sha256: "b".repeat(64) }],
    retrieval: { expected: ["src/code.ts"], retrieved: row.arm === "forge" ? [] : ["src/code.ts"] },
    intent: {
      constraints: [{ id: "atomic", text: "Failed writes leave state unchanged.", preserved: row.arm !== "forge" }],
    },
  })),
}

test("report renders optional audited assessments and matching reviewed denominators", () => {
  const result = summarize(triple, false, assessments)
  expect(result.arms.at(0)?.assessment.retrieval.precision).toBe(1)
  expect(result.arms.at(2)?.assessment.retrieval.precision).toBeNull()
  expect(result.arms.at(2)?.assessment.retrieval.recall).toBe(0)
  expect(result.text).toContain("human-reviewer")
  expect(result.text).toContain("manual-archived-evidence")
  expect(result.text).toContain("| Intent constraints preserved | 1.000 (1/1) | 1.000 (1/1) | 0.000 (0/1) |")
  expect(result.text).toContain("No superiority decision is automated")
  const missing = summarize(triple)
  expect(missing.text).toContain("| Intent constraints preserved | unknown | unknown | unknown |")
  const partial = summarize(triple, false, { ...assessments, rows: assessments.rows.slice(0, 1) })
  expect(partial.arms.at(0)?.assessment.retrieval.reviewed).toBe(1)
  expect(partial.arms.every((arm) => arm.assessment.retrieval.precision == null)).toBe(true)
})

test("assessed unavailable and unmatched attempts remain auditable but excluded", () => {
  const rows = triple.rows.map((row) =>
    row.arm === "generic" ? { ...row, success: false, failure: "infrastructure" } : row,
  )
  const result = summarize({ ...triple, rows }, false, assessments)
  expect(result.assessments?.rows).toHaveLength(3)
  expect(result.arms.every((arm) => arm.assessment.retrieval.matched === 0)).toBe(true)
  const partial = summarize({ ...triple, rows: [triple.rows.at(0)] }, true, {
    ...assessments,
    rows: [assessments.rows.at(0)],
  })
  expect(partial.assessments?.rows).toHaveLength(1)
  expect(partial.arms.at(0)?.assessment.intent.preservation).toBeNull()
  expect(() => summarize({ ...triple, rows: [triple.rows.at(0)] }, true, assessments)).toThrow("does not match")
})

test("legacy two-arm reports support assessments without requiring generic reviews", () => {
  const result = summarize(report, false, {
    ...assessments,
    rows: assessments.rows.filter((row) => row.arm !== "generic"),
  })
  expect(result.arms.map((arm) => arm.arm)).toEqual(["normal", "forge"])
  expect(result.arms.every((arm) => arm.assessment.intent.matched === 1)).toBe(true)
})

test("dataset metadata distinguishes real repository subsets and preserves loader provenance", () => {
  const dataset = {
    kind: "repository-subsets",
    tasks: [
      {
        id: "fixture",
        repository: "upstream/project",
        revision: "a".repeat(40),
        files: ["src/code.ts"],
        custom: { pinned: true },
      },
    ],
    custom: "future loader field",
  }
  const result = summarize({ ...triple, dataset })
  expect(result.dataset).toEqual(dataset)
  expect(result.text).toContain("selected file subsets from pinned real repositories")
  expect(result.text).toContain("not full-repository inputs")
  expect(result.text).not.toContain("comparison on synthetic repositories")
  expect(result.text).toContain("future loader field")
  expect(summarize({ ...triple, dataset: { ...dataset, kind: "synthetic" } }).text).toContain(
    "comparison on synthetic repositories",
  )
  expect(summarize(triple).text).toContain("Dataset metadata is absent")
  for (const value of [
    null,
    { ...dataset, kind: "full-repositories" },
    { ...dataset, tasks: [] },
    { ...dataset, tasks: [...dataset.tasks, ...dataset.tasks] },
    { ...dataset, tasks: [{ id: "other" }] },
  ])
    expect(() => summarize({ ...triple, dataset: value })).toThrow()
})

test("repository subset claims require minimum immutable provenance even in partial reports", () => {
  const task = {
    id: "fixture",
    repository: "/local/project",
    revision: "a".repeat(40),
    files: ["src/code.ts"],
  }
  for (const change of [
    { repository: undefined },
    { repository: "" },
    { repository: " " },
    { repository: "/local/\0project" },
    { revision: undefined },
    { revision: "HEAD" },
    { revision: "a".repeat(39) },
    { revision: "g".repeat(40) },
    { files: undefined },
    { files: null },
    { files: {} },
    { files: "src/code.ts" },
    { files: [] },
    { files: [1] },
    { files: [""] },
    { files: ["/src/code.ts"] },
    { files: ["../code.ts"] },
    { files: ["src/./code.ts"] },
    { files: ["src//code.ts"] },
    { files: ["src\\code.ts"] },
    { files: ["src/\0code.ts"] },
    { files: ["src/code.ts", "src/code.ts"] },
    { files: ["src/code.ts", "SRC/code.ts"] },
  ]) {
    const dataset = { kind: "repository-subsets", tasks: [{ ...task, ...change }] }
    for (const partial of [false, true]) expect(() => summarize({ ...triple, dataset }, partial)).toThrow()
  }
  expect(() => summarize({ ...triple, dataset: { kind: "repository-subsets", tasks: [{ id: "fixture" }] } })).toThrow(
    "Repository subset provenance",
  )
  for (const revision of ["a".repeat(40), "b".repeat(64)]) {
    const dataset = metadata([
      {
        ...tasks.at(0)!,
        id: "fixture",
        provenance: {
          ...task,
          revision,
          scope: "selected-files",
          snapshot: "c".repeat(64),
          definition: "d".repeat(64),
        },
      },
    ])
    const result = summarize({ ...triple, dataset })
    expect(result.dataset).toEqual(dataset)
    expect(result.text).toContain("does not authenticate repositories")
    expect(result.text).toContain(dataset.hash)
  }
})

test("report rejects impossible grading counts before rendering any aggregate or individual result", () => {
  for (const change of [
    { passed: 2, total: 1 },
    { passed: 0, total: 0 },
    { passed: 0.5 },
    { total: 6.5 },
    { passed: -1 },
    { total: -1 },
    { passed: NaN },
    { total: Infinity },
    { passed: Number.MAX_SAFE_INTEGER + 1, total: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    const row = report.rows.at(0)!
    const rows = [{ ...row, grading: { ...row.grading, ...change } }, ...report.rows.slice(1)]
    for (const partial of [false, true]) expect(() => summarize({ ...report, rows }, partial)).toThrow()
    expect(() => summarize({ ...report, rows: rows.slice(0, 1) }, true)).toThrow()
  }
})

test("report rejects success inconsistent with grades, regressions or execution outcomes", () => {
  const row = report.rows.at(0)!
  for (const change of [
    { grading: { ...row.grading, passed: 0, total: 1, regression: false } },
    { grading: { ...row.grading, passed: 0 } },
    { grading: { ...row.grading, regression: false } },
    { grading: { ...row.grading, success: false } },
    { grading: null },
    { blocked: true },
    { error: "Runtime error" },
    { state: "running" },
    { success: false },
    ...["auth", "quota", "infrastructure", "workflow", "interrupted"].map((failure) => ({ failure })),
  ]) {
    const rows = [{ ...row, ...change }, ...report.rows.slice(1)]
    for (const partial of [false, true])
      expect(() => summarize({ ...report, rows }, partial)).toThrow("Report success contradicts")
    expect(() => summarize({ ...report, rows: rows.slice(0, 1) }, true)).toThrow("Report success contradicts")
  }
  for (const change of [{ passed: 0 }, { regression: false }])
    expect(() =>
      summarize({
        ...report,
        rows: [
          { ...row, success: false, grading: { ...row.grading, success: true, ...change } },
          ...report.rows.slice(1),
        ],
      }),
    ).toThrow("Grading success contradicts")
})

test("valid legacy and current outcomes preserve blocked, failed, zero-pass and successful results", () => {
  const row = report.rows.at(0)!
  for (const change of [
    { success: false, grading: { ...row.grading, passed: 0 } },
    { success: false, grading: { ...row.grading, regression: false } },
    { success: false, grading: { ...row.grading, success: false } },
    { success: false, blocked: true },
    { success: false, error: "Runtime error" },
    { success: false, failure: "workflow" },
  ]) {
    const result = summarize({ ...report, rows: [{ ...row, ...change }, ...report.rows.slice(1)] })
    expect(result.arms.at(0)?.successes).toBe(0)
    expect(result.arms.at(0)?.runs).toBe(1)
    expect(result.text).not.toContain("All comparable attempts solved")
  }
  for (const version of [undefined, 1, 2]) {
    const rows = (version === 2 ? triple : report).rows.map((item) => ({ ...row, arm: item.arm }))
    const result = summarize({ ...report, version, rows })
    expect(result.arms.every((arm) => arm.successes === 1 && arm.passed === 6)).toBe(true)
    expect(result.text).toContain("All comparable attempts solved")
  }
})

test("report rejects invalid identities, planned counts and nonfinite measurements", () => {
  for (const change of [
    { task: "" },
    { task: "../x" },
    { trial: 0 },
    { trial: 0.5 },
    { trial: 2 },
    { tokens: NaN },
    { cost: Infinity },
    { elapsed: -1 },
    { reported: { tokens: Infinity, cost: 0 } },
  ])
    expect(() => summarize({ ...triple, rows: triple.rows.map((row) => ({ ...row, ...change })) })).toThrow()
  for (const value of [0, NaN, Infinity, 1.5]) expect(() => summarize({ ...triple, trials: value })).toThrow()
})

test("assessment rubric must match optional frozen dataset relevance and intent labels", () => {
  const task = {
    id: "fixture",
    relevant: ["src/code.ts"],
    constraints: ["Failed writes leave state unchanged."],
  }
  const dataset = { kind: "synthetic", tasks: [task] }
  expect(summarize({ ...triple, dataset }, false, assessments).arms.at(0)?.assessment.intent.preserved).toBe(1)
  for (const change of [{ relevant: ["other.ts"] }, { constraints: ["A different requirement"] }]) {
    expect(() =>
      summarize(
        {
          ...triple,
          dataset: { ...dataset, tasks: [{ ...task, ...change }] },
        },
        false,
        assessments,
      ),
    ).toThrow(/differs from dataset/)
  }
})

test("report CLI accepts assessments and partial in either position without changing legacy positionals", () => {
  expect(argumentsFor(["in.json", "out.md", "--partial"])).toEqual({
    input: "in.json",
    output: "out.md",
    partial: true,
    assessments: undefined,
  })
  for (const args of [
    ["in.json", "out.md", "--partial", "--assessments", "labels.json"],
    ["--assessments", "labels.json", "--partial", "in.json", "out.md"],
  ])
    expect(argumentsFor(args)).toEqual({
      input: "in.json",
      output: "out.md",
      partial: true,
      assessments: "labels.json",
    })
  for (const args of [
    [],
    ["in.json"],
    ["in.json", "out.md", "--unknown"],
    ["in.json", "out.md", "--assessments"],
    ["in.json", "out.md", "--assessments", "--partial"],
    ["in.json", "out.md", "--partial", "--partial"],
    ["in.json", "out.md", "--assessments", "a", "--assessments", "b"],
  ])
    expect(() => argumentsFor(args)).toThrow()
})

test("actual report CLI reads an assessment file and writes its auditable report without model calls", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "forge-assessment-"))
  try {
    const input = path.join(root, "results.json")
    const labels = path.join(root, "assessments.json")
    const output = path.join(root, "report.md")
    await Promise.all([Bun.write(input, JSON.stringify(triple)), Bun.write(labels, JSON.stringify(assessments))])
    const child = Bun.spawn(
      [
        process.execPath,
        path.resolve(import.meta.dir, "../report.ts"),
        input,
        output,
        "--partial",
        "--assessments",
        labels,
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(stderr).toBe("")
    expect(code).toBe(0)
    expect(JSON.parse(stdout).at(0).assessment.retrieval.precision).toBe(1)
    expect(await Bun.file(output).text()).toContain("human-reviewer")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
