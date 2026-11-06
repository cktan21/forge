import { expect, test } from "bun:test"
import { readiness, semantic, coverage } from "../src/semantic"
import { RetrievalChannel, Status, decode } from "../src/schema"
import { channels } from "../src/selection"

test("semantic readiness distinguishes initialization, disabled, partial, failed, and unknown states", () => {
  expect(readiness()).toEqual({ state: "uninitialized", searchable: false })
  expect(readiness({ initialized: false, state: "In Progress" })).toEqual({ state: "initializing", searchable: false })
  expect(readiness({ initialized: false, state: "Disabled" })).toEqual({ state: "disabled", searchable: false })
  expect(readiness({ initialized: true, state: "Error" })).toEqual({ state: "error", searchable: false })
  expect(readiness({ initialized: true, state: "In Progress" })).toEqual({ state: "indexing", searchable: true })
  expect(readiness({ initialized: true, state: "Standby" })).toEqual({ state: "paused", searchable: true })
  expect(readiness({ initialized: true, state: "Complete" })).toEqual({ state: "ready", searchable: true })
  expect(readiness({ initialized: true, state: "Future state" })).toEqual({ state: "unknown" })
  expect(semantic(readiness())).toContain("not initialized; search unavailable")
  expect(semantic(readiness({ initialized: true, state: "Complete" }))).toContain("completeness and freshness not guaranteed")
  expect(semantic()).toContain("not reported")
  expect(coverage).toContain("destination approval and explicit indexing")
  expect(coverage).toContain("repository readiness does not describe collection coverage")
})

test("legacy status and channel records remain readable without invented readiness", () => {
  const channel = { name: "semantic", state: "completed", candidates: 0, withheld: 0 } as const
  expect(decode(RetrievalChannel, channel)).toEqual(channel)
  expect(decode(Status, {
    inventory: { root: "/legacy", generation: "", revision: "", observed: 0, files: 0, partial: false, warnings: [], counts: {}, indexed: false },
    session: "", job: { id: "", state: "idle", started: 0, updated: 0, message: "" },
  }).semantic).toBeUndefined()
  expect(channels({
    candidates: [], total: 0, unrecorded: 0, withheld: 0, budget: 0, tokens: 0, estimator: "test",
    channels: [channel],
  }).at(0)).toContain("readiness not reported")
})
