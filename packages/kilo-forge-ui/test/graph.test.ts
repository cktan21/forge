import { expect, test } from "bun:test"
import { elements, projection } from "../src/graph"
import { source, relation } from "../../kilo-forge/src/parse"
import { usage, type Snapshot, type Manifest } from "@kilocode/forge/schema"

test("projects source relationships around one agent without fabricating transmission", () => {
  const code = source("src/queue.ts", "export function next() {}", "code")
  const doc = source("README.md", "Queue behavior", "document")
  const snapshot: Snapshot = { root: "/fixture", revision: "abc", generation: "1", observed: 0, sources: [code, doc], relations: [relation(doc.id, code.id, "likely-documents", [doc.id], "Name match", true)], warnings: [], partial: false, files: 2 }
  const graph = elements(snapshot)
  expect(graph.filter((item) => item.data.central)).toHaveLength(1)
  expect(graph.find((item) => item.data.id === code.id)?.data.stage).toBe("indexed")
  expect(graph.find((item) => item.data.id === snapshot.relations[0]!.id)?.data.inferred).toBe(true)
  const manifest: Manifest = { id: "request", session: "session", root: "/fixture", generation: "1", purpose: "enhance", model: "fixture", observed: 0, entries: [{ source: code.id, hash: code.hash, text: code.text, stage: "sent", tokens: 8 }, { source: code.id, hash: code.hash, text: code.text, stage: "sent", tokens: 8 }], coverage: [], usage: usage(), state: "completed" }
  const request = elements(snapshot, manifest)
  expect(request.filter((item) => item.data.id === code.id)).toHaveLength(1)
  expect(request.some((item) => item.data.id === doc.id)).toBe(false)
  expect(request.find((item) => item.data.id === code.id)?.data.stage).toBe("sent")
})

test("request projection uses historical excerpts and omits current repository relationships", () => {
  const code = source("src/queue.ts", "export const value = 'current'", "code")
  const doc = source("README.md", "Current docs", "document")
  const snapshot: Snapshot = { root: "/fixture", revision: "abc", generation: "2", observed: 100, sources: [code, doc], relations: [relation(code.id, doc.id, "imports", [], "current")], warnings: [], partial: false, files: 2 }
  const manifest: Manifest = {
    id: "old", session: "chat", root: "/fixture", generation: "1", purpose: "coding", model: "fixture", observed: 1,
    entries: [
      { source: code.id, kind: "code", label: "Old queue", uri: "src/old-queue.ts", hash: "old", text: "old code excerpt", stage: "sent", tokens: 4 },
      { source: doc.id, kind: "document", label: "Old docs", uri: "README.md", hash: "old-doc", text: "old docs", stage: "assembled", tokens: 2 },
    ], coverage: [], usage: usage(), state: "failed",
  }
  const rows = projection(snapshot, manifest)
  expect(rows.at(0)).toMatchObject({ text: "old code excerpt", label: "Old queue", uri: "src/old-queue.ts", status: "stale" })
  expect(rows.at(0)?.detail.stage).toBe("sent")
  expect(projection(snapshot, manifest, "document", "readme")).toHaveLength(1)
  const graph = elements(snapshot, manifest)
  expect(graph.some((item) => item.data.id === snapshot.relations.at(0)?.id)).toBe(false)
  expect(graph.filter((item) => rows.some((row) => row.id === item.data.id))).toHaveLength(rows.length)
})
