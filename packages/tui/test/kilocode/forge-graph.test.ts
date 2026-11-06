import { expect, test } from "bun:test"
import { source } from "@kilocode/forge/parse"
import { usage, type Manifest, type View } from "@kilocode/forge/schema"
import { capacity, connections, counts, layout, move, projection, truncate } from "../../src/kilocode/forge/graph"

test.each([[112, 28], [74, 16], [28, 8]])("terminal map fits a %s by %s viewport without overlapping objects", (width, height) => {
  const items = Array.from({ length: capacity(height) }, (_, index) => ({
    id: `category:${index}`, label: `Category ${index}`, caption: "10 sources", category: String(index),
  }))
  const nodes = layout(items, width, height, "provider/model")
  const root = nodes.at(0)!
  expect(root.id).toBe("forge")
  expect(Math.abs(root.x + root.width / 2 - width / 2)).toBeLessThanOrEqual(1)
  expect(Math.abs(root.y + root.height / 2 - height / 2)).toBeLessThanOrEqual(1)
  for (const node of nodes) {
    expect(node.x).toBeGreaterThanOrEqual(0)
    expect(node.y).toBeGreaterThanOrEqual(0)
    expect(node.x + node.width).toBeLessThanOrEqual(width)
    expect(node.y + node.height).toBeLessThanOrEqual(height)
    for (const other of nodes.filter((item) => item !== node)) {
      expect(node.x + node.width <= other.x || other.x + other.width <= node.x
        || node.y + node.height <= other.y || other.y + other.height <= node.y).toBe(true)
    }
  }
  const lines = connections(nodes, width, height).split("\n")
  expect(lines).toHaveLength(height)
  expect(lines.every((line) => line.length === width)).toBe(true)
})

test("arrow navigation follows geometry and remains on the current object at a boundary", () => {
  const nodes = layout([
    { id: "left", label: "Left", caption: "" }, { id: "right", label: "Right", caption: "" },
    { id: "lower-left", label: "Lower left", caption: "" }, { id: "lower-right", label: "Lower right", caption: "" },
  ], 112, 16, "model")
  expect(move(nodes, "forge", "left")).toBe("left")
  expect(move(nodes, "forge", "right")).toBe("right")
  expect(move(nodes, "left", "down")).toBe("lower-left")
  expect(move(nodes, "left", "up")).toBe("left")
  expect(move(nodes, "lower-right", "up")).toBe("right")
})

test("historical context uses captured text and never substitutes the available catalog or mismatched metadata", () => {
  const current = source("new.pdf", "Current PDF text", "document", { id: "document", hash: "current", method: "file" })
  const view: View = {
    root: "/workspace", revision: "1", generation: "1", observed: 1, files: 1, partial: false,
    sources: [current], relations: [], warnings: [], page: { offset: 0, limit: 25 },
  }
  const manifest: Manifest = {
    id: "request", session: "session", root: "/workspace", generation: "old", purpose: "coding",
    model: "old-model", observed: 0, state: "sent", usage: usage(), coverage: [],
    entries: [{ source: "document", hash: "old", text: "Captured Word passage", uri: "old.docx", label: "Old report",
      kind: "document", stage: "sent", tokens: 4 }],
  }
  const captured = projection(view, manifest)
  expect(captured.at(0)).toMatchObject({ text: "Captured Word passage", uri: "old.docx", hash: "old", status: "stale", evidence: [] })
  expect(captured.at(0)?.detail.stage).toBe("sent")
  expect(counts(captured)).toEqual({ word: 1 })
  expect(projection(view, { ...manifest, entries: [] })).toEqual([])
  expect(projection(view)).toEqual([current])
})

test("map labels strip terminal controls and truncate without splitting surrogate pairs", () => {
  expect(truncate("hello\nworld\u001b", 20)).toBe("hello world ")
  expect(truncate("long source filename", 10)).toBe("long so...")
  expect(truncate("hello", 2)).toBe("..")
})
