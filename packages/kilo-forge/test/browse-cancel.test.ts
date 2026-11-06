import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { setImmediate as immediate } from "node:timers/promises"
import { engine } from "../src/engine"
import { knowledge } from "../src/knowledge"
import { store } from "../src/store"
import { deadline } from "../src/deadline"

type Mode = "page" | "document" | "source"
type Phase = "read" | "originals" | "permission" | "freshness" | "fence"

async function fixture(mode: Mode, phase: Phase) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "forge-browse-cancel-")))
  const db = new Database(":memory:")
  const storage = store({
    all: async (query) => db.query<Record<string, unknown>, (string | number | null)[]>(query.text).all(...query.values ?? []),
    batch: async (queries) => { db.transaction(() => { for (const query of queries) db.query(query.text).run(...query.values ?? []) })() },
  })
  const library = knowledge(root, storage)
  await mkdir(path.join(root, "docs"))
  await Bun.write(path.join(root, "docs/guide.md"), "# Journal\nRestore the journal before replay.\n# Checksum\nVerify the checkpoint checksum.")
  const item = await library.register({ kind: "folder", label: "Manual", location: "./docs" })
  await library.approve(item.id)
  await library.index(item.id)
  const sources = await storage.knowledge(root)
  const parent = sources.find((source) => source.method === "collection-document")!
  const section = sources.find((source) => source.method === "collection-section" && source.detail.heading === "Journal")!
  const entered = Promise.withResolvers<void>()
  const gate = Promise.withResolvers<void>()
  const calls: string[] = []
  const warnings: string[] = []
  let held = false
  let released = false
  async function pause(stage: Phase) {
    calls.push(stage)
    if (!held || stage !== phase) return
    held = false
    entered.resolve()
    try { await gate.promise } finally { released = true }
  }
  const view = storage.view.bind(storage)
  storage.view = async (...args) => { await pause("read"); return view(...args) }
  const source = storage.source.bind(storage)
  storage.source = async (...args) => { await pause("read"); return source(...args) }
  const originals = storage.knowledge.bind(storage)
  storage.knowledge = async (...args) => { await pause("originals"); return originals(...args) }
  const fenced = storage.fenced.bind(storage)
  storage.fenced = async (root, run) => { await pause("fence"); return fenced(root, run) }
  const api = engine({
    root, store: storage,
    authorize: async (item) => { await pause(item.kind === "file" ? "freshness" : "permission") },
    warn: (text) => { warnings.push(text) },
    provider: async () => { throw new Error("Local browsing cannot resolve a provider") },
    complete: async () => { throw new Error("Local browsing cannot call a model") },
  })
  async function read(signal?: AbortSignal) {
    if (mode === "source") return api.symbol(section.id, "", undefined, signal)
    return api.view({ document: mode === "document" ? parent.id : undefined, signal })
  }
  return {
    api, library, storage, root, item, calls, warnings, read, entered, gate,
    arm() { held = true; calls.length = 0 },
    released: () => released,
    async close() {
      gate.resolve()
      await immediate()
      await api.dispose()
      await library.dispose()
      db.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}

for (const mode of ["page", "document", "source"] as const) {
  for (const phase of ["read", "originals", "permission", "freshness", "fence"] as const) {
    for (const action of ["abort", "dispose"] as const) {
      for (const late of ["resolve", "reject"] as const) {
        test(`${mode} ${phase} ${action} discards late ${late} without retaining read ownership`, async () => {
          const f = await fixture(mode, phase)
          const controller = new AbortController()
          const reason = new Error("Cancel local evidence read")
          f.arm()
          const pending = f.read(controller.signal).then((value) => ({ value }), (error: unknown) => ({ error }))
          try {
            await deadline(() => f.entered.promise, undefined, 2000)
            const count = f.calls.length
            if (action === "abort") controller.abort(reason)
            if (action === "dispose") await deadline(() => f.api.dispose(), undefined, 250)
            const result = await deadline(() => pending, undefined, 250)
            expect("value" in result).toBe(false)
            expect("error" in result && result.error).toBeInstanceOf(Error)
            if (action === "abort") expect("error" in result && result.error).toBe(reason)
            if (action === "dispose") expect(String("error" in result && result.error)).toContain("workspace closed")
            expect(f.released()).toBe(false)
            // Read ownership must unwind even while the original callback remains held.
            if (action === "abort") {
              const retry = await deadline(() => f.read(), undefined, 2000)
              expect(JSON.stringify(retry)).toContain("Restore the journal")
            }
            const before = f.calls.length
            if (late === "reject") f.gate.reject(new Error("Late private callback failure"))
            if (late === "resolve") f.gate.resolve()
            await immediate()
            expect(f.released()).toBe(true)
            expect(f.calls.length).toBe(before)
            expect(f.calls.length).toBeGreaterThanOrEqual(count)
            expect(f.warnings).toEqual([])
            expect(await pending).toBe(result)
            await deadline(() => f.api.dispose(), undefined, 250)
          } finally { f.gate.resolve(); await pending; await f.close() }
        })
      }
    }
  }

  test(`${mode} already cancelled and closed reads do not enter storage or permissions`, async () => {
    const f = await fixture(mode, "permission")
    try {
      f.calls.length = 0
      const reason = new Error("Already cancelled")
      const result = await f.read(AbortSignal.abort(reason)).then(() => undefined, (err: unknown) => err)
      expect(result).toBe(reason)
      expect(f.calls).toEqual([])
      await f.api.dispose()
      f.calls.length = 0
      expect(String(await f.read().then(() => undefined, (err: unknown) => err))).toContain("workspace closed")
      expect(f.calls).toEqual([])
    } finally { await f.close() }
  })

  test(`${mode} does not publish evidence across a concurrent purge epoch`, async () => {
    const f = await fixture(mode, "permission")
    f.arm()
    const pending = f.read().then((value) => ({ value }), (error: unknown) => ({ error }))
    try {
      await deadline(() => f.entered.promise, undefined, 2000)
      await f.library.purge(f.item.id)
      f.gate.resolve()
      const result = await deadline(() => pending, undefined, 2000)
      expect("value" in result).toBe(false)
      expect("error" in result && result.error).toBeInstanceOf(Error)
      expect(await f.storage.knowledge(f.root)).toEqual([])
    } finally { f.gate.resolve(); await pending; await f.close() }
  })
}
