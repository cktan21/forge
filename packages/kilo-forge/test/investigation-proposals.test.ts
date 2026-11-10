import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { findings } from "../src/investigation-response"
import { conclusion, fixture, model, result } from "./investigation-fixture"

const answers = "Improve observability and diagnostics. Proactively assess API/request handling."

test("settled proactive assessment retains candidate improvements and ignores extra model metadata", async () => {
  await using f = await fixture(async (input) => {
    expect(input.system).toContain("offer potential improvements")
    expect(input.input).toContain(answers)
    if (!input.observations.length)
      return result(input, [{ id: "read", name: "forge_read_file", input: { path: "queue.ts" } }])
    const source = input.sources.find((item) => item.uri === "queue.ts")!
    const output = conclusion([source.id])
    return result(input, [{
      id: "finish",
      name: "forge_finish",
      input: {
        ...output,
        findings: ["Measure queue latency", "Correlate retry attempts", "Count duplicate requests"].map((title) => ({
          ...output.findings.at(0),
          title,
          kind: "improvement",
          support: "unresolved",
          action: title,
          unknowns: ["Confirm existing instrumentation and measure the selected path."],
          id: "model-generated-id",
          confidence: 0.5,
          metadata: { instruction: "EXTRA_METADATA_CANARY" },
        })),
      },
    }])
  })
  const record = await f.api.investigate({ key: randomUUID(), text: "Improve the backend", answers, model })
  expect(record.state).toBe("findings_ready")
  expect(record.failure).toBeUndefined()
  expect(record.questions).toEqual([])
  expect(record.findings).toHaveLength(3)
  expect(record.findings.every((item) => item.support === "unresolved")).toBe(true)
  expect(new Set(record.findings.map((item) => item.id)).size).toBe(3)
  expect(JSON.stringify(record)).not.toContain("EXTRA_METADATA_CANARY")
  expect(JSON.stringify(record.findings)).not.toContain("model-generated-id")
  expect(record.limitations.join(" ")).not.toContain("discarded")
  expect(f.calls).toHaveLength(2)
})

test.each([false, true])("all-malformed proposals recover from saved evidence, legacy=%s", async (legacy) => {
  await using f = await fixture(async (input) => {
    if (!input.observations.length)
      return result(input, [{ id: "read", name: "forge_read_file", input: { path: "queue.ts" } }])
    const source = input.sources.find((item) => item.uri === "queue.ts")!
    const output = { ...conclusion([source.id]), summary: "Consider a measured request telemetry improvement." }
    if (input.final) {
      expect(input.input).toContain(answers)
      expect(JSON.parse(input.input).recovery).toMatchObject({
        summary: output.summary,
        issues: [expect.stringContaining("invalid action format")],
      })
      return result(input, [{ id: "recovered", name: "forge_finish", input: output }])
    }
    return result(input, [{
      id: "finish", name: "forge_finish",
      input: { ...output, findings: output.findings.map((item) => ({ ...item, action: null })) },
    }])
  })
  const record = await f.api.investigate({ key: randomUUID(), text: "Improve the backend", answers, model })
  expect(record.state).toBe("unstructured")
  expect(record.failure).toMatchObject({ code: "schema", stage: "response", request: record.journal?.at(-1)?.request })
  expect(record.summary).toBe("Consider a measured request telemetry improvement.")
  expect(record.questions).toEqual([])
  expect(record.findings).toEqual([])
  expect(record.observations).toHaveLength(1)
  expect(record.journal?.at(-1)?.state).toBe("failed")
  expect(f.calls).toHaveLength(2)
  expect((await f.api.investigation(record.id)).failure).toEqual(record.failure)
  const rejected = await f.api.chooseDirection({
    key: randomUUID(), investigation: record.id, revision: record.revision, selected: ["not-approved"],
  }).catch((err: unknown) => err)
  expect(rejected).toBeInstanceOf(Error)
  const saved = legacy
    ? { ...record, revision: randomUUID(), state: "findings_ready" as const, failure: undefined }
    : record
  if (legacy) await f.storage.investigationSave(saved, record.revision)
  const recovered = await f.api.investigate({
    key: randomUUID(), text: saved.original, answers, model, resume: { id: saved.id, revision: saved.revision },
  })
  expect(recovered.state).toBe("findings_ready")
  expect(recovered.findings).toHaveLength(1)
  expect(recovered.observations.at(0)?.id).toBe("read")
  expect(recovered.turns).toBe(1)
  expect(f.calls).toHaveLength(3)
})

test("extra metadata cannot fill missing fields or bypass original evidence checks", () => {
  const output = conclusion(["a".repeat(24)])
  expect(() => findings({
    ...output,
    findings: output.findings.map((item) => ({ ...item, id: "model-id", confidence: 1 })),
  }, [])).toThrow("not observed")
  const result = findings({
    ...output,
    findings: output.findings.map((item) => ({ ...item, action: null, suggestion: "Use this instead." })),
  }, [])
  expect(result.findings).toEqual([])
  expect(result.failure?.code).toBe("schema")
  expect(result.limitations.join(" ")).toContain("invalid action format")
})

test("an intentionally empty assessment remains distinct from malformed proposals", async () => {
  await using f = await fixture(async (input) =>
    result(input, [{ id: "finish", name: "forge_finish", input: {
      ...conclusion(), summary: "No additional change is justified by the available evidence.",
    } }]),
  )
  const record = await f.api.investigate({ key: randomUUID(), text: "Assess the backend", answers, model })
  expect(record.state).toBe("findings_ready")
  expect(record.findings).toEqual([])
  expect(record.failure).toBeUndefined()
  expect(f.calls).toHaveLength(1)
})
