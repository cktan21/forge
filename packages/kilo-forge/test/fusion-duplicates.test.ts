import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fuse } from "../src/context"
import { engine } from "../src/engine"
import { source } from "../src/parse"
import { store } from "../src/store"

const originals = ["First independent original.", "Second independent original.", "Third independent original."].map((text, index) => ({
  source: source(`${index}.txt`, text, "code"), score: 1, reason: `rank ${index + 1}`,
}))

for (const limit of [1, 2, 100]) {
  test(`duplicate channel hits do not add votes or consume ranks at limit ${limit}`, () => {
    const [a, b, c] = originals
    const expected = fuse([[a!, b!, c!], [c!]], limit)
    const lists = [[a!, a!, b!, ...Array.from({ length: 100 }, () => b!), c!], [c!, c!]]
    const before = structuredClone(lists)
    expect(fuse(lists, limit)).toEqual(expected)
    expect(lists).toEqual(before)
  })
}

test("first occurrence supplies channel rank and provenance, distinct channels still corroborate", () => {
  const a = originals.at(0)!
  const b = originals.at(1)!
  const duplicate = { ...b, score: 100, reason: "Duplicate adapter row" }
  const result = fuse([[a, b, duplicate], [b]])
  expect(result).toEqual(fuse([[a, b], [b]]))
  expect(result.at(0)?.source).toBe(b.source)
  expect(result.at(0)?.score).toBe(1 / 62 + 1 / 61)
  expect(fuse([[b, duplicate]]).at(0)?.reason).toBe(b.reason)
})

// Fixed semantic boundary replies; actual scanning, remapping, SQLite,
// fusion, policy and selection run through the production engine.
for (const selector of ["ranked", "greedy", "knapsack"] as const) {
  test(`semantic chunks mapped to one original cannot crowd out another: ${selector}`, async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "forge-fusion-")))
    await Bun.write(path.join(root, ".kilo/forge.jsonc"), JSON.stringify({ selector, candidates: 1, budget: 600, exclude: [".kilo/**"] }))
    await Bun.write(path.join(root, "first.txt"), "First independent original.")
    await Bun.write(path.join(root, "second.txt"), "Second independent original.")
    const db = new Database(path.join(root, ".kilo/catalog.sqlite"))
    const storage = store({
      all: async (query) => db.query<Record<string, unknown>, (string | number | null)[]>(query.text).all(...query.values ?? []),
      batch: async (queries) => {
        db.transaction(() => {
          for (const query of queries) db.query(query.text).run(...query.values ?? [])
        })()
      },
    })
    let repeated = false
    let records = originals.slice(0, 0)
    const api = engine({
      root, store: storage,
      complete: async () => { throw new Error("No model calls permitted") },
      semantic: async () => repeated ? [records.at(0)!, ...Array.from({ length: 30 }, (_, index) => ({
        ...records.at(1)!,
        source: { ...records.at(1)!.source, id: `adapter-${index}` },
      }))] : records,
    })
    try {
      const snapshot = await api.refresh()
      records = ["first.txt", "second.txt"].map((uri) => ({
        source: snapshot.sources.find((item) => item.uri === uri && item.method === "file")!,
        score: 1, reason: "Ranked semantic input",
      }))
      const baseline = await api.retrieve("unmatched request", { session: "chat" })
      expect(baseline.matches.map((item) => item.source.id)).toEqual([records.at(0)!.source.id])
      repeated = true
      const result = await api.retrieve("unmatched request", { session: "chat" })
      expect(result.matches).toEqual(baseline.matches)
      expect(result.text).toBe(baseline.text)
      expect(result.tokens).toBe(Buffer.byteLength(result.text))
      expect(result.tokens).toBeLessThanOrEqual(600)
      expect(result.audit?.channels?.find((item) => item.name === "semantic")?.candidates).toBe(31)
      expect(result.audit?.candidates.find((item) => item.source === records.at(1)!.source.id)?.channels)
        .toContainEqual(expect.objectContaining({ name: "semantic", rank: 2 }))
      const excluded = await api.retrieve("unmatched request", { session: "chat", exclude: [records.at(0)!.source.id] })
      expect(excluded.matches.map((item) => item.source.id)).toEqual([records.at(1)!.source.id])
      const pinned = await api.retrieve("unmatched request", { session: "chat", pin: [records.at(1)!.source.id] })
      expect(pinned.matches.at(0)?.source).toEqual(records.at(1)!.source)
    } finally {
      await api.dispose()
      db.close()
      await rm(root, { recursive: true, force: true })
    }
  })
}
