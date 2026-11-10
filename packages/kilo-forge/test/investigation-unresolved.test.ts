import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { findings } from "../src/investigation-response"
import { usage } from "../src/schema"
import { conclusion, fixture, model, result } from "./investigation-fixture"

const proposal = {
  title: "Improve backend throughput",
  kind: "improvement",
  support: "unresolved",
  explanation: "The user wants better throughput without a known failure.",
  benefit: "Potentially process more concurrent requests.",
  evidence: [],
  counterevidence: [],
  unknowns: ["The limiting operation and safe concurrency level are not established."],
  action: "Increase worker concurrency.",
  verification: ["Measure throughput and errors under representative concurrent load."],
}

test.each(["defect", "improvement", "feature", "diagnostic"] as const)(
  "an unresolved %s reaches the writer as an unverified direction, not a proven fix",
  async (kind) => {
    let writes = 0
    await using f = await fixture(
      async (input) =>
        result(input, [{
          id: "finish",
          name: "forge_finish",
          input: { ...conclusion(), findings: [{ ...proposal, kind }] },
        }]),
      {
        write: async (input) => {
          writes++
          expect(input.record.findings.at(0)).toMatchObject({ kind, support: "unresolved", action: proposal.action })
          expect(input.system).toContain("Every unresolved direction")
          return {
            text: JSON.stringify({
              objective: "Improve backend throughput.",
              basis: "The user requested a throughput improvement.",
              changes: [proposal.action],
              constraints: [],
              verification: proposal.verification,
              evidence: [],
              requirements: input.record.requirements.map((item) => item.id),
            }),
            usage: usage("local/fixture"),
          }
        },
      },
    )
    const answers = "Improve throughput or concurrency. I do not yet have reproducible details."
    const record = await f.api.investigate({ key: randomUUID(), text: "Fix the backend", answers, model })
    expect(record.state).toBe("findings_ready")
    expect(record.questions).toEqual([])
    expect(record.findings).toHaveLength(1)
    expect(record.findings.at(0)).toMatchObject({ ...proposal, kind })
    expect(record.limitations.join(" ")).toContain("Unverified direction")
    expect(record.answers).toBe(answers)
    expect(f.calls).toHaveLength(1)
    const selected = await f.api.chooseDirection({
      key: randomUUID(), investigation: record.id, revision: record.revision, selected: [record.findings.at(0)!.id],
    })
    expect(writes).toBe(0)
    const ready = await f.api.writePrompt({ key: randomUUID(), id: selected.id, revision: selected.revision })
    expect(ready.state).toBe("ready")
    expect(ready.prompt).toContain("Unverified directions")
    expect(ready.prompt).toContain("Investigate and measure first")
    expect(ready.prompt).toContain(proposal.unknowns.at(0)!)
    expect(ready.prompt).toContain(answers)
    expect(ready.prompt.indexOf("Unverified directions")).toBeLessThan(ready.prompt.indexOf("Implementation brief"))
    expect(writes).toBe(1)
    expect((await f.api.preparedPrompt(ready.id)).prompt).toBe(ready.prompt)
  },
)

test("unverified directions still require real citations and a verification step", () => {
  expect(() => findings({
    ...conclusion(), findings: [{ ...proposal, evidence: ["a".repeat(24)] }],
  }, [])).toThrow("not observed")
  expect(() => findings({
    ...conclusion(), findings: [{ ...proposal, verification: [] }],
  }, [])).toThrow("verification step")
})
