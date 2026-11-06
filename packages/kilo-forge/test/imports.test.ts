import { expect, test } from "bun:test"
import { activity, history, outcome } from "../src/imports"

test("import timing is a deadline observation, never a fabricated ETA", () => {
  const base = { stage: "extract" as const, files: 1, bytes: 20, chunks: 0, updated: 4500, document: "guide.pdf" }
  expect(activity(base)).toBe("Completion time unavailable.")
  expect(activity({ ...base, started: 1000, deadline: 31000 })).toBe("3s elapsed at last update. 27s until deadline; not a completion estimate.")
  expect(activity({ ...base, updated: 40000, started: 1000, deadline: 31000 })).toContain("0s until deadline")
})

test("import outcome distinguishes reused content from extraction and file errors", () => {
  expect(outcome({ started: 1000, finished: 2450, state: "published", files: 5, bytes: 128, extracted: 2, reused: 2, empty: 1, failed: 1 }))
    .toBe("Last run published: 2 parsed, 2 reused, 1 without text, 1 file errors; 128 bytes read in 1.4s.")
})

test("retained history distinguishes missing, live, and unfinished checkpoints", () => {
  const page = { offset: 0, limit: 50, total: 1 }
  const documents = [{ name: "guide.md", state: "processing" as const, bytes: 20, chunks: 0 }]
  const run = { id: "run", collection: "docs", session: "", started: 1000, updated: 2000, state: "running" as const, stage: "extract" as const, count: 1, withheld: 2 }
  expect(history({ runs: [], documents: [], page: { ...page, total: 0 } })).toEqual([
    "No retained import history. Older imports may have only aggregate results.",
  ])
  const live = history({ runs: [run], selected: run, documents, page }).join("\n")
  expect(live).toContain("guide.md: processing")
  expect(live).toContain("Running is not proof of a live process")
  for (const state of ["interrupted", "failed", "cancelled", "published"] as const) {
    const lines = history({ runs: [run], selected: { ...run, state }, documents, page }).join("\n")
    expect(lines).toContain("guide.md: unfinished (last observed processing)")
    expect(lines).toContain("Documents 1-1 of 1")
    expect(lines).not.toContain("Published generation:")
  }
})
