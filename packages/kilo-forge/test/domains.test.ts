import { expect, test } from "bun:test"
import { chunks } from "../src/extract"
import { route } from "../src/domains"
import { select } from "../src/context"
import type { Collection } from "../src/schema"

const collection: Collection = {
  id: "manual", label: "Reference", kind: "text", location: "", session: "chat",
  origin: "interface", include: [], exclude: [], watch: false, approved: true,
  providers: ["local"], state: "ready", observed: 0, generation: "fixture",
  files: 1, chunks: 0, warnings: [],
}

test("document routing returns original sections and page identities, not sampled descriptors", () => {
  const sources = chunks(collection, "reference.pdf", new TextEncoder().encode("version"), [
    { page: 1, text: "Lease ownership requires monotonically increasing epochs." },
    { page: 2, text: "Lease ownership expires after the renewal deadline." },
    { page: 3, text: "Metrics are aggregated once per minute." },
  ])
  const selected = route("lease ownership", sources)
  expect(selected).toHaveLength(2)
  expect(selected.map((item) => item.source.detail.page).sort((a, b) => Number(a) - Number(b))).toEqual(["1", "2"])
  for (const item of selected) {
    expect(item.source).toBe(sources.find((source) => source.id === item.source.id)!)
    expect(item.source.method).toBe("collection-section")
    expect(item.reason).toContain(`page ${item.source.detail.page}`)
    expect(item.reason).toContain("sampled at most 24 sections")
  }
  for (const method of ["ranked", "greedy", "knapsack"] as const) {
    const context = select(selected, 2400, method)
    expect(context.matches).toHaveLength(2)
    expect(context.text).toContain("monotonically increasing")
    expect(context.text).toContain("renewal deadline")
    expect(context.text).toContain("; page 1)")
    expect(context.text).toContain("; page 2)")
    expect(select(selected, 2400, method, [selected.at(0)!.source.id]).matches).toHaveLength(2)
    const overlap = selected.map((item) => ({ ...item, source: { ...item.source, detail: { ...item.source.detail, page: "1" } } }))
    expect(select(overlap, 2400, method).matches).toHaveLength(1)
  }
})

test("document routes require current matching parents and preserve bounded expansion", () => {
  const sources = Array.from({ length: 5 }, (_, index) => chunks(
    { ...collection, id: `manual-${index}` },
    "reference.md",
    new TextEncoder().encode(String(index)),
    [{ text: Array.from({ length: 12 }, (_, index) => `# Lease ownership ${index}\nUnique requirement ${index}`).join("\n") }],
  )).flat()
  const selected = route("lease ownership", sources)
  expect(selected).toHaveLength(24)
  expect(new Set(selected.map((item) => item.source.detail.collection)).size).toBe(3)
  const parent = sources.find((item) => item.method === "collection-document")!
  const children = sources.filter((item) => item.evidence.includes(parent.id))
  expect(route("lease ownership", children)).toEqual([])
  expect(route("lease ownership", [{ ...parent, status: "unavailable" }, ...children])).toEqual([])
  for (const field of ["collection", "session", "fileHash"]) {
    expect(route("lease ownership", [parent, ...children.map((item) => ({
      ...item, detail: { ...item.detail, [field]: "foreign" },
    }))])).toEqual([])
  }
  expect(route("lease ownership", [parent, ...children.map((item) => ({ ...item, status: "stale" as const }))])).toEqual([])
})

test("routing sample limits do not imply exhaustive document coverage", () => {
  const sources = chunks(collection, "reference.md", new Uint8Array(), [{
    text: [
      ...Array.from({ length: 24 }, (_, index) => `# Metrics ${index}\nUnrelated monitoring reference.`),
      "# Lease ownership\nEpoch renewal requirements.",
    ].join("\n"),
  }])
  expect(route("lease ownership", sources)).toEqual([])
})

test("document routing bounds title and heading metadata without rewriting original evidence", () => {
  const sources = chunks(collection, "reference.md", new Uint8Array(), [{ text: "Monitoring metrics" }])
  const hidden = `${"x".repeat(240)} lease ownership`
  const large = sources.map((item) => ({ ...item, label: hidden, detail: { ...item.detail, heading: hidden } }))
  expect(route("lease ownership", large)).toEqual([])
  const selected = route("monitoring metrics", large)
  expect(selected).toHaveLength(1)
  expect(selected.at(0)!.reason.length).toBeLessThan(400)
  expect(selected.at(0)!.source.label).toBe(hidden)
})
