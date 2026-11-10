import { expect, test } from "bun:test"
import { history } from "../src/investigation-context"
import { limits, type Observation } from "../src/investigation-schema"
import { source } from "../src/parse"
import { tokens } from "../src/util"

test("large reference inventories fit the evidence budget without dropping the retained ledger", () => {
  const observations: Observation[] = Array.from({ length: 18 }, (_, turn) => {
    const sources = Array.from({ length: 10 }, (_, index) =>
      source(
        `packages/${"service/".repeat(35)}module-${turn}-${index}.ts`,
        `export const item${index} = ${turn}`,
        "code",
      ),
    )
    return {
      id: `search-${turn}`,
      tool: "forge_search_code",
      input: { query: `module ${turn}` },
      output: sources.map((item) => `[${item.id}] ${item.uri}\n${item.text}`).join("\n"),
      sources,
      observed: turn,
    }
  })
  const original = structuredClone(observations)
  const values = history(observations)
  expect(values).toHaveLength(18)
  expect(values.reduce((sum, item) => sum + tokens(item.output), 0)).toBeLessThanOrEqual(limits.evidence)
  expect(observations).toEqual(original)
  const compacted = values.filter((item, index) => item.output !== observations.at(index)?.output)
  expect(compacted.length).toBeGreaterThan(0)
  expect(compacted.some((item) => JSON.parse(item.output).omittedSources > 0)).toBe(true)
})

test("oversized reference paths cannot crowd out a small directly inspected source", () => {
  const file = source("queue.ts", "export const queue = []", "code")
  const sources = Array.from({ length: 100 }, (_, index) =>
    source(`docs/${"long/".repeat(100)}${index}.md`, `Entry ${index}`, "document"),
  )
  const observations: Observation[] = [
    {
      id: "read",
      tool: "forge_read_file",
      input: { path: "queue.ts" },
      output: JSON.stringify({ source: file, total: 20, next: 2 }),
      sources: [file],
      observed: 1,
    },
    {
      id: "search",
      tool: "forge_search_docs",
      input: { query: "queue" },
      output: "Unrelated search result ".repeat(3000),
      sources,
      observed: 2,
    },
  ]
  const values = history(observations)
  expect(values.at(0)?.output).toBe(observations.at(0)?.output)
  expect(values.reduce((sum, item) => sum + tokens(item.output), 0)).toBeLessThanOrEqual(limits.evidence)
  expect(JSON.parse(values.at(1)!.output).omittedSources).toBeGreaterThan(0)
})

test("evidence between 24,000 and 48,000 bytes is replayed in full", () => {
  const file = source("queue.ts", "// queue\n".repeat(3500), "code")
  const observation: Observation = {
    id: "search",
    tool: "forge_search_code",
    input: { query: "queue" },
    output: file.text,
    sources: [file],
    observed: 1,
  }
  expect(limits.evidence).toBe(48_000)
  expect(tokens(observation.output)).toBeGreaterThan(24_000)
  expect(history([observation]).at(0)?.output).toBe(observation.output)
})
