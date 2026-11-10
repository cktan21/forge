import { expect, test } from "bun:test"
import type { Round } from "@kilocode/forge/investigation"
import { source } from "@kilocode/forge/parse"
import { describe, progress } from "../../src/kilocode/forge/progress"

function call(tool: string, input: Record<string, unknown> = {}) {
  return { id: "call", tool, input: JSON.stringify(input), state: "running" as const }
}

const turn: Round = {
  request: crypto.randomUUID(), number: 1, final: false, state: "tools", started: 1, updated: 2,
  summary: "Parsed one tool request", included: [], omitted: [], requested: 1, inspections: [],
}

test("inspection labels identify actual files, queries, and lookup targets", () => {
  expect(describe(call("forge_read_file", { path: "src/queue.ts" }))).toBe("Reading src/queue.ts")
  expect(describe(call("forge_search_code", { query: "queue retries" }))).toBe('Searching repository for "queue retries"')
  expect(describe(call("forge_search_docs", { query: "retry policy" }))).toBe('Searching documentation for "retry policy"')
  expect(describe(call("forge_lookup", { path: "backend", text: "enqueue" }))).toBe('Finding files matching "backend" and "enqueue"')
  expect(describe(call("forge_lookup", { text: "enqueue" }))).toBe('Finding files containing "enqueue"')
  expect(describe(call("forge_finish"))).toBe("Preparing findings from the inspected evidence")
})

test("source inspection resolves recorded source IDs to useful file names", () => {
  const item = source("src/queue.ts", "export const queue = []", "code")
  expect(describe(call("forge_get_symbol", { id: item.id }), [item])).toBe(`Inspecting src/queue.ts:${item.start}-${item.end}`)
  expect(describe(call("forge_relationships", { id: item.id }), [item])).toBe("Following imports and callers of src/queue.ts")
  expect(describe(call("forge_get_symbol", { id: "missing" }))).toBe("Inspecting source details")
})

test("live progress follows recorded scans and file activity", () => {
  for (const [action, path, expected] of [
    ["Scan repository", undefined, "Scanning repository inventory"],
    ["Use indexed inventory", undefined, "Using the existing repository inventory"],
    ["Read locally", "src/queue.ts", "Reading src/queue.ts"],
    ["Parse locally", "src/queue.ts", "Parsing src/queue.ts"],
    ["Retrieved candidate", "src/queue.ts:10-20", "Matching src/queue.ts:10-20"],
    ["Selected for model", "src/queue.ts:10-20", "Selecting context from src/queue.ts:10-20"],
    ["Evidence rechecked", "src/queue.ts:10-20", "Checking evidence from src/queue.ts:10-20"],
  ] as const) {
    expect(progress({ ...turn, inspections: [{
      ...call("forge_search_code", { query: "queue" }),
      activity: { total: 1, entries: [{ action, path, detail: "Recorded local activity" }] },
    }] })).toBe(expected)
  }
})

test("progress selects the running operation instead of a completed earlier call", () => {
  expect(progress({ ...turn, inspections: [
    { ...call("forge_read_file", { path: "old.ts" }), state: "complete" },
    call("forge_read_file", { path: "current.ts" }),
  ] })).toBe("Reading current.ts")
  expect(progress({ ...turn, inspections: [
    { ...call("forge_read_file", { path: "next.ts" }), state: "requested" },
  ] })).toBe("Next: Reading next.ts")
  expect(progress({ ...turn, inspections: [
    { ...call("forge_read_file", { path: "skipped.ts" }), state: "skipped" },
  ] })).toBe("Skipped: Reading skipped.ts")
})

test("pending model work and errors are labelled without inventing a scan", () => {
  expect(progress({ ...turn, state: "model" })).toBe("Waiting for the next model update")
  expect(progress({ ...turn, state: "model", final: true })).toBe("Preparing findings from the inspected evidence")
  expect(progress({ ...turn, state: "failed", summary: "Provider rate limited the request" })).toBe("Provider rate limited the request")
})

test("labels tolerate truncated previews and ignore private or unrelated fields", () => {
  expect(describe({ ...call("forge_read_file"), input: '{"path":"truncated' })).toBe("Reading a repository file")
  expect(describe({ ...call("forge_read_file"), input: "null" })).toBe("Reading a repository file")
  expect(describe(call("forge_read_file", { path: "src/\nqueue.ts", reasoning: "PRIVATE_REASONING_CANARY" }))).toBe("Reading src/ queue.ts")
  expect(describe(call("forge_search_code", { query: "x".repeat(1000) })).length).toBeLessThan(300)
})
