import { Database } from "bun:sqlite"
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir, cpus } from "node:os"
import path from "node:path"
import { engine } from "../src/engine"
import { store } from "../src/store"
import { fixtures } from "./fixtures"
import { coverage } from "./metrics"
import { hash } from "../src/util"
import { knowledge } from "../src/knowledge"
import type { Source } from "../src/schema"

function location(source: Source) {
  return source.detail.collection
    ? `${source.detail.document}#${source.detail.page ? `page:${source.detail.page}` : source.detail.heading || "text"}`
    : source.uri
}

export type Fixture = {
  name: string
  files: Record<string, string | undefined>
  documents?: Record<string, string>
  tasks: Array<{ id: string; query: string; required: string[]; supporting: string[] }>
}

// Labels and queries stay outside scanned inputs. These are development cases,
// not independently adjudicated held-out tasks or executable coding outcomes.
export async function benchmark(corpus: readonly Fixture[] = fixtures, opts: { trials?: number; budgets?: number[] } = {}) {
  const trials = opts.trials ?? 2
  const budgets = opts.budgets ?? [600, 2400]
  if (!Number.isInteger(trials) || trials < 1 || trials > 10) throw new Error("Expected 1-10 trials")
  if (!budgets.length || budgets.some((value) => !Number.isInteger(value) || value < 1 || value > 10_000)) throw new Error("Expected budgets from 1 to 10000")
  const rows: Array<ReturnType<typeof coverage> & {
    fixture: string; task: string; routing: string; trial: number; indexing: number
    importing: number; budget: number; coldStatus: number; statusP95: number | undefined; elapsed: number; tokens: number
    routed: number; citations: Array<{ id: string; hash: string; document: string; page?: string; heading?: string }>
  }> = []
  for (const fixture of corpus) {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "forge-routing-")))
    try {
      for (const [file, text] of Object.entries(fixture.files)) {
        if (text == null) continue
        await mkdir(path.dirname(path.join(root, file)), { recursive: true })
        await Bun.write(path.join(root, file), text)
      }
      await mkdir(path.join(root, ".kilo"), { recursive: true })
      for (let trial = 0; trial < trials; trial++) for (const budget of budgets) for (const routing of trial % 2 ? ["domains", "flat"] : ["flat", "domains"]) {
        // Same root/content identities, fresh database and engine for each arm.
        await Bun.write(path.join(root, ".kilo/forge.jsonc"), JSON.stringify({ routing, budget, exclude: [".kilo/forge.jsonc"] }))
        const db = new Database(":memory:")
        const storage = store({
          all: async (query) => db.query<Record<string, unknown>, (string | number | null)[]>(query.text).all(...query.values ?? []),
          batch: async (queries) => { db.transaction(() => { for (const query of queries) db.query(query.text).run(...query.values ?? []) })() },
        })
        const library = knowledge(root, storage)
        const api = engine({ root, store: storage, provider: async () => "benchmark", complete: async () => { throw new Error("This benchmark must not call models") } })
        try {
          await storage.ready
          const opened = performance.now()
          await api.status()
          const coldStatus = performance.now() - opened
          const started = performance.now()
          for (const [name, text] of Object.entries(fixture.documents ?? {})) {
            const item = await api.register({ kind: "upload", label: name, location: name, content: Buffer.from(text).toString("base64") })
            await api.approve(item.id, "", ["benchmark"])
            const result = await library.index(item.id)
            if (result.state !== "ready" || result.warnings.length) throw new Error(`Incomplete import: ${name}`)
          }
          const importing = performance.now() - started
          const indexed = performance.now()
          const snapshot = await api.refresh()
          if (snapshot.partial || snapshot.warnings.length) throw new Error("Incomplete repository fixture")
          const indexing = performance.now() - indexed
          const available = new Set([...snapshot.sources, ...await storage.knowledge(root)].map(location))
          for (const task of fixture.tasks) for (const label of [...task.required, ...task.supporting]) {
            if (!available.has(label)) throw new Error(`Missing indexed evidence label: ${label}`)
          }
          const status: number[] = []
          for (let index = 0; index < 30; index++) {
            const started = performance.now()
            await api.status()
            status.push(performance.now() - started)
          }
          status.sort((a, b) => a - b)
          for (const task of fixture.tasks) {
            const started = performance.now()
            const selected = await api.retrieve(task.query)
            const elapsed = performance.now() - started
            if (selected.tokens > budget) throw new Error("Evidence budget exceeded")
            const passages = selected.matches.filter((item) => item.source.method !== "domain-index")
            const files = passages.map(({ source }) => location(source))
            rows.push({
              fixture: fixture.name, task: task.id, routing, trial, budget, indexing, importing, coldStatus, statusP95: status.at(28), elapsed, tokens: selected.tokens,
              routed: selected.audit?.channels?.find((item) => item.name === "domains")?.candidates ?? 0,
              citations: passages.map(({ source }) => ({ id: source.id, hash: source.hash, document: source.detail.document ?? source.uri, page: source.detail.page, heading: source.detail.heading })),
              ...coverage(files, task.required, task.supporting),
            })
          }
        } finally { await Promise.all([api.dispose(), library.dispose()]); db.close() }
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
  return {
    scope: "Synthetic development-fixture ablation of actual repository and registered-document retrieval. No held-out or coding-quality claim.",
    fixture: hash(JSON.stringify(corpus)), runtime: Bun.version, hardware: cpus().at(0)?.model, modelCalls: 0, budgets, trials,
    definitions: { files: "Distinct repository paths or document#heading/page labels represented by exact selected passages; presence does not prove sufficient content.", recall: "Required evidence-label coverage", precision: "Selected evidence labels marked required or supporting; not change precision" },
    caveats: ["Routing order alternates by trial; machine/parser caches remain shared.", "Same input root and content per paired arm; database/engine state is isolated.", "Domain inventories consume budget but do not count as exact evidence.", "Repeated queries are not independent task outcomes.", "Import/index costs are repeated on task rows; count once per fixture/trial/budget/arm.", "Document sampling is bounded and is not exhaustive semantic retrieval."],
    summary: budgets.flatMap((budget) => ["flat", "domains"].map((routing) => {
      const selected = rows.filter((row) => row.routing === routing && row.budget === budget)
      return { routing, budget, runs: selected.length, recall: selected.reduce((sum, row) => sum + row.recall, 0) / selected.length, precision: selected.reduce((sum, row) => sum + row.precision, 0) / selected.length, complete: selected.filter((row) => row.complete).length / selected.length, tokens: selected.reduce((sum, row) => sum + row.tokens, 0) / selected.length }
    })),
    rows,
  }
}

if (import.meta.main) console.log(JSON.stringify(await benchmark(), null, 2))
