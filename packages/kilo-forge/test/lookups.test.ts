import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { lookups, marker } from "../src/lookups"

test("lookup markers require an exact search-tool result after the latest user", () => {
  const id = randomUUID()
  const part = { type: "tool-result", toolName: "forge_search_code", toolCallId: "call", output: { type: "text", value: `${marker(id)}\nEvidence` } }
  const messages = [{ role: "user", content: "Search" }, { role: "tool", content: [part] }]
  expect(lookups(messages)).toEqual([{ id, tool: "forge_search_code", call: "call" }])
  for (const tool of ["forge_get_symbol", "forge_relationships"]) expect(lookups([messages.at(0), { role: "tool", content: [{ ...part, toolName: tool }] }])).toEqual([{ id, tool, call: "call" }])
  expect(lookups([...messages, { role: "user", content: "New task" }])).toEqual([])
  expect(lookups([{ role: "user", content: marker(id) }])).toEqual([])
  expect(lookups([{ role: "tool", content: [part] }])).toEqual([])
  for (const changed of [
    { ...part, toolName: "other" }, { ...part, toolCallId: "" },
    { ...part, output: { type: "json", value: marker(id) } },
    { ...part, output: { type: "text", value: `${marker(id)}\n${marker(id)}` } },
    { ...part, output: { type: "text", value: `${marker(id)}\n${"x".repeat(2_000_000)}` } },
  ]) expect(lookups([messages.at(0), { role: "tool", content: [changed] }])).toEqual([])
  expect(marker("invalid")).toBe("")
})

test("lookup resolution bounds the most recent references", () => {
  const ids = Array.from({ length: 40 }, () => randomUUID())
  const messages = [{ role: "user", content: "Search" }, ...ids.map((id) => ({ role: "tool", content: [{ type: "tool-result", toolName: "forge_search_docs", toolCallId: id, output: { type: "text", value: marker(id) } }] }))]
  expect(lookups(messages).map((item) => item.id)).toEqual(ids.slice(-32))
  expect(lookups(null)).toEqual([])
  expect(lookups([null, {}, "garbage"])).toEqual([])
})
