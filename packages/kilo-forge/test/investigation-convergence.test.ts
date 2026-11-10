import { expect, test } from "bun:test"
import { Schema } from "effect"
import { randomUUID } from "node:crypto"
import { checkpoint } from "../src/investigation-context"
import { instruction } from "../src/investigation"
import { decode, usage } from "../src/schema"
import { conclusion, fixture, model, result } from "./investigation-fixture"

test("preparation policy favors an actionable brief over completing the coding task", () => {
  expect(instruction).toContain("The deliverable is a clearer task, not a solved task")
  expect(instruction).toContain("two or three model turns")
  expect(instruction).toContain("not a quota or a limit")
  expect(instruction).toContain('support: "unresolved"')
  expect(instruction).toContain("database integrity and transactional consistency")
  expect(instruction).toContain("Do not repeat answered questions")
  expect(instruction).toContain("UNTRUSTED DATA")
  expect(instruction).toContain("never assume destructive actions")
  expect(checkpoint([])).toContain("Clarify only missing user intent")
})

test("discovery and direct evidence produce different preparation checkpoints", async () => {
  await using f = await fixture(async (input) => {
    if (!input.observations.length)
      return result(input, [{ id: "search", name: "forge_search_code", input: { query: "enqueue queue" } }])
    if (input.observations.length === 1) {
      expect(input.system).toContain("Discovery results are available")
      expect(input.system).not.toContain("Direct source has been inspected")
      return result(input, [{ id: "read", name: "forge_read_file", input: { path: "queue.ts" } }])
    }
    expect(input.system).toContain("Direct source has been inspected")
    expect(input.system).toContain("Additional inspection needs a specific gap")
    expect(input.system).not.toContain("queue.push")
    expect(input.final).toBe(false)
    return result(input, [{ id: "finish", name: "forge_finish", input: conclusion([input.sources.at(-1)!.id]) }])
  })
  const record = await f.api.investigate({ key: randomUUID(), text: "Fix repeated enqueue", model })
  expect(record.state).toBe("findings_ready")
  expect(record.turns).toBe(3)
})

test.each([1, 4])("a useful direction may finish after %i reads without a new turn cap", async (count) => {
  await using f = await fixture(async (input) => {
    expect(input.final).toBe(false)
    if (input.observations.length < count)
      return result(input, [
        {
          id: `read-${input.observations.length}`,
          name: "forge_read_file",
          input: { path: input.observations.length % 2 ? "caller.ts" : "queue.ts", lines: 2 },
        },
      ])
    expect(input.system).toContain("Direct source has been inspected")
    if (count > 2) expect(input.system).toContain("only previously available source versions")
    const source = input.sources.find((item) => item.uri === "queue.ts")!
    return result(input, [{ id: "finish", name: "forge_finish", input: conclusion([source.id]) }])
  })
  const record = await f.api.investigate({ key: randomUUID(), text: "Fix queue duplicates", model })
  expect(record.turns).toBe(count + 1)
  expect(record.calls).toBe(count)
  expect(record.state).toBe("findings_ready")
  expect(record.journal?.every((item) => !item.final)).toBe(true)
})

test("answers can become a diagnostic prompt without a proven defect or another questionnaire", async () => {
  const question = {
    id: "outcome",
    question: "Which database outcome matters?",
    impact: "Selects the goal of the task.",
    options: ["Transactional consistency", "Query performance"],
    optional: false,
  }
  let writes = 0
  await using f = await fixture(
    async (input) => {
      const task = decode(Schema.Struct({ answers: Schema.String }), JSON.parse(input.input))
      expect(input.final).toBe(false)
      if (!task.answers)
        return result(input, [
          { id: "clarify", name: "forge_finish", input: { ...conclusion(), questions: [question] } },
        ])
      expect(task.answers).toContain("Transactional consistency")
      return result(input, [
        {
          id: "finish",
          name: "forge_finish",
          input: {
            intent: "Improve database integrity and transactional consistency.",
            summary: "Prepare a scoped diagnostic task; no defect is established.",
            findings: [
              {
                title: "Inspect transactional consistency",
                kind: "diagnostic",
                support: "unresolved",
                explanation: "The requested outcome is clear, but write invariants remain to be inspected.",
                benefit: "Focus the coding agent on database integrity.",
                evidence: [],
                counterevidence: [],
                unknowns: ["Which related writes need a shared transaction is not established."],
                action: "Inspect related database writes and address a supported consistency gap, if found.",
                verification: ["Proposed: verify rollback and partial-write behavior for the selected path."],
              },
            ],
            questions: [],
            limitations: ["No source inspection or runtime reproduction has been performed."],
          },
        },
      ])
    },
    {
      write: async (input) => {
        writes++
        expect(input.system).toContain("not its full implementation plan")
        expect(input.record.findings.at(0)?.support).toBe("unresolved")
        expect(input.record.sources).toEqual([])
        expect(input.record.requirements.some((item) => item.text.includes("Transactional consistency"))).toBe(true)
        return {
          text: JSON.stringify({
            objective: "Improve transactional consistency.",
            basis: "No defect is established; inspect write invariants first.",
            changes: ["Identify and address a supported consistency gap, if found."],
            constraints: ["Preserve existing behavior outside that gap."],
            verification: ["Proposed: verify rollback and partial-write behavior."],
            evidence: [],
            requirements: input.record.requirements.map((item) => item.id),
          }),
          usage: usage("local/fixture"),
        }
      },
    },
  )
  const text = "Make the database better."
  const initial = await f.api.investigate({ key: randomUUID(), text, model })
  expect(initial.state).toBe("needs_input")
  expect(initial.calls).toBe(0)
  const answers = JSON.stringify({ ...question, option: question.options.at(0) })
  const record = await f.api.investigate({ key: randomUUID(), text, model, answers })
  expect(record.state).toBe("findings_ready")
  expect(record.questions).toEqual([])
  const direction = await f.api.chooseDirection({
    key: randomUUID(),
    investigation: record.id,
    revision: record.revision,
    selected: [record.findings.at(0)!.id],
  })
  expect(writes).toBe(0)
  const ready = await f.api.writePrompt({ key: randomUUID(), id: direction.id, revision: direction.revision })
  expect(ready.state).toBe("ready")
  expect(ready.prompt).toContain("No defect is established")
  expect(ready.prompt).toContain(answers)
  expect(f.calls.length + writes).toBe(3)
})
