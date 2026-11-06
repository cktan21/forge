import { expect, test } from "bun:test"
import { brief, briefs } from "../src/briefs"
import { chunks } from "../src/extract"
import { route } from "../src/domains"
import { select } from "../src/context"
import type { Collection } from "../src/schema"

const collection: Collection = {
  id: "manual", label: "Reference", kind: "text", location: "", session: "chat",
  origin: "interface", include: [], exclude: [], watch: false, approved: true,
  providers: ["local"], state: "ready", observed: 0, generation: "fixture", files: 1, chunks: 0, warnings: [],
}

test("document briefs persist bounded source-backed routing without becoming evidence", () => {
  const sources = chunks(collection, "reference.pdf", new TextEncoder().encode("version"), [
    { page: 2, text: "Lease ownership expires after the renewal deadline." },
    { page: 1, text: "Lease ownership requires monotonically increasing epochs." },
  ])
  const parent = sources.at(0)!
  const value = brief(parent, sources)
  expect(value.cached).toBe(true)
  expect(parent.text).toBe("")
  expect(parent.detail.coverage).toContain("Not a complete summary or selected evidence")
  expect(value.ids.map((key) => sources.find((item) => item.id === key)?.detail.page)).toEqual(["1", "2"])
  expect(parent.evidence).toEqual(value.ids)
  expect(briefs(sources).at(0)).toBe(parent)
  expect(briefs([...sources].reverse()).find((item) => item.id === parent.id)).toBe(parent)
  const matches = route("lease ownership", sources)
  expect(matches).toHaveLength(2)
  expect(matches.every((item) => item.reason.includes("persisted brief"))).toBe(true)
  const selected = select(matches, 2400)
  expect(selected.matches.every((item) => item.source.method === "collection-section")).toBe(true)
  expect(selected.text).not.toContain("Extractive routing brief")
  expect(selected.text).toContain("; page 1)")
  expect(selected.text).toContain("; page 2)")
})

test("briefs discard cached descriptors when sections are missing, stale, or from another scope", () => {
  const sources = chunks(collection, "reference.md", new Uint8Array(), [{
    text: "# Restricted\nLease ownership canary.\n# Monitoring\nMetrics aggregate counters.",
  }])
  const parent = sources.at(0)!
  const omitted = sources.find((item) => item.text.includes("canary"))!
  const eligible = sources.filter((item) => item.id !== omitted.id)
  expect(brief(parent, eligible).cached).toBe(false)
  expect(brief(parent, eligible).text).not.toContain("canary")
  expect(route("lease ownership", eligible)).toEqual([])
  for (const field of ["collection", "session", "fileHash"]) {
    const changed = sources.map((item) => item === omitted ? { ...item, detail: { ...item.detail, [field]: "foreign" } } : item)
    expect(brief(parent, changed).cached).toBe(false)
    expect(brief(parent, changed).text).not.toContain("canary")
    expect(route("lease ownership", changed)).toEqual([])
  }
  const stale = sources.map((item) => item === omitted ? { ...item, status: "stale" as const } : item)
  expect(brief(parent, stale).text).not.toContain("canary")
  const modified = sources.map((item) => item === omitted ? { ...item, hash: "changed", text: "# Restricted\nUpdated instructions." } : item)
  expect(brief(parent, modified).cached).toBe(false)
  expect(brief(parent, modified).text).not.toContain("canary")
})

test("legacy and damaged brief metadata rebuild from original passages without changing section identity", () => {
  const sources = chunks(collection, "reference.md", new Uint8Array(), [{ text: "# Lease ownership\nRenew epochs." }])
  const parent = sources.at(0)!
  for (const detail of [
    { ...parent.detail, briefVersion: "legacy" },
    { ...parent.detail, brief: "UNTRUSTED_CACHE_CANARY" },
    Object.fromEntries(Object.entries(parent.detail).filter(([key]) => !key.startsWith("brief"))),
  ]) {
    const old = [{ ...parent, detail }, ...sources.slice(1)]
    expect(brief(old.at(0)!, old).cached).toBe(false)
    const updated = briefs(old)
    expect(updated.at(0)?.hash).toBe(parent.hash)
    expect(updated.at(0)?.detail.brief).toBe(parent.detail.brief)
    expect(updated.at(1)).toBe(sources.at(1))
  }
})

test("brief samples and serialized dependency metadata stay bounded", () => {
  const sources = chunks({ ...collection, label: "x".repeat(1000) }, "reference.md", new Uint8Array(), [{
    text: Array.from({ length: 30 }, (_, index) => `# ${index} ${"h".repeat(1000)}\n${"p".repeat(1000)}`).join("\n"),
  }])
  const parent = sources.at(0)!
  expect(parent.evidence).toHaveLength(24)
  expect(parent.detail.brief!.length).toBeLessThanOrEqual(240 + 1 + 24 * 482)
  expect(JSON.parse(parent.detail.briefDependencies!)).toHaveLength(24)
  expect(parent.detail.coverage).toContain("24 of 30 eligible sections sampled")
})
