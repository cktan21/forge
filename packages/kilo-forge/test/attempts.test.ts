import { expect, test } from "bun:test"
import { attempts, outcome } from "../src/attempts"
import { decode, Manifest, usage } from "../src/schema"

test("legacy captures remain unknown while bounded attempt summaries disclose omitted history", () => {
  const manifest = decode(Manifest, { id: "legacy", root: "", session: "", generation: "", purpose: "coding", model: "", observed: 0, entries: [], coverage: [], usage: usage(), state: "completed" })
  expect(attempts(manifest)).toContain("unavailable")
  expect(attempts({ ...manifest, attempts: [], discarded: 4 })).toContain("4 older attempts omitted")
  const attempt = { id: "attempt", sequence: 3, started: 0, sent: [], membership: "unknown" as const }
  expect(outcome({ ...attempt, state: "pending" })).toContain("outcome unknown")
  expect(outcome({ ...attempt, state: "error", finished: 10 })).toContain("transmission unknown; 10 ms")
  expect(outcome({ ...attempt, state: "blocked" })).toContain("blocked before fetch")
  expect(outcome({ ...attempt, state: "response", status: 503 })).toContain("HTTP 503; membership unknown")
  expect(outcome({ ...attempt, state: "response", status: 200, membership: "matched", sent: ["source"] })).toContain("1 excerpt matches")
})
