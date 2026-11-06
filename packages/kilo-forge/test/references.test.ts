import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { lstat, mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { engine, type Ports } from "../src/engine"
import { store } from "../src/store"
import { knowledge } from "../src/knowledge"
import { category, references } from "../src/references"
import { source } from "../src/parse"
import type { Source } from "../src/schema"

async function fixture(authorize?: Ports["authorize"]) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "forge-references-")))
  const db = new Database(":memory:")
  const storage = store({
    all: async (query) => db.query<Record<string, unknown>, (string | number | null)[]>(query.text).all(...query.values ?? []),
    batch: async (queries) => { db.transaction(() => { for (const query of queries) db.query(query.text).run(...query.values ?? []) })() },
  })
  const api = engine({ root, store: storage, authorize, complete: async () => { throw new Error("Reference browsing must not call a model") } })
  const library = knowledge(root, storage, { authorize })
  return {
    root, storage, api, library,
    async [Symbol.asyncDispose]() { await Promise.all([api.dispose(), library.dispose()]); db.close(); await rm(root, { recursive: true, force: true }) },
  }
}

test("reference defaults stay beneath POSIX and Windows workspace roots", () => {
  expect(references("/workspace")).toBe("/workspace/references")
  expect(references("/workspace/")).toBe("/workspace/references")
  expect(references("C:\\workspace")).toBe("C:\\workspace\\references")
  expect(references("\\\\host\\workspace")).toBe("\\\\host\\workspace\\references")
  expect(references()).toBe("references")
})

test("previewing a missing default directory is read-only; confirmed registration creates it locally", async () => {
  await using f = await fixture()
  const input = { kind: "folder" as const, label: "References", location: "references", watch: true }
  const preview = await f.api.preview(input)
  expect(preview.location).toBe(references(f.root))
  expect(preview.files).toBe(0)
  expect(preview.warnings.join(" ")).toContain("Confirm ADD to create")
  expect(await lstat(references(f.root)).catch(() => undefined)).toBeUndefined()
  expect((await f.api.registry()).collections).toEqual([])
  const item = await f.api.register(input)
  expect((await lstat(references(f.root))).isDirectory()).toBe(true)
  expect(item).toMatchObject({ location: references(f.root), approved: false, providers: [], state: "registered" })
  await Bun.write(path.join(references(f.root), "policy.md"), "# Ownership\nValidate the epoch before dispatch.")
  await f.api.approve(item.id)
  await f.api.index(item.id)
  await f.library.index(item.id)
  const page = await f.api.view({ category: "markdown" })
  expect(page.sources).toHaveLength(1)
  expect(page.sources.at(0)?.method).toBe("collection-document")
  expect(page.categories?.markdown).toBe(1)
  const sections = await f.api.view({ category: "markdown", document: page.sources.at(0)!.id })
  expect(sections.sources.some((source) => source.text.includes("Validate the epoch"))).toBe(true)
  expect((await f.api.registry()).collections.at(0)?.providers).toEqual([])
  await expect(f.api.register({ ...input, location: "missing-custom-directory" })).rejects.toThrow()
})

test("denied references creation does not write a directory or grant approval", async () => {
  await using f = await fixture(async () => { throw new Error("Local reference access denied") })
  const input = { kind: "folder" as const, label: "References", location: "references" }
  await expect(f.api.preview(input)).rejects.toThrow("access denied")
  await expect(f.api.register(input)).rejects.toThrow("access denied")
  expect(await lstat(references(f.root)).catch(() => undefined)).toBeUndefined()
  expect((await f.api.registry()).collections).toEqual([])
})

test("nested workspace directories use the configured project-root references directory", async () => {
  await using f = await fixture()
  const nested = path.join(f.root, "packages", "project")
  await mkdir(nested, { recursive: true })
  const directory = references(f.root)
  const api = engine({ root: nested, references: directory, store: f.storage, complete: async () => { throw new Error("No model call expected") } })
  try {
    expect((await api.status()).references).toBe(directory)
    expect((await api.registry()).references).toBe(directory)
    expect((await api.preview({ kind: "folder", label: "References", location: "./references" })).location).toBe(directory)
    const item = await api.register({ kind: "folder", label: "References", location: "references" })
    expect(item.location).toBe(directory)
    expect(await lstat(references(nested)).catch(() => undefined)).toBeUndefined()
    await Bun.write(path.join(directory, "guide.txt"), "Project-root reference.")
    const file = await api.register({ kind: "file", label: "Guide", location: "references/guide.txt" })
    expect(file.location).toBe(path.join(directory, "guide.txt"))
  } finally { await api.dispose() }
})

test("the default references folder cannot be redirected through a symbolic link", async () => {
  await using f = await fixture()
  const outside = path.join(f.root, "elsewhere")
  await mkdir(outside)
  await symlink(outside, references(f.root))
  await expect(f.api.register({ kind: "folder", label: "References", location: "references" })).rejects.toThrow("real directory")
  expect((await f.api.registry()).collections).toEqual([])
})

test("category filtering precedes paging and agrees with format classification across the full catalog", async () => {
  await using f = await fixture()
  const sources: Source[] = [
    ...Array.from({ length: 30 }, (_, index) => source(`src/code-${index}.ts`, "Code", "code", { method: "file" })),
    ...["guide.PDF", "manual.pdf?download=1", "note.pdf#page=2"].map((name) => source(name, "PDF record", "document", { method: "file" })),
    source("report.DOCX", "Word record", "document", { method: "file" }),
    source("notes.txt?format=.pdf", "Text record", "document", { method: "file" }),
    source("attachment://file", "Markdown record", "document", { detail: { document: "README.MD" } }),
    source("private.pdf", "Private record", "document", { detail: { session: "private" } }),
  ]
  await f.storage.replace({
    root: f.root, generation: "first", revision: "first", observed: 1,
    sources, relations: [], warnings: [], files: sources.length, partial: false,
  })
  const first = await f.storage.view(f.root, { category: "pdf", limit: 2 })
  expect(first.sources).toHaveLength(2)
  expect(first.sources.every((item) => category(item) === "pdf")).toBe(true)
  expect(first.categories).toMatchObject({ code: 30, pdf: 3, word: 1, text: 1, markdown: 1 })
  const next = await f.storage.view(f.root, { category: "pdf", limit: 2, offset: 2, generation: first.generation })
  expect(next.sources).toHaveLength(1)
  expect(new Set([...first.sources, ...next.sources].map((item) => item.id)).size).toBe(3)
  expect((await f.storage.view(f.root, { category: "pdf", session: "private" })).categories?.pdf).toBe(4)
  for (const key of ["pdf", "word", "text", "markdown"]) {
    expect((await f.storage.view(f.root, { category: key })).sources.every((item) => category(item) === key)).toBe(true)
  }
  expect((await f.storage.view(f.root, { category: "nonexistent" })).sources).toEqual([])
  expect((await f.storage.view(f.root, { category: "pdf", limit: 2, offset: 2, generation: "obsolete" })).page.offset).toBe(0)
})
