import { expect, test } from "bun:test"
import { mkdtemp, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { source } from "../src/parse"
import { scope } from "../src/semantic-scope"
import { permitted } from "@kilocode/kilo-indexing/search-scope"

test("semantic scope checks actual files and preserves exact source mapping order", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "forge-scope-"))
  try {
    const text = "first passage\nsecond passage"
    await Bun.write(path.join(root, "file.ts"), text)
    const file = source("file.ts", text, "code", { method: "file" })
    const first = source("file.ts", "first passage", "code", { id: "first", method: "line-window", start: 1, end: 1 })
    const second = source("file.ts", "second passage", "code", { id: "second", method: "line-window", start: 2, end: 2 })
    const mask = await scope(root, [file, first, second], new Set([file.id, first.id]))
    const row = { filePath: "file.ts", codeChunk: text, startLine: 1, endLine: 2 }
    expect(mask).toHaveLength(1)
    expect(permitted(row, mask)).toBe(false)
    expect(permitted({ ...row, codeChunk: first.text }, mask)).toBe(false)
    expect(permitted({ ...row, codeChunk: second.text, startLine: 2 }, mask)).toBe(true)
    // A non-exact chunk uses the containing window, just as engine remapping does.
    expect(permitted({ ...row, codeChunk: "second", startLine: 2 }, mask)).toBe(true)
    expect(permitted({ ...row, codeChunk: "first", startLine: 1 }, mask)).toBe(false)
    expect(await scope(root, [file, first, second], new Set([file.id, first.id, second.id]))).toEqual([])
    await Bun.write(path.join(root, "file.ts"), "changed on disk")
    expect(await scope(root, [file, first, second], new Set())).toEqual([])
    await Bun.write(path.join(root, "file.ts"), text)
    expect(await scope(root, [{ ...file, status: "stale" }], new Set())).toEqual([])
    expect(await scope(root, [{ ...file, detail: { collection: "registered" } }], new Set())).toEqual([])
    await rm(path.join(root, "file.ts"))
    expect(await scope(root, [file], new Set())).toEqual([])
    await symlink(import.meta.filename, path.join(root, "file.ts"))
    expect(await scope(root, [file], new Set())).toEqual([])
    const controller = new AbortController()
    controller.abort(new Error("stopped"))
    expect(await scope(root, [file], new Set(), controller.signal).catch((err: unknown) => err)).toMatchObject({ message: "stopped" })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
