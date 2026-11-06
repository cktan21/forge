import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtemp, mkdir, writeFile, rm, symlink, chmod } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { scan, fresh } from "../src/catalog"
import { config } from "../src/config"
import { store } from "../src/store"
import type { Opportunity } from "../src/schema"

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "forge-test-"))
  await mkdir(path.join(root, "src"))
  await mkdir(path.join(root, "tests"))
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "queue", dependencies: { redis: "^4.0.0" }, scripts: { test: "bun test" } }))
  await writeFile(path.join(root, "package-lock.json"), JSON.stringify({ packages: { "node_modules/redis": { version: "4.7.0" } } }))
  await writeFile(path.join(root, "src/queue.ts"), 'import { createClient } from "redis"\nexport function next() { return 1 }\nexport const poll = () => next()\n')
  await writeFile(path.join(root, "tests/queue.test.ts"), 'import { next } from "../src/queue"\ntest("assign patient once", () => next())\n')
  await writeFile(path.join(root, "README.md"), '# Queue\nThe queue assigns patients once. See [implementation](src/queue.ts).\n')
  await writeFile(path.join(root, ".env"), "SECRET=do-not-index")
  await writeFile(path.join(root, ".gitignore"), "ignored.ts\n")
  await writeFile(path.join(root, "ignored.ts"), "export const privateCode = 1")
  await symlink(path.join(root, ".env"), path.join(root, "linked.ts"))
  const db = new Database(":memory:")
  const catalog = store({
    all: async (query) => db.query<Record<string, unknown>, (string | number | null)[]>(query.text).all(...query.values ?? []),
    batch: async (queries) => { db.transaction(() => { for (const query of queries) db.query(query.text).run(...query.values ?? []) })() },
  })
  return { root, catalog, db, close: async () => { db.close(); await rm(root, { recursive: true, force: true }) } }
}

describe("repository understanding", () => {
  test("extracts actual short symbols, imports, tests, docs and lockfile versions", async () => {
    const fixture = await setup()
    try {
      const snapshot = await scan({ root: fixture.root, cfg: await config(fixture.root) })
      expect(snapshot.sources.some((item) => item.kind === "symbol" && item.label === "next")).toBe(true)
      expect(snapshot.sources.some((item) => item.kind === "symbol" && item.label === "poll")).toBe(true)
      expect(snapshot.sources.some((item) => item.kind === "test" && item.label === "assign patient once")).toBe(true)
      expect(snapshot.relations.some((item) => item.kind === "test-imports")).toBe(true)
      expect(snapshot.relations.some((item) => item.kind === "document-links-to")).toBe(true)
      expect(snapshot.sources.find((item) => item.kind === "dependency")?.detail.resolved).toBe("4.7.0")
      expect(snapshot.sources.some((item) => /\.env|linked.ts|ignored.ts/.test(item.uri))).toBe(false)
      await fixture.catalog.replace(snapshot)
      const matches = await fixture.catalog.search(snapshot.root, "patient")
      expect(matches.some((match) => match.source.uri === "README.md")).toBe(true)
      expect(await fixture.catalog.search("another-worktree", "patient")).toEqual([])
    } finally { await fixture.close() }
  })

  test("reuses unchanged observations, detects stale evidence, and removes deleted sources", async () => {
    const fixture = await setup()
    try {
      const cfg = await config(fixture.root)
      const before = await scan({ root: fixture.root, cfg })
      await fixture.catalog.replace(before)
      const unchanged = await scan({ root: fixture.root, cfg, previous: before })
      expect(unchanged.generation).toBe(before.generation)
      const code = before.sources.find((item) => item.uri === "src/queue.ts" && item.method === "file")!
      expect(await fresh(fixture.root, code)).toBe(true)
      await writeFile(path.join(fixture.root, "src/queue.ts"), 'export function atomic() { return "changed" }')
      expect(await fresh(fixture.root, code)).toBe(false)
      await rm(path.join(fixture.root, "tests/queue.test.ts"))
      const after = await scan({ root: fixture.root, cfg, previous: before })
      await fixture.catalog.replace(after, before)
      expect(after.generation).not.toBe(before.generation)
      expect(after.sources.some((item) => item.label === "atomic")).toBe(true)
      expect(after.sources.some((item) => item.uri === "tests/queue.test.ts")).toBe(false)
      expect((await fixture.catalog.search(after.root, "assign")).some((match) => match.source.uri === "tests/queue.test.ts")).toBe(false)
    } finally { await fixture.close() }
  })

  test("parses Python imports and declared SQL schemas without executing project modules", async () => {
    const fixture = await setup()
    try {
      await writeFile(path.join(fixture.root, "src/worker.py"), 'from .queue import next\nclass Worker:\n    def serve(self):\n        return next()\n')
      await writeFile(path.join(fixture.root, "src/queue.py"), 'def next():\n    return 1\n')
      await writeFile(path.join(fixture.root, "schema.sql"), "CREATE TABLE patient (id INTEGER PRIMARY KEY, name TEXT);\n")
      const snapshot = await scan({ root: fixture.root, cfg: await config(fixture.root) })
      expect(snapshot.sources.some((item) => item.label === "Worker")).toBe(true)
      expect(snapshot.sources.some((item) => item.label === "patient" && item.method === "declared-sql-schema")).toBe(true)
      const file = snapshot.sources.find((item) => item.uri === "src/worker.py" && item.method === "file")!
      expect(snapshot.relations.some((item) => item.from === file.id && item.kind === "imports")).toBe(true)
    } finally { await fixture.close() }
  })

  test("retains unavailable evidence under limits and restores it on recovery", async () => {
    const fixture = await setup()
    try {
      const cfg = await config(fixture.root)
      const before = await scan({ root: fixture.root, cfg })
      await fixture.catalog.replace(before)
      await rm(path.join(fixture.root, "README.md"))
      const limited = await scan({ root: fixture.root, cfg: { ...cfg, files: 1 }, previous: before })
      expect(limited.partial).toBe(true)
      expect(limited.sources.some((item) => item.uri === "README.md")).toBe(false)
      expect(limited.sources.filter((item) => item.uri === "src/queue.ts").every((item) => item.status === "unavailable")).toBe(true)
      expect(limited.sources.find((item) => item.label === "next")?.status).toBe("unavailable")
      await fixture.catalog.replace(limited)
      expect(await fixture.catalog.search(limited.root, "next")).toEqual([])
      expect(await fresh(fixture.root, limited.sources.find((item) => item.label === "next")!)).toBe(false)
      const oversized = await scan({ root: fixture.root, cfg: { ...cfg, bytes: 10 }, previous: limited })
      expect(oversized.sources.find((item) => item.label === "next")?.status).toBe("unavailable")
      await fixture.catalog.replace(oversized)
      const recovered = await scan({ root: fixture.root, cfg, previous: oversized })
      await fixture.catalog.replace(recovered)
      expect(recovered.partial).toBe(false)
      expect(recovered.sources.every((item) => item.status === "current")).toBe(true)
      expect((await fixture.catalog.search(recovered.root, "next")).length).toBeGreaterThan(0)
      expect((await scan({ root: fixture.root, cfg, previous: recovered })).generation).toBe(recovered.generation)
      expect((await scan({ root: fixture.root, cfg, previous: await fixture.catalog.snapshot(recovered.root) })).generation).toBe(recovered.generation)
    } finally { await fixture.close() }
  })

  test("fails closed on unknown root and nested ignore policies and recovers", async () => {
    const fixture = await setup()
    try {
      const cfg = await config(fixture.root)
      const before = await scan({ root: fixture.root, cfg })
      await fixture.catalog.replace(before)
      await mkdir(path.join(fixture.root, "src/.kilocodeignore"))
      const nested = await scan({ root: fixture.root, cfg, previous: before })
      expect(nested.partial).toBe(true)
      expect(nested.sources.find((item) => item.label === "next")?.status).toBe("unavailable")
      expect(nested.sources.find((item) => item.uri === "README.md")?.status).toBe("current")
      await fixture.catalog.replace(nested)
      expect((await fixture.catalog.search(nested.root, "next")).some((item) => item.source.uri === "src/queue.ts")).toBe(false)
      await mkdir(path.join(fixture.root, ".kilocodeignore"))
      const unknown = await scan({ root: fixture.root, cfg, previous: nested })
      expect(unknown.sources.filter((item) => item.kind !== "directory").every((item) => item.status === "unavailable")).toBe(true)
      expect(unknown.warnings.some((item) => item.includes("ignore policy unavailable"))).toBe(true)
      await fixture.catalog.replace(unknown)
      expect(await fixture.catalog.search(unknown.root, "patient redis next")).toEqual([])
      const initial = await scan({ root: fixture.root, cfg })
      expect(initial.partial).toBe(true)
      expect(initial.sources.some((item) => item.method === "file")).toBe(false)
      await rm(path.join(fixture.root, ".kilocodeignore"), { recursive: true })
      await rm(path.join(fixture.root, "src/.kilocodeignore"), { recursive: true })
      const recovered = await scan({ root: fixture.root, cfg, previous: unknown })
      expect(recovered.generation).toBe(before.generation)
      await fixture.catalog.replace(recovered)
      expect((await fixture.catalog.search(recovered.root, "next")).length).toBeGreaterThan(0)
    } finally { await fixture.close() }
  })

  for (const dir of ["", "src"]) for (const name of [".gitignore", ".kilocodeignore"]) {
    test(`dangling ${dir || "root"}/${name} fails closed and recovers`, async () => {
      const fixture = await setup()
      try {
        const cfg = await config(fixture.root)
        const before = await scan({ root: fixture.root, cfg })
        const policy = path.join(fixture.root, dir, name)
        const target = path.join(fixture.root, dir, ".policy")
        const excluded = dir ? "src/excluded.ts" : "excluded.ts"
        await writeFile(path.join(fixture.root, excluded), "export const excluded = 'private'")
        await rm(policy, { force: true })
        await writeFile(target, "excluded.ts\nignored.ts\n")
        await symlink(target, policy)
        const healthy = await scan({ root: fixture.root, cfg, previous: before })
        expect(healthy.sources.some((item) => item.uri === excluded)).toBe(false)
        await rm(target)
        const dangling = await scan({ root: fixture.root, cfg, previous: healthy })
        expect(dangling.partial).toBe(true)
        expect(dangling.warnings.some((item) => item.includes("ignore policy unavailable"))).toBe(true)
        expect(dangling.sources.some((item) => item.uri === excluded)).toBe(false)
        expect(dangling.sources.find((item) => item.label === "next")?.status).toBe("unavailable")
        if (dir) expect(dangling.sources.find((item) => item.uri === "README.md")?.status).toBe("current")
        await fixture.catalog.replace(dangling)
        expect((await fixture.catalog.search(dangling.root, "next excluded")).some((item) => item.source.uri.startsWith("src/") || item.source.uri === excluded)).toBe(false)
        const initial = await scan({ root: fixture.root, cfg })
        expect(initial.partial).toBe(true)
        expect(initial.sources.some((item) => item.uri === excluded)).toBe(false)
        await writeFile(target, "excluded.ts\nignored.ts\n")
        const recovered = await scan({ root: fixture.root, cfg, previous: dangling })
        expect(recovered.generation).toBe(healthy.generation)
        await fixture.catalog.replace(recovered)
        expect((await fixture.catalog.search(recovered.root, "next")).length).toBeGreaterThan(0)
        await rm(policy)
        const absent = await scan({ root: fixture.root, cfg, previous: recovered })
        expect(absent.partial).toBe(false)
        expect(absent.sources.find((item) => item.uri === excluded)?.status).toBe("current")
      } finally { await fixture.close() }
    })
  }

  test.skipIf(process.getuid?.() === 0)("retains unreadable files and directories without exposing them in search", async () => {
    const fixture = await setup()
    try {
      const cfg = await config(fixture.root)
      const before = await scan({ root: fixture.root, cfg })
      await fixture.catalog.replace(before)
      await chmod(path.join(fixture.root, "src/queue.ts"), 0)
      const unreadable = await scan({ root: fixture.root, cfg, previous: before })
      expect(unreadable.sources.find((item) => item.label === "next")?.status).toBe("unavailable")
      await fixture.catalog.replace(unreadable)
      expect((await fixture.catalog.search(unreadable.root, "next")).some((item) => item.source.uri === "src/queue.ts")).toBe(false)
      await chmod(path.join(fixture.root, "src/queue.ts"), 0o600)
      await chmod(path.join(fixture.root, "src"), 0o100)
      const inaccessible = await scan({ root: fixture.root, cfg, previous: unreadable })
      expect(inaccessible.partial).toBe(true)
      expect(inaccessible.sources.find((item) => item.label === "next")?.status).toBe("unavailable")
      await chmod(path.join(fixture.root, "src"), 0o700)
      const recovered = await scan({ root: fixture.root, cfg, previous: inaccessible })
      expect(recovered.generation).toBe(before.generation)
    } finally {
      await chmod(path.join(fixture.root, "src"), 0o700)
      await chmod(path.join(fixture.root, "src/queue.ts"), 0o600)
      await fixture.close()
    }
  })

  test("preserves SQL columns and fingerprints extracted relationships", async () => {
    const fixture = await setup()
    try {
      await writeFile(path.join(fixture.root, "schema.sql"), "CREATE TABLE patient (id INTEGER PRIMARY KEY, name TEXT);\n")
      const cfg = await config(fixture.root)
      const before = await scan({ root: fixture.root, cfg })
      const after = await scan({ root: fixture.root, cfg, previous: before })
      expect(after.relations.filter((item) => item.kind === "declares-column").length).toBe(2)
      expect(after.relations).toEqual(before.relations)
      expect(after.generation).toBe(before.generation)
      const altered = await scan({ root: fixture.root, cfg, previous: { ...before, relations: before.relations.filter((item) => item.kind !== "declares-column") } })
      expect(altered.sources.map((item) => ({ ...item, observed: 0 }))).toEqual(after.sources.map((item) => ({ ...item, observed: 0 })))
      expect(altered.relations).toEqual(after.relations)
      expect(altered.generation).toBe(after.generation)
    } finally { await fixture.close() }
  })

  test("refreshes reused dependency metadata when lockfiles change or stop being observed", async () => {
    const fixture = await setup()
    try {
      const cfg = await config(fixture.root)
      const before = await scan({ root: fixture.root, cfg })
      const lock = before.sources.find((item) => item.uri === "package-lock.json" && item.method === "file")!
      await writeFile(path.join(fixture.root, "package-lock.json"), JSON.stringify({ packages: { "node_modules/redis": { version: "5.0.0" } } }))
      const updated = await scan({ root: fixture.root, cfg, previous: before })
      expect(updated.sources.find((item) => item.kind === "dependency")?.detail.resolved).toBe("5.0.0")
      expect(before.sources.find((item) => item.kind === "dependency")?.detail.resolved).toBe("4.7.0")
      await writeFile(path.join(fixture.root, "package-lock.json"), " ".repeat(500) + JSON.stringify({ packages: { "node_modules/redis": { version: "6.0.0" } } }))
      const limited = await scan({ root: fixture.root, cfg: { ...cfg, bytes: 300 }, previous: updated })
      const unresolved = limited.sources.find((item) => item.kind === "dependency")!
      expect(unresolved.status).toBe("current")
      expect(unresolved.detail.resolved).toBe("unknown")
      expect(unresolved.detail.lockfile).toBeUndefined()
      expect(unresolved.evidence).not.toContain(lock.id)
      for (const mode of ["excluded", "oversized", "malformed", "removed"]) {
        if (mode === "malformed") await writeFile(path.join(fixture.root, "package-lock.json"), '{"packages":')
        if (mode === "removed") await rm(path.join(fixture.root, "package-lock.json"))
        const after = await scan({ root: fixture.root, cfg: { ...cfg, exclude: mode === "excluded" ? ["package-lock.json"] : [], bytes: mode === "oversized" ? 30 : cfg.bytes }, previous: updated })
        const dep = after.sources.find((item) => item.kind === "dependency")!
        if (mode === "oversized") {
          expect(dep.status).toBe("unavailable")
          continue
        }
        expect(dep.detail.resolved).toBe("unknown")
        expect(dep.detail.lockfile).toBeUndefined()
        expect(dep.detail.versionStatus).toBeUndefined()
        expect(dep.evidence).not.toContain(lock.id)
      }
      await writeFile(path.join(fixture.root, "package-lock.json"), JSON.stringify({ packages: {} }))
      const absent = await scan({ root: fixture.root, cfg, previous: updated })
      expect(absent.sources.find((item) => item.kind === "dependency")?.detail.resolved).toBe("unknown")
    } finally { await fixture.close() }
  })

  test("replaces persisted SQLite state without previous and isolates actual workspaces", async () => {
    const fixture = await setup()
    const other = await setup()
    try {
      const cfg = await config(fixture.root)
      const before = await scan({ root: fixture.root, cfg })
      const independent = await scan({ root: other.root, cfg: await config(other.root) })
      await fixture.catalog.replace(before)
      await fixture.catalog.replace(independent)
      fixture.db.query("INSERT INTO forge_search(workspace,id,path,content) VALUES(?,?,?,?)").run(before.root, "orphan", "orphan.ts", "orphan")
      const after = await scan({ root: fixture.root, cfg: { ...cfg, exclude: ["tests/", "src/"] }, previous: before })
      await fixture.catalog.replace(after)
      expect(after.sources.some((item) => item.uri === "src/queue.ts")).toBe(false)
      expect((await fixture.catalog.search(after.root, "next")).some((item) => item.source.uri === "src/queue.ts")).toBe(false)
      expect((await fixture.catalog.search(independent.root, "next")).some((item) => item.source.uri === "src/queue.ts")).toBe(true)
      expect(await fixture.catalog.snapshot(independent.root)).toEqual(independent)
      expect(fixture.db.query("SELECT id FROM forge_search WHERE workspace = ? AND id NOT IN (SELECT id FROM forge_sources WHERE workspace = ?)").all(after.root, after.root)).toEqual([])
      const missing = before.sources.find((item) => item.label === "next")!
      expect(fixture.db.query("SELECT id FROM forge_search WHERE workspace = ? AND id = ?").all(after.root, missing.id)).toEqual([])
      await fixture.catalog.replace(before)
      expect((await fixture.catalog.search(before.root, "next")).some((item) => item.source.id === missing.id)).toBe(true)
      const foreign = await scan({ root: other.root, cfg: { ...cfg, files: 1 }, previous: before })
      expect(foreign.sources.some((item) => item.label === "next")).toBe(false)
    } finally { await fixture.close(); await other.close() }
  })

  test("rolls back a failed SQLite replacement and recovers without losing search state", async () => {
    const fixture = await setup()
    try {
      const cfg = await config(fixture.root)
      const before = await scan({ root: fixture.root, cfg })
      await fixture.catalog.replace(before)
      await writeFile(path.join(fixture.root, "src/queue.ts"), "export function replacement() { return 2 }")
      const after = await scan({ root: fixture.root, cfg, previous: before })
      fixture.db.exec("CREATE TRIGGER fail_replace BEFORE INSERT ON forge_sources BEGIN SELECT RAISE(ABORT, 'replacement failed'); END")
      expect(await fixture.catalog.replace(after).then(() => "unexpected success", (err: Error) => err.message)).toContain("replacement failed")
      expect(await fixture.catalog.snapshot(before.root)).toEqual(before)
      expect((await fixture.catalog.search(before.root, "next")).some((item) => item.source.label === "next")).toBe(true)
      fixture.db.exec("DROP TRIGGER fail_replace")
      await fixture.catalog.replace(after)
      expect(await fixture.catalog.snapshot(after.root)).toEqual(after)
      expect((await fixture.catalog.search(after.root, "replacement")).some((item) => item.source.label === "replacement")).toBe(true)
    } finally { await fixture.close() }
  })

  test("invalidates every opportunity for counterevidence and metadata changes", async () => {
    const fixture = await setup()
    try {
      const cfg = await config(fixture.root)
      const before = await scan({ root: fixture.root, cfg })
      await fixture.catalog.replace(before)
      const dep = before.sources.find((item) => item.kind === "dependency")!
      const code = before.sources.find((item) => item.label === "next")!
      for (let index = 0; index < 105; index++) {
        const item: Opportunity = { id: String(index), title: "Upgrade", goal: "Keep current", benefit: "Compatibility", evidence: [code.id], counterevidence: [dep.id], uncertainty: "", verification: "Run tests", prompt: "Upgrade", status: index === 0 ? "rejected" : index === 1 ? "superseded" : "proposed", generation: before.generation, observed: index }
        await fixture.catalog.opportunity(before.root, item)
      }
      const unchanged = await scan({ root: fixture.root, cfg, previous: before })
      await fixture.catalog.replace(unchanged)
      expect(fixture.db.query("SELECT COUNT(*) AS count FROM forge_records WHERE kind = 'opportunity' AND json_extract(body, '$.status') = 'stale'").get()).toEqual({ count: 0 })
      await fixture.catalog.opportunity(before.root, { ...(await fixture.catalog.opportunities(before.root)).at(0)!, id: "race", status: "proposed" })
      fixture.db.exec("CREATE TRIGGER reject_during_replace AFTER INSERT ON forge_sources BEGIN UPDATE forge_records SET body = json_set(body, '$.status', 'rejected') WHERE kind = 'opportunity' AND id = 'race'; END")
      await writeFile(path.join(fixture.root, "package-lock.json"), JSON.stringify({ packages: { "node_modules/redis": { version: "5.0.0" } } }))
      const after = await scan({ root: fixture.root, cfg, previous: unchanged })
      expect(after.sources.find((item) => item.id === dep.id)?.hash).toBe(dep.hash)
      await fixture.catalog.replace(after)
      expect(fixture.db.query("SELECT COUNT(*) AS count FROM forge_records WHERE kind = 'opportunity' AND json_extract(body, '$.status') = 'stale'").get()).toEqual({ count: 103 })
      expect(fixture.db.query("SELECT json_extract(body, '$.status') AS status FROM forge_records WHERE kind = 'opportunity' AND id = '0'").get()).toEqual({ status: "rejected" })
      expect(fixture.db.query("SELECT json_extract(body, '$.status') AS status FROM forge_records WHERE kind = 'opportunity' AND id = '1'").get()).toEqual({ status: "superseded" })
      expect(fixture.db.query("SELECT json_extract(body, '$.status') AS status FROM forge_records WHERE kind = 'opportunity' AND id = 'race'").get()).toEqual({ status: "rejected" })
    } finally { await fixture.close() }
  })
})
