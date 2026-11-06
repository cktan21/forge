import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"
import { engine, type Ports } from "../src/engine"
import { knowledge } from "../src/knowledge"
import { store } from "../src/store"
import { chunks } from "../src/extract"

async function fixture(authorize?: Ports["authorize"]) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "forge-sections-")))
  const db = new Database(":memory:")
  const storage = store({
    all: async (query) => db.query<Record<string, unknown>, (string | number | null)[]>(query.text).all(...query.values ?? []),
    batch: async (queries) => { db.transaction(() => { for (const query of queries) db.query(query.text).run(...query.values ?? []) })() },
  })
  const library = knowledge(root, storage, { authorize })
  const api = engine({ root, store: storage, authorize, provider: async () => "local", complete: async () => { throw new Error("No model calls during section browsing") } })
  return { root, storage, library, api, async [Symbol.asyncDispose]() {
    await api.dispose(); await library.dispose(); db.close(); await rm(root, { recursive: true, force: true })
  } }
}

test("document browsing pages all original sections beyond the brief sample and rejects parent pins", async () => {
  await using f = await fixture()
  const item = await f.library.register({
    kind: "text", label: "Large reference", location: "", session: "private",
    content: Array.from({ length: 145 }, (_, index) => `# Section ${index}\n${"Original passage. ".repeat(40)}`).join("\n"),
  })
  await f.library.approve(item.id, "private", ["local"])
  await f.library.index(item.id, "private")
  const sources = await f.storage.knowledge(f.root, "private")
  const parent = sources.find((source) => source.method === "collection-document")!
  expect(parent.evidence).toHaveLength(24)
  const first = await f.api.view({ document: parent.id, session: "private", limit: 120 })
  expect(first.sources).toHaveLength(120)
  expect(first.sources.at(0)?.detail.heading).toBe("Section 0")
  expect(first.sources.at(-1)?.detail.heading).toBe("Section 119")
  expect(first.sources.every((source) => source.method === "collection-section" && source.text.length <= 500)).toBe(true)
  const last = await f.api.view({ document: parent.id, session: "private", offset: first.page.next, generation: first.generation, limit: 120 })
  expect(last.sources).toHaveLength(25)
  expect(last.sources.at(-1)?.detail.heading).toBe("Section 144")
  expect(last.page.next).toBeUndefined()
  const section = await f.api.symbol(last.sources.at(-1)!.id, "private")
  expect(section.text.length).toBeGreaterThan(500)
  expect(parent.evidence).not.toContain(section.id)
  const policy = await f.api.policy("private")
  const rejected = await f.api.configure({ ...policy, pin: [parent.id] }).then(() => undefined, (err: unknown) => err)
  expect(String(rejected)).toContain("Choose an original section or page")
  expect(await f.api.policy("private")).toEqual(policy)
  expect((await f.api.configure({ ...policy, pin: [section.id] })).pin).toContain(section.id)
  expect((await f.api.retrieve("Original passage", { session: "private" })).matches.some((match) => match.source.id === section.id)).toBe(true)
  const direct = await f.api.retrieve("Original passage", { session: "private", pin: [parent.id] }).then(() => undefined, (err: unknown) => err)
  expect(String(direct)).toContain("Choose an original section or page")
  const denied = await f.api.view({ document: parent.id, session: "other" }).then(() => undefined, (err: unknown) => err)
  expect(String(denied)).toContain("not available")
  expect((await f.storage.view(f.root, { document: parent.id, session: "other" })).sources).toEqual([])
  expect((await f.api.view({ document: parent.id, session: "private", offset: 120, generation: "old" })).page.offset).toBe(0)
})

test("section pages use numeric PDF order and exclude mismatched document versions", async () => {
  await using f = await fixture()
  const item = await f.library.register({ kind: "text", label: "Pages", location: "", content: "bytes" })
  const collection = await f.library.approve(item.id)
  const sources = chunks(collection, "pages.pdf", new TextEncoder().encode("bytes"), [
    { page: 10, text: "Page ten" }, { page: 2, text: "Page two" }, { page: 1, text: "Page one" },
  ])
  const parent = sources.at(0)!
  const foreign = { ...sources.at(-1)!, id: "foreign", detail: { ...sources.at(-1)!.detail, fileHash: "another-version" } }
  await f.storage.publish(f.root, collection, [...sources, foreign])
  const view = await f.storage.view(f.root, { document: parent.id })
  expect(view.sources.map((source) => source.detail.page)).toEqual(["1", "2", "10"])
  expect(view.sources.some((source) => source.id === "foreign")).toBe(false)
  expect((await f.storage.view(f.root, { document: "missing" })).sources).toEqual([])
})

test("section browsing rechecks document freshness and permission after paging", async () => {
  let denied = false
  await using f = await fixture(async () => { if (denied) throw new Error("Document read denied") })
  const file = path.join(f.root, "guide.md")
  await Bun.write(file, "# Guide\nOriginal document.")
  const item = await f.library.register({ kind: "file", label: "Guide", location: file })
  await f.library.approve(item.id)
  await f.library.index(item.id)
  const parent = (await f.storage.knowledge(f.root)).find((source) => source.method === "collection-document")!
  const view = f.storage.view.bind(f.storage)
  f.storage.view = async (...args) => { const result = await view(...args); denied = true; return result }
  const rejected = await f.api.view({ document: parent.id }).then(() => undefined, (err: unknown) => err)
  expect(String(rejected)).toContain("Document read denied")
  f.storage.view = view
  denied = false
  await Bun.write(file, "# Guide\nReplaced document.")
  const stale = await f.api.view({ document: parent.id }).then(() => undefined, (err: unknown) => err)
  expect(String(stale)).toContain("Source changed")
  await f.library.index(item.id)
  expect((await f.api.view({ document: parent.id })).sources.at(0)?.text).toContain("Replaced")
  await f.library.purge(item.id)
  const purged = await f.api.view({ document: parent.id }).then(() => undefined, (err: unknown) => err)
  expect(String(purged)).toContain("Choose an available registered document")
})
