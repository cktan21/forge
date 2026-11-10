import { expect, test } from "bun:test"
import { publisher } from "../src/investigation-events"
import type { InvestigationProgress } from "../src/investigation-schema"
import { tokens } from "../src/util"

test("activity is coalesced before snapshot creation while transitions and heartbeats remain immediate", () => {
  let now = 0
  let built = 0
  const frames: InvestigationProgress[] = []
  const send = publisher(
    (frame) => frames.push(frame),
    undefined,
    () => now,
  )
  const snapshot = () => {
    built++
    return { type: "progress" as const, stage: "Inspecting", turns: 1, calls: 1, journal: [], observations: [] }
  }
  for (let index = 0; index < 1000; index++) {
    now = index * 10
    send(snapshot, true)
  }
  expect(built).toBe(20)
  send(() => ({ type: "progress", stage: "Waiting", turns: 1, calls: 1, elapsed: now }))
  send(() => ({ ...snapshot(), stage: "Turn complete" }))
  expect(frames).toHaveLength(22)
  expect(frames.at(-2)?.journal).toBeUndefined()
  expect(frames.at(-1)?.stage).toBe("Turn complete")
})

test("coalescing reduces serialized snapshot bytes without exposing a late cancelled update", () => {
  let now = 0
  const controller = new AbortController()
  const frame: InvestigationProgress = {
    type: "progress",
    stage: "Inspecting",
    turns: 1,
    calls: 1,
    journal: [],
    observations: [
      {
        id: "read",
        tool: "forge_read_file",
        input: { path: "queue.ts" },
        output: "evidence ".repeat(2000),
        sources: [],
        observed: 1,
      },
    ],
  }
  let bytes = 0
  const send = publisher(
    (value) => {
      bytes += tokens(JSON.stringify(value))
    },
    controller.signal,
    () => now,
  )
  for (let index = 0; index < 1000; index++) {
    now = index * 10
    send(() => frame, true)
  }
  const original = tokens(JSON.stringify(frame)) * 1000
  expect(bytes).toBe(original / 50)
  const before = bytes
  controller.abort()
  send(() => frame)
  expect(bytes).toBe(before)
})
