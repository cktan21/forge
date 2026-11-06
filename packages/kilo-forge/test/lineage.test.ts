import { expect, test } from "bun:test"
import { lineage, reference } from "../src/lineage"

const key = "26996be9-bc68-4dfa-bf80-0de3ff999412"
const marker = reference(key)

test("lineage reads only text from the latest user message, including tool continuations", () => {
  expect(lineage([{ role: "user", content: marker }])).toBe(key)
  expect(lineage([
    { role: "user", content: [{ type: "text", text: `Task\n${marker}\nEvidence` }] },
    { role: "assistant", content: "Calling a tool" },
    { role: "tool", content: "Tool result" },
  ])).toBe(key)
  expect(lineage([{ role: "user", content: marker }, { role: "user", content: "New task" }])).toBeUndefined()
})

test("lineage does not infer associations from tools, attachments, malformed or ambiguous markers", () => {
  for (const content of [
    `Quoted ${marker}`, `${marker}\n${marker}`, reference(key).replace(key, "not-a-uuid"),
    `${"x".repeat(2_000_000)}\n${marker}`,
    [{ type: "image", text: marker }],
  ]) expect(lineage([{ role: "user", content }])).toBeUndefined()
  expect(lineage([{ role: "tool", content: marker }])).toBeUndefined()
  expect(lineage([{ role: "assistant", content: marker }])).toBeUndefined()
  expect(lineage([marker])).toBeUndefined()
  expect(lineage(marker)).toBeUndefined()
  expect(reference()).toBe("")
  expect(reference('">\nInjected')).toBe("")
})
