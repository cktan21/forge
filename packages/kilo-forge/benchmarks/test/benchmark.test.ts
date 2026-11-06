import { expect, test } from "bun:test"
import { benchmark } from "../run"
import { coverage } from "../metrics"

test("evaluation separates required changes from supporting context and deduplicates excerpts", () => {
  const result = coverage(["code.ts", "code.ts", "README.md", "other.ts"], ["code.ts", "test.ts"], ["README.md"])
  expect(result.recall).toBe(0.5)
  expect(result.complete).toBe(false)
  expect(result.precision).toBe(2 / 3)
  expect(result.supporting).toBe(1)
  expect(result.missing).toEqual(["test.ts"])
  expect(result.unrelated).toEqual(["other.ts"])
  expect(coverage([], ["code.ts"], []).supporting).toBeNull()
  expect(coverage([], ["code.ts"], []).precision).toBe(0)
  expect(() => coverage([], [], [])).toThrow("At least one required")
  expect(() => coverage([], ["code.ts"], ["code.ts"])).toThrow("overlap")
})

test("benchmark runs actual parsing, FTS retrieval and all selectors on isolated repositories", async () => {
  const report = await benchmark({ trials: 2, budgets: [600, 2400] })
  expect(report.reports.map((item) => item.repository)).toEqual(["queue-ts", "inventory-py"])
  expect(report.accounting.modelCalls).toBe(0)
  expect(report.summary).toHaveLength(6)
  for (const repository of report.reports) {
    expect(repository.files).toBe(7)
    expect(repository.sources).toBeGreaterThan(repository.files)
    expect(repository.cold).toBeGreaterThan(0)
    expect(repository.warm).toBeGreaterThan(0)
    expect(repository.rows).toHaveLength(24)
    for (const row of repository.rows) {
      expect(row.tokens).toBeLessThanOrEqual(row.budget)
      expect(row.recall).toBeLessThanOrEqual(row.candidateRecall)
      expect(
        row.files.some((file) => file.includes("benchmark") || file.endsWith("theme.ts") || file.endsWith("colors.py")),
      ).toBe(false)
      const first = repository.rows.find(
        (item) => item.task === row.task && item.method === row.method && item.budget === row.budget,
      )!
      expect(row.files).toEqual(first.files)
      expect(row.tokens).toBe(first.tokens)
    }
  }
  for (const row of report.summary.filter((item) => item.budget === 2400)) {
    expect(row.recall).toBe(1)
    expect(row.complete).toBe(1)
  }
})

test("benchmark rejects unbounded trial counts and invalid budgets", async () => {
  for (const opts of [{ trials: 0 }, { trials: 21 }, { budgets: [Infinity] }, { budgets: [] }]) {
    const err = await benchmark(opts).then(
      () => undefined,
      (err: unknown) => err,
    )
    expect(err).toBeInstanceOf(Error)
    expect(err instanceof Error ? err.message : "").toContain("trials" in opts ? "Trials" : "Budgets")
  }
})
