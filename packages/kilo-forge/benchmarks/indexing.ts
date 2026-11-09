import { Database } from "bun:sqlite"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { scan } from "../src/catalog"
import { config } from "../src/config"
import { store } from "../src/store"
import type { Snapshot } from "../src/schema"

export async function indexing(count = 5000) {
  if (!Number.isSafeInteger(count) || count < 1 || count > 5000) throw new Error("Indexing fixture requires 1-5000 files")
  const root = await mkdtemp(path.join(tmpdir(), "forge-indexing-"))
  const db = new Database(":memory:")
  try {
    for (let index = 0; index < count; index++) {
      const dir = path.join(root, `group-${Math.floor(index / 100)}`)
      if (index % 100 === 0) await mkdir(dir)
      await writeFile(path.join(dir, `file-${index}.ts`), `export function value${index}() { return ${index} }\n`)
    }
    const cfg = await config(root)
    const storage = store({
      all: async (query) => db.query<Record<string, unknown>, (string | number | null)[]>(query.text).all(...query.values ?? []),
      batch: async (queries) => { db.transaction(() => { for (const query of queries) db.query(query.text).run(...query.values ?? []) })() },
    })
    await storage.ready
    const rows: Array<{ name: string; visited: number; read: number; parsed: number; scanned: number; total: number; rss: number; generation: string }> = []
    async function measure(name: string, previous?: Snapshot, changed?: string[]) {
      const counts = { visited: 0, read: 0, parsed: 0 }
      const started = performance.now()
      const snapshot = await scan({
        root, cfg, previous, changed,
        visited: () => counts.visited++, read: () => counts.read++, parsed: () => counts.parsed++,
      })
      const scanned = performance.now() - started
      await storage.replace(snapshot)
      rows.push({ name, ...counts, scanned, total: performance.now() - started, rss: process.memoryUsage.rss(), generation: snapshot.generation })
      return snapshot
    }
    const cold = await measure("cold")
    const warm = await measure("warm", cold, [])
    if (warm.generation !== cold.generation) throw new Error("Warm inventory changed without a source edit")
    await writeFile(path.join(root, "group-0/file-0.ts"), "export function changed() { return 1 }\n")
    const delta = await measure("delta", warm, ["group-0/file-0.ts"])
    const rebuilt = await measure("reconciled")
    if (delta.generation !== rebuilt.generation) throw new Error("Delta and cold rebuild disagree")
    if ((await storage.search(rebuilt.root, "changed")).length === 0) throw new Error("Changed source is missing from lexical search")
    return { count, runtime: Bun.version, modelCalls: 0, embeddings: false, memory: "Process RSS sampled after each phase, not peak or incremental allocation", milliseconds: true, rows }
  } finally { db.close(); await rm(root, { recursive: true, force: true }) }
}

if (import.meta.main) console.log(JSON.stringify(await indexing(Number(process.argv.at(2) ?? 5000)), null, 2))
