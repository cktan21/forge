import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { chunks, extract } from "../src/extract"
import { engine } from "../src/engine"
import { knowledge } from "../src/knowledge"
import { store } from "../src/store"
import { stamp } from "../src/extraction"
import { binding } from "../src/binding"
import type { Collection } from "../src/schema"

const collection: Collection = {
  id: "markdown", kind: "upload", label: "Reference", location: "guide.md",
  session: "", origin: "interface", include: ["**/*"], exclude: [], watch: false,
  approved: true, providers: [], state: "ready", observed: 1, generation: "fixture",
  files: 1, chunks: 0, warnings: [],
}

function sections(text: string, name = "guide.md") {
  const result = chunks(collection, name, new TextEncoder().encode(text), [{ text }])
    .filter((item) => item.method === "collection-section")
  for (const item of result) {
    expect(item.text).toBe(text.split("\n").slice(item.start - 1, item.end).join("\n").trim())
    expect(item.evidence).toHaveLength(1)
  }
  return result
}

for (const [opening, closing] of [
  ["```sh", "```"], ["~~~~text", "~~~~"], ["````markdown", "`````"],
  ["   ```", "  ```"], ["~~~`example`", "~~~"],
]) {
  test(`Markdown fence ${opening} retains heading-like code in its original section`, () => {
    const body = ["# Operations", "Before.", opening, "# Not a section", "## Still code", closing, "After.", "# Recovery", "Restore."].join("\n")
    const result = sections(body)
    expect(result.map((item) => item.detail.heading)).toEqual(["Operations", "Recovery"])
    expect(result.at(0)?.text).toBe(body.split("\n").slice(0, 7).join("\n"))
    expect(result.at(0)).toMatchObject({ start: 1, end: 7 })
    expect(result.at(1)).toMatchObject({ start: 8, end: 9 })
  })
}

test.each(["``", "~~~", "``` trailing", "    ```"])("invalid fence closer %s does not promote later code to headings", (closing) => {
  const body = ["# Operations", "```md", closing, "# Still code"].join("\n")
  expect(sections(body).map((item) => item.detail.heading)).toEqual(["Operations"])
})

test("an unclosed fence retains all remaining original evidence", () => {
  const body = "# Guide\n~~~\n# Example\n## More code\n" + "bounded original line\n".repeat(400)
  const result = sections(body)
  expect(result.every((item) => item.detail.heading === "Guide")).toBe(true)
  expect(result.map((item) => item.text).join("\n")).toBe(body.trim())
})

test.each(["guide.md", "guide.MDX"])("skipped Markdown levels preserve actual ancestry in %s", (name) => {
  const result = sections("# Root\nA\n### Deep\nB\n### Peer\nC\n## Sibling\nD\n#### Child\nE\n# Next\nF", name)
  expect(result.map((item) => item.detail.heading)).toEqual([
    "Root", "Root / Deep", "Root / Peer", "Root / Sibling", "Root / Sibling / Child", "Next",
  ])
})

test("Markdown ATX indentation, empty titles and closing markers keep exact originals", () => {
  const result = sections("   # Root ###\nBody\n  ## Child #\nBody\n#\nUntitled\n## Next#\nFinal")
  expect(result.map((item) => item.detail.heading)).toEqual(["Root", "Root / Child", "", " / Next#"])
  expect(result.at(0)?.text).toBe("# Root ###\nBody")
  expect(result.at(2)?.text).toBe("#\nUntitled")
})

test("non-headings and invalid backtick openers remain ordinary Markdown evidence", () => {
  const result = sections("# Root\n####### Too deep\n#nospace\n    # Indented code\n```info`invalid\n## Child\nBody")
  expect(result.map((item) => item.detail.heading)).toEqual(["Root", "Root / Child"])
})

test("CRLF Markdown retains source bytes while recognizing headings and fences", () => {
  const body = ["# Root", "```sh", "# Example", "```", "## Child", "Body"].join("\r\n")
  const result = sections(body)
  expect(result.map((item) => item.detail.heading)).toEqual(["Root", "Root / Child"])
  expect(result.at(0)?.text).toBe("# Root\r\n```sh\r\n# Example\r\n```")
  expect(result.at(0)).toMatchObject({ start: 1, end: 4 })
  expect(result.at(1)).toMatchObject({ start: 5, end: 6 })
})

test.each([
  "- Example:\n\n  ```md\n  # Code heading\n  ```",
  "> ```md\n> # Quoted code\n> ```",
  "<pre>\n# HTML code\n</pre>",
  "    # Indented code",
  "<!--\n# Comment\n-->",
])("nested and literal blocks do not create document headings: %s", (block) => {
  const body = `# Guide\n\n${block}\n\n## Next\nOriginal instruction.`
  const result = sections(body)
  expect(result.map((item) => item.detail.heading)).toEqual(["Guide", "Guide / Next"])
  expect(result.at(0)?.text).toContain(block)
  expect(result.at(1)?.text).toBe("## Next\nOriginal instruction.")
})

test("Setext headings and repeated link definitions retain original line positions", () => {
  const body = [
    "[link]: /first", "[link]: /second", "", "Root", "====", "Original.", "",
    "[link]: /third", "", "Child", "-----", "Instruction.", "", "# Next", "Done.",
  ].join("\n")
  const result = sections(body)
  expect(result.map((item) => item.detail.heading)).toEqual(["", "Root", "Root / Child", "Next"])
  expect(result.map((item) => [item.start, item.end])).toEqual([[1, 3], [4, 9], [10, 13], [14, 15]])
  expect(result.map((item) => item.text).join("\n")).toContain("[link]: /third")
})

test("other document formats retain their existing section interpretation", () => {
  const body = "# Root\n```\n# Example\n```\n# End\nBody"
  for (const name of ["guide.txt", "guide.rst", "guide.pdf", "guide.docx", "guide.html"]) {
    const result = sections(body, name)
    expect(result.map((item) => item.detail.heading)).toEqual(["Root", "Example", "End"])
    expect(result.every((item) => item.detail.extractor === "forge-document-v2")).toBe(true)
  }
})

test.each(["guide.md", "guide.txt", "guide.rst", "guide.pdf", "guide.docx", "guide.html"])("size-based %s citations end on the last included line", (name) => {
  const body = Array.from({ length: 300 }, (_, index) => `Original numbered line ${index}: verify checkpoint.`).join("\n")
  const result = sections(body, name)
  expect(result.length).toBeGreaterThan(1)
  expect(result.map((item) => item.text).join("\n")).toBe(body)
  for (const [index, item] of result.entries()) {
    if (index) expect(item.start).toBe(result.at(index - 1)!.end + 1)
  }
})

test("a split long line retains its line number without including the following line", () => {
  const body = "x".repeat(5000) + "\nLast line."
  const result = chunks(collection, "guide.md", new TextEncoder().encode(body), [{ text: body }])
    .filter((item) => item.method === "collection-section")
  expect(result.map((item) => [item.start, item.end])).toEqual([[1, 1], [1, 1], [1, 2]])
  expect(result.map((item) => item.text).join("")).toBe(body)
})

test("explicit refresh upgrades old Markdown layouts, preserves unrelated reuse and rejects changed pins", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "forge-markdown-")))
  const body = "# Operations\nBefore.\n```sh\n# Example\nRestore checkpoint.\n```\nAfter.\n# Recovery\nValidate."
  await Bun.write(path.join(root, "docs/guide.md"), body)
  await Bun.write(path.join(root, "docs/plain.txt"), "Plain unrelated evidence.")
  const db = new Database(path.join(root, "catalog.sqlite"))
  const storage = store({
    all: async (query) => db.query<Record<string, unknown>, (string | number | null)[]>(query.text).all(...query.values ?? []),
    batch: async (queries) => { db.transaction(() => { for (const query of queries) db.query(query.text).run(...query.values ?? []) })() },
  })
  const calls: string[] = []
  const library = knowledge(root, storage, { extract: async (name, ...args) => { calls.push(name); return extract(name, ...args) } })
  const api = engine({ root, store: storage, complete: async () => { throw new Error("No model calls permitted") } })
  try {
    const registered = await library.register({ kind: "folder", label: "Guide", location: "./docs", session: "chat" })
    await library.approve(registered.id, "chat", ["local"])
    const indexed = await library.index(registered.id, "chat")
    const current = await storage.knowledge(root, "chat")
    // Fixed v1 layout: the fenced shell comment became its own section.
    const legacy = chunks(indexed, "guide.md", new TextEncoder().encode(body), [{ text: body }])
    const parent = legacy.find((item) => item.method === "collection-document")!
    const { source } = await import("../src/parse")
    const { id } = await import("../src/util")
    const old = [
      { ...parent, detail: { ...parent.detail, extractor: "forge-document-v1" } },
      ...[
        { start: 1, end: 3, heading: "Operations" },
        { start: 4, end: 7, heading: "Example" },
        { start: 8, end: 9, heading: "Recovery" },
      ].map((part, ordinal) => source(parent.uri, body.split("\n").slice(part.start - 1, part.end).join("\n"), "document", {
        id: id(parent.id, "0", String(part.start), String(ordinal)),
        label: `${registered.label}: ${part.heading}`, start: part.start, end: part.end,
        method: "collection-section", evidence: [parent.id],
        detail: { ...parent.detail, extractor: "forge-document-v1", heading: part.heading },
      })),
    ]
    const digest = await stamp(old)
    const saved = old.map((item) => ({ ...item, detail: { ...item.detail, extraction: digest } }))
    await storage.publish(root, indexed, [...saved, ...current.filter((item) => item.detail.document === "plain.txt")])
    const pinned = saved.find((item) => item.method === "collection-section")!
    await storage.policySave(root, { session: "chat", version: "legacy", pin: [pinned.id], versions: { [pinned.id]: binding(pinned) }, exclude: [] })
    expect(await library.fresh(pinned, "chat", "local")).toBe(false)
    calls.length = 0
    const refreshed = await library.index(registered.id, "chat")
    expect(refreshed.result).toMatchObject({ extracted: 1, reused: 1 })
    expect(calls).toEqual(["guide.md"])
    const repaired = await storage.knowledge(root, "chat")
    expect(repaired.filter((item) => item.detail.document === "guide.md" && item.method === "collection-section").map((item) => item.detail.heading).sort((a, b) => (a ?? "").localeCompare(b ?? ""))).toEqual(["Operations", "Recovery"])
    const rejected = await api.retrieve("Restore checkpoint", { session: "chat", provider: "local" }).then(() => undefined, (err: unknown) => err)
    expect(rejected).toBeInstanceOf(Error)
    expect(rejected instanceof Error && rejected.message).toContain("Pinned excerpt changed")
    await api.configure({ ...await api.policy("chat"), pin: [], versions: {} })
    const found = await api.lookup({ tool: "forge_search_docs", query: "Restore checkpoint", session: "chat", provider: "local" })
    expect(found.result.matches.some((item) => item.source.detail.heading === "Operations" && item.source.text.includes("# Example"))).toBe(true)
    expect((await api.request(found.request, "chat"))?.entries.some((item) => item.text.includes("# Example"))).toBe(true)
    expect(await api.request(found.request, "other")).toBeUndefined()
    expect((await api.retrieve("Restore checkpoint", { session: "chat", provider: "denied" })).matches).toEqual([])
    expect((await library.index(registered.id, "chat")).result).toMatchObject({ extracted: 0, reused: 2 })
    expect(await storage.knowledge(root, "chat")).toEqual(repaired)
    expect(calls).toEqual(["guide.md"])
  } finally {
    await api.dispose()
    await library.dispose()
    db.close()
    await rm(root, { recursive: true, force: true })
  }
})
