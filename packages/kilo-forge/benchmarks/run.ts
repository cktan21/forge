import { Database } from "bun:sqlite"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { scan } from "../src/catalog"
import { config } from "../src/config"
import { select } from "../src/context"
import { store } from "../src/store"
import { hash } from "../src/util"
import { fixtures } from "./fixtures"
import { coverage } from "./metrics"

const methods = ["ranked", "greedy", "knapsack"] as const

export async function benchmark(opts: { trials?: number; budgets?: readonly number[] } = {}) {
  const trials = opts.trials ?? 3
  const budgets = opts.budgets ?? [600, 2400]
  if (!Number.isInteger(trials) || trials < 1 || trials > 20) throw new Error("Trials must be an integer from 1 to 20")
  if (!budgets.length || budgets.some((value) => !Number.isInteger(value) || value < 1 || value > 10_000)) {
    throw new Error("Budgets must be integers from 1 to 10000")
  }
  const reports = []
  for (const fixture of fixtures) {
    const root = await mkdtemp(path.join(tmpdir(), "forge-benchmark-"))
    const db = new Database(":memory:")
    try {
      // Only repository inputs enter the scanned directory; queries and labels stay in the harness.
      for (const [file, text] of Object.entries(fixture.files)) {
        if (text == null) continue
        await mkdir(path.dirname(path.join(root, file)), { recursive: true })
        await writeFile(path.join(root, file), text)
      }
      const storage = store({
        all: async (query) =>
          db.query<Record<string, unknown>, (string | number | null)[]>(query.text).all(...(query.values ?? [])),
        batch: async (queries) => {
          db.transaction(() => {
            for (const query of queries) db.query(query.text).run(...(query.values ?? []))
          })()
        },
      })
      const cfg = await config(root)
      const started = performance.now()
      await storage.ready
      const snapshot = await scan({ root, cfg })
      await storage.replace(snapshot)
      const cold = performance.now() - started
      const refreshed = performance.now()
      const warm = await scan({ root, cfg, previous: snapshot, changed: [] })
      await storage.replace(warm, snapshot)
      const elapsed = performance.now() - refreshed
      if (warm.generation !== snapshot.generation) throw new Error("Unchanged fixture changed generation")
      if (snapshot.partial || snapshot.warnings.length)
        throw new Error(`Incomplete fixture: ${snapshot.warnings.join("; ")}`)
      const rows = []
      for (const task of fixture.tasks) {
        for (const file of [...task.required, ...task.supporting]) {
          if (!Object.hasOwn(fixture.files, file)) throw new Error(`Unknown evaluation label: ${file}`)
        }
        for (let trial = 1; trial <= trials; trial++) {
          const started = performance.now()
          const candidates = await storage.search(snapshot.root, task.query, cfg.candidates)
          const retrieval = performance.now() - started
          const pool = coverage(
            candidates.map((item) => item.source.uri),
            task.required,
            task.supporting,
          )
          for (const budget of budgets) {
            for (const method of methods) {
              const started = performance.now()
              const selected = select(candidates, budget, method)
              const milliseconds = performance.now() - started
              if (selected.tokens > budget) throw new Error(`${method} exceeded the serialized evidence budget`)
              rows.push({
                task: task.id,
                trial,
                method,
                budget,
                tokens: selected.tokens,
                estimator: selected.estimator,
                candidates: candidates.length,
                candidateRecall: pool.recall,
                retrieval,
                milliseconds,
                ...coverage(
                  selected.matches.map((item) => item.source.uri),
                  task.required,
                  task.supporting,
                ),
              })
            }
          }
        }
      }
      reports.push({
        repository: fixture.name,
        generation: snapshot.generation,
        files: snapshot.files,
        sources: snapshot.sources.length,
        cold,
        warm: elapsed,
        rows,
      })
    } finally {
      db.close()
      await rm(root, { recursive: true, force: true })
    }
  }
  const rows = reports.flatMap((report) => report.rows)
  return {
    version: 1,
    scope: "Synthetic lexical retrieval and context-selection regression benchmark; not a coding-outcome experiment",
    fixture: hash(JSON.stringify(fixtures)),
    runtime: Bun.version,
    trials,
    budgets,
    accounting: {
      clock: "performance.now milliseconds; first fixture may include parser initialization",
      context: "Serialized citation headers, excerpts and separators; conservative UTF-8 byte estimate",
      modelCalls: 0,
      embeddings: false,
      externalDocumentation: false,
    },
    definitions: {
      recall: "Fraction of labeled required-change files represented in selected context",
      complete: "Every required-change file has at least one selected excerpt",
      precision: "Fraction of selected files labeled required or supporting; not predicted-change precision",
      supporting: "Fraction of supporting files selected, or null when none are labeled",
      candidateRecall: "Required-file coverage before context selection",
    },
    summary: budgets.flatMap((budget) =>
      methods.map((method) => {
        const selected = rows.filter((row) => row.method === method && row.budget === budget)
        return {
          method,
          budget,
          runs: selected.length,
          recall: selected.reduce((sum, row) => sum + row.recall, 0) / selected.length,
          precision: selected.reduce((sum, row) => sum + row.precision, 0) / selected.length,
          complete: selected.filter((row) => row.complete).length / selected.length,
          tokens: selected.reduce((sum, row) => sum + row.tokens, 0) / selected.length,
        }
      }),
    ),
    reports,
  }
}

if (import.meta.main) console.log(JSON.stringify(await benchmark(), null, 2))
