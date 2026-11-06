import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { engine } from "../src/engine"
import { knowledge } from "../src/knowledge"
import { store } from "../src/store"
import type { Source } from "../src/schema"

test("general browsing validates a document once per page without losing search snippets", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "forge-browse-group-")))
  const db = new Database(":memory:")
  let reads = 0
  let permissions = 0
  const storage = store({
    all: async (query) => {
      if (query.text.startsWith("SELECT body FROM forge_sources") && query.text.includes("$.detail.document")) reads++
      return db.query<Record<string, unknown>, (string | number | null)[]>(query.text).all(...query.values ?? [])
    },
    batch: async (queries) => { db.transaction(() => { for (const query of queries) db.query(query.text).run(...query.values ?? []) })() },
  })
  const library = knowledge(root, storage)
  const api = engine({
    root, store: storage, authorize: async () => { permissions++ },
    provider: async () => { throw new Error("No provider lookup during browsing") },
    complete: async () => { throw new Error("No inference during browsing") },
  })
  try {
    const item = await library.register({
      kind: "text", label: "Large manual", location: "",
      content: Array.from({ length: 145 }, (_, index) => `# Section ${index}\n${"Original passage. ".repeat(40)} needle${index}`).join("\n"),
    })
    await library.approve(item.id)
    await library.index(item.id)
    const expected = await storage.view(root, { limit: 120 })
    const before = reads
    const page = await api.view({ limit: 120 })
    expect(page.sources).toEqual(expected.sources)
    expect(page.sources).toHaveLength(120)
    expect(page.page).toEqual(expected.page)
    expect(reads - before).toBe(2)
    expect(permissions).toBe(1)
    const original = await storage.view(root, { query: "needle144" })
    const searched = await api.view({ query: "needle144" })
    expect(searched.sources).toEqual(original.sources)
    expect(searched.sources.some((source) => source.text.includes("needle144"))).toBe(true)
    expect(searched.sources.every((source) => source.text.length <= 500)).toBe(true)
    expect((await api.status()).job.state).toBe("idle")
  } finally {
    await api.dispose()
    await library.dispose()
    db.close()
    await rm(root, { recursive: true, force: true })
  }
})

for (const kind of ["file", "text", "upload"] as const) {
  for (const fault of ["unchanged", "text", "parent", "missing", "denied", "paused", "permission-mutation", ...(kind === "file" ? ["bytes"] as const : [])] as const) {
    test(`general source browsing ${kind}/${fault} validates registered excerpts`, async () => {
      const root = await realpath(await mkdtemp(path.join(tmpdir(), "forge-browse-integrity-")))
      const db = new Database(path.join(root, "catalog.sqlite"))
      const storage = store({
        all: async (query) => db.query<Record<string, unknown>, (string | number | null)[]>(query.text).all(...query.values ?? []),
        batch: async (queries) => { db.transaction(() => { for (const query of queries) db.query(query.text).run(...query.values ?? []) })() },
      })
      const library = knowledge(root, storage)
      const calls: string[] = []
      const warnings: string[] = []
      let target = ""
      let mutation: (() => Promise<void>) | undefined
      const api = engine({
        root, store: storage,
        warn: (text) => { warnings.push(text) },
        authorize: async (item, session, providers) => {
          expect(session).toBe("private")
          expect(providers).toEqual([])
          calls.push(item.id)
          if (item.id !== target) return
          if (fault === "denied") throw new Error("Local read denied: private-callback-detail")
          if (mutation) { const apply = mutation; mutation = undefined; await apply() }
        },
        provider: async () => { throw new Error("Browsing must not resolve a provider") },
        complete: async () => { throw new Error("Browsing must not call a model") },
      })
      try {
        const text = "# Journal\nRestore the journal before replay.\n# Checksum\nVerify the checkpoint checksum."
        const file = path.join(root, "guide.md")
        await Bun.write(file, text)
        const item = await library.register({
          kind, label: "Guide", session: "private",
          location: kind === "file" ? file : kind === "upload" ? "guide.md" : "",
          content: kind === "file" ? undefined : kind === "upload" ? Buffer.from(text).toString("base64") : text,
        })
        target = item.id
        await library.approve(item.id, "private")
        await library.index(item.id, "private")
        const neighbor = await library.register({ kind: "text", label: "Neighbor", session: "private", location: "", content: "# Healthy\nIndependent current original." })
        await library.approve(neighbor.id, "private")
        await library.index(neighbor.id, "private")
        const originals = await storage.knowledge(root, "private", undefined, { collection: item.id, name: "guide.md" })
        const saved = originals.length ? originals : (await storage.knowledge(root, "private")).filter((source) => source.detail.collection === item.id)
        expect(saved).toHaveLength(3)
        const section = saved.find((source) => source.method === "collection-section")!
        const corrupt = async () => {
          const changed = saved.map((source) => source.id === section.id ? { ...source, text: "Corrupted cached excerpt." } : source)
          await storage.publish(root, (await storage.collection(root, item.id))!, changed)
        }
        if (fault === "text") await corrupt()
        if (fault === "permission-mutation") mutation = corrupt
        if (fault === "parent") await storage.publish(root, (await storage.collection(root, item.id))!, saved.map((source) => source.method === "collection-document" ? { ...source, label: "Corrupted cached title." } : source))
        if (fault === "missing") await storage.publish(root, (await storage.collection(root, item.id))!, saved.filter((source) => source.id !== section.id))
        if (fault === "paused") await library.stop(item.id, "private")
        if (fault === "bytes") await Bun.write(file, "# Journal\nUpdated original bytes.")

        const view = await api.view({ session: "private" })
        expect(view.sources.some((source) => source.detail.collection === neighbor.id)).toBe(true)
        const visible = view.sources.filter((source) => source.detail.collection === item.id)
        expect(visible.length).toBeGreaterThan(0)
        expect(visible.some((source) => source.text.length > 0)).toBe(fault === "unchanged")
        if (fault !== "unchanged") for (const source of visible) {
          expect(source).toMatchObject({ status: "unavailable", hash: "", text: "", label: "Unavailable registered source", evidence: [] })
          expect(Object.keys(source.detail).sort()).toEqual(["collection", "session"])
        }
        expect(JSON.stringify(view)).not.toContain("Corrupted cached")
        expect(JSON.stringify(view)).not.toContain("private-callback-detail")
        expect(warnings.join("\n")).not.toContain("private-callback-detail")
        if (fault === "denied") expect(warnings.length).toBeGreaterThan(0)
        expect(view.sources.every((source) => source.text.length <= 500)).toBe(true)
        expect(view.relations.every((edge) => view.sources.some((source) => source.id === edge.from) && view.sources.some((source) => source.id === edge.to))).toBe(true)
        if (fault !== "unchanged") expect(view.warnings.some((warning) => warning.includes("withheld"))).toBe(true)
        expect((await api.status("private")).job.state).toBe("idle")
        expect((await api.view({ session: "other" })).sources).toEqual([])
        const paged: Source[] = []
        let offset = 0
        for (let pages = 0; pages < 10; pages++) {
          const page = await api.view({ session: "private", limit: 1, offset })
          paged.push(...page.sources)
          if (page.page.next == null) break
          expect(page.page.next).toBeGreaterThan(offset)
          offset = page.page.next
        }
        expect(paged.map((source) => source.id)).toEqual(view.sources.map((source) => source.id))
        expect(calls).toContain(neighbor.id)
        if (fault !== "denied") {
          if (fault === "paused") await library.approve(item.id, "private")
          await library.index(item.id, "private")
          const restored = await api.view({ session: "private", query: "journal" })
          expect(restored.sources.some((source) => source.detail.collection === item.id)).toBe(true)
          expect(JSON.stringify(restored)).not.toContain("Corrupted cached")
        }
      } finally {
        await api.dispose()
        await library.dispose()
        db.close()
        await rm(root, { recursive: true, force: true })
      }
    })
  }
}
