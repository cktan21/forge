import { expect, test } from "bun:test"
import Ajv from "ajv"
import { contract, prepare, response } from "../src/preparation"
import { decode, Task } from "../src/schema"
import { amendments, diagnostic, describe, EnhancementError, guidance } from "../src/enhancement"
import { structured } from "../src/structured"

const draft = {
  objective: "Implement the requested change",
  reuse: ["Existing public API"],
  inspect: ["Locate existing tests"],
  changes: ["Extend the implementation"],
  constraints: ["Preserve existing behavior"],
  hypotheses: [],
  questions: [],
  acceptance: ["Regression tests pass"],
  verification: ["Run the existing local tests"],
  evidence: ["source-id"],
}

test("optional implementation decisions remain visible without blocking coding", () => {
  const result = prepare(
    {
      ...draft,
      questions: [
        {
          kind: "assumption",
          statement: "Place regression tests alongside existing tests",
          reason: "Follow the repository layout",
        },
        {
          kind: "assumption",
          statement: "Choose descriptive Error messages",
          reason: "The request constrains the exception type, not its text",
        },
        { kind: "inspect", action: "Read callers to check compatibility before editing" },
        {
          kind: "answered",
          statement: "Compare IDs exactly",
          basis: "The request says IDs compare exactly; do not trim valid IDs",
        },
      ],
    },
    "Add batch enqueue. IDs compare exactly; do not trim valid IDs.",
  )
  expect(result.status).toBe("ready")
  expect(result.task.questions).toEqual([])
  expect(result.task.hypotheses).toHaveLength(2)
  expect(result.task.inspect).toContain("Read callers to check compatibility before editing")
  expect(result.prompt).toContain("Implementation assumption: Place regression tests")
  expect(result.prompt).not.toContain("Blocking decisions:")
  expect(decode(Task, result.task)).toEqual(result.task)
})

for (const decision of [
  {
    question: "Which retention policy applies to customer records?",
    impact: "Permanent deletion could remove records that must be retained",
    options: ["Archive records reversibly", "Delete only under an approved retention policy"],
  },
  {
    question: "May confidential code leave this machine?",
    impact: "Hosted embeddings transmit source code to an external provider",
    options: ["Use local-only indexing", "Use an explicitly approved hosted provider"],
  },
  {
    question: "Which conflicting empty-result requirement takes precedence?",
    impact: "Returning null instead of throwing changes the public API contract",
    options: ["Return null", "Throw the specified error"],
  },
]) {
  test(`consequential decision still blocks: ${decision.question}`, () => {
    const result = prepare({ ...draft, questions: [{ kind: "blocking", ...decision }] }, "Implement the change")
    expect(result.status).toBe("needs_clarification")
    expect(result.task.questions).toHaveLength(1)
    expect(result.task.questions.at(0)).toContain(decision.impact)
    for (const option of decision.options) expect(result.prompt).toContain(option)
    expect(result.prompt).toContain("Blocking decisions:")
  })
}

test("mixed decisions preserve the true blocker instead of bypassing it", () => {
  const result = prepare(
    {
      ...draft,
      questions: [
        { kind: "assumption", statement: "Use existing test conventions", reason: "Reversible local choice" },
        {
          kind: "blocking",
          question: "Is permanent deletion authorized?",
          impact: "Records cannot be recovered",
          options: ["Retain", "Delete"],
        },
      ],
    },
    "Clean up records",
  )
  expect(result.status).toBe("needs_clarification")
  expect(result.task.questions).toHaveLength(1)
  expect(result.task.hypotheses).toHaveLength(1)
})

test("an answered decision proceeds while preserving original requirements and clarification verbatim", () => {
  const original = "Add pagination. Filter by exact actor first. limit=0 returns empty. Do not mutate events."
  const answers = "Preserve the existing ordering; choose test filenames using local conventions."
  const result = prepare(
    {
      ...draft,
      objective: "Add pagination",
      questions: [
        { kind: "answered", statement: "Keep input ordering", basis: "Developer clarification explicitly requires it" },
      ],
    },
    original,
    answers,
  )
  expect(result.status).toBe("ready")
  expect(result.prompt).toContain(`Original developer request:\n${original}`)
  expect(result.prompt).toContain(`Developer clarifications:\n${answers}`)
  expect(result.prompt).toContain("must not override them")
  expect(result.task.evidence).toEqual(draft.evidence)
})

test("complete drafts need no decision objects", () => {
  const result = prepare(draft, "Implement the fully specified change")
  expect(result.status).toBe("ready")
  expect(result.prompt).not.toContain("Developer clarifications:")
})

test("structured model hypotheses preserve their statements and reasons as typed task strings", () => {
  const original = "Improve the database, but do not delete records"
  const answers = "Focus on query latency. Keep the storage backend."
  const result = prepare({
    ...draft,
    hypotheses: ["Check existing indexes", { statement: "An index may reduce query latency", reason: "Verify against query plans before changing code" }],
    questions: [{ kind: "blocking", question: "May records leave the machine?", impact: "External processing exposes customer data", options: ["Keep processing local", "Use an explicitly approved service"] }],
  }, original, answers)
  expect(result.task.hypotheses).toEqual(["Check existing indexes", "An index may reduce query latency (Verify against query plans before changing code)"])
  expect(decode(Task, result.task)).toEqual(result.task)
  expect(result.prompt).toContain(original)
  expect(result.prompt).toContain(answers)
  expect(result.prompt).toContain("Verify against query plans before changing code")
  expect(result.status).toBe("needs_clarification")
  expect(result.questions.at(0)?.optional).toBe(false)
  expect(result.warnings).toEqual(["Converted 1 structured hypothesis to text, preserving its statement and reason."])
  expect(prepare(draft, original).warnings).toEqual([])
})

test("hypothesis conversion rejects ambiguous, incomplete, or consequential decision objects", () => {
  for (const hypotheses of [
    [{ statement: "Retain all data" }],
    [{ statement: "Retain all data", reason: null }],
    [{ statement: " ", reason: "No deletion is authorized" }],
    [{ statement: "Retain all data", reason: " " }],
    [{ statement: "Retain all data", reason: "No deletion is authorized", approval: "Delete" }],
    [{ kind: "blocking", statement: "Retain all data", reason: "No deletion is authorized" }],
    [{ hypothesis: "Retain all data", reason: "No deletion is authorized" }],
    [null],
  ]) expect(() => prepare({ ...draft, hypotheses }, "Improve storage")).toThrow("check: hypotheses")
})

test("provider response schema requires verification and classified questions", () => {
  const schema = response["~standard"].jsonSchema.output({ target: "draft-07" })
  expect(schema).toMatchObject({
    type: "object",
    required: expect.arrayContaining([...Object.keys(draft), "summary"]),
    additionalProperties: false,
    properties: {
      verification: { type: "array", items: { type: "string" } },
      hypotheses: {
        type: "array",
        items: { anyOf: [
          { type: "string" },
          { type: "object", required: ["statement", "reason"], additionalProperties: false },
        ] },
      },
      questions: { type: "array", items: { anyOf: expect.any(Array) } },
    },
  })
})

test("each provider contract contains only that revision's exact evidence IDs", async () => {
  const first = ["b521c393922fa35e857e12a0", "3d3d10737faa22aceb08c18f"]
  const schema = contract([...first, first.at(0)!])
  expect(schema["~standard"].jsonSchema.output({ target: "draft-07" })).toMatchObject({
    properties: { evidence: { type: "array", items: { enum: first } } },
  })
  for (const evidence of [[], first, [first.at(0)!]]) {
    expect((await schema["~standard"].validate({ ...draft, summary: "Preserve the requested scope", evidence })).issues).toBeUndefined()
  }
  for (const evidence of [[first.at(0)!.slice(0, -1)], ["invented-source"], ["a".repeat(24)]]) {
    expect((await schema["~standard"].validate({ ...draft, summary: "Preserve the requested scope", evidence })).issues).toBeDefined()
  }
  const next = contract(["next-revision-source"])
  expect((await next["~standard"].validate({ ...draft, summary: "Current revision only", evidence: first })).issues).toBeDefined()
  const empty = contract([])
  expect(empty["~standard"].jsonSchema.output({ target: "draft-07" })).toMatchObject({
    properties: { evidence: { type: "array", maxItems: 0 } },
  })
  expect((await empty["~standard"].validate({ ...draft, summary: "No retrieved evidence", evidence: [] })).issues).toBeUndefined()
  expect((await empty["~standard"].validate({ ...draft, summary: "No retrieved evidence", evidence: first })).issues).toBeDefined()
  expect(schema["~standard"].jsonSchema.output({ target: "draft-07" })).toMatchObject({
    properties: { evidence: { items: { enum: first } } },
  })
})

test("provider schemas avoid unsupported intersections without dropping refinement constraints", async () => {
  for (const ids of [undefined, [], ["a".repeat(24)], ["a".repeat(24), "b".repeat(24)]]) {
    const spec = contract(ids)["~standard"]
    for (const target of ["draft-07", "draft-2020-12"] as const) {
      for (const convert of [spec.jsonSchema.input, spec.jsonSchema.output]) {
        const schema = convert({ target })
        expect(JSON.stringify(schema)).not.toContain('"allOf"')
        expect(structuredClone(schema)).toMatchObject({
          properties: {
            summary: { type: "string", minLength: 1 },
            hypotheses: { items: { anyOf: [
              { type: "string" },
              { properties: { statement: { type: "string", pattern: "^[\\s\\S]*\\S[\\s\\S]*$" } } },
            ] } },
            questions: { items: { anyOf: expect.arrayContaining([
              { type: "object", properties: {
                kind: { type: "string", enum: ["blocking"] },
                question: { type: "string", minLength: 1 },
                impact: { type: "string", minLength: 1 },
                options: { type: "array", minItems: 2, items: { type: "string", minLength: 1 } },
              }, required: ["kind", "question", "impact", "options"], additionalProperties: false },
            ]) } },
          },
        })
        const validate = new Ajv({ strict: false }).compile(schema)
        const valid = { ...draft, summary: "Keep scope", evidence: ids?.slice(0, 1) ?? [] }
        for (const value of [
          valid,
          { ...valid, hypotheses: [{ statement: "Keep data", reason: "Deletion is not authorized" }] },
          { ...valid, questions: [{ kind: "blocking", question: "Delete records?", impact: "Data loss", options: ["Keep", "Delete"] }] },
          { ...valid, verification: [] },
        ]) {
          expect(validate(value)).toBe(true)
          expect((await spec.validate(value)).issues).toBeUndefined()
        }
        for (const value of [
          { ...valid, summary: "" },
          { ...valid, hypotheses: [{ statement: " ", reason: "Keep data" }] },
          { ...valid, questions: [{ kind: "blocking", question: "Delete records?", impact: "Data loss", options: ["Delete"] }] },
          { ...valid, verification: null },
          { ...valid, verification: [{}] },
          Object.fromEntries(Object.entries(valid).filter(([key]) => key !== "verification")),
          ...(ids ? [{ ...valid, evidence: ["outside-current-revision"] }] : []),
        ]) {
          expect(validate(value)).toBe(false)
          expect((await spec.validate(value)).issues).toBeDefined()
        }
        expect(validate({ ...valid, unexpected: "Do not accept extra fields" })).toBe(false)
      }
    }
  }
})

test("schema compatibility refuses ambiguous intersections instead of weakening validation", () => {
  for (const allOf of [
    [{ properties: { approval: { type: "boolean" } } }],
    [{ minLength: 1 }, { minLength: 2 }],
    [{ pattern: "a" }, { pattern: "b" }],
    [false],
    { minLength: 1 },
  ]) expect(() => structured({ type: "string", allOf })).toThrow()
  const input = { type: "string", allOf: [{ minLength: 1 }, { minLength: 1 }] }
  expect(structured(input)).toEqual({ type: "string", minLength: 1 })
  expect(input.allOf).toHaveLength(2)
})

test("missing or malformed required sections produce readable errors without inventing content", () => {
  for (const field of ["verification", "questions", "constraints", "evidence"]) {
    const missing = Object.fromEntries(Object.entries(draft).filter(([key]) => key !== field))
    for (const value of [missing, { ...draft, [field]: null }, { ...draft, [field]: "PRIVATE_MODEL_CONTENT" }]) {
      expect(() => prepare(value, "Improve the build")).toThrow(`check: ${field}`)
      expect(() => prepare(value, "Improve the build")).toThrow("Your prompt and answers were kept")
      expect(() => prepare(value, "Improve the build")).not.toThrow("SchemaError")
      expect(() => prepare(value, "Improve the build")).not.toThrow("PRIVATE_MODEL_CONTENT")
    }
  }
  expect(prepare({ ...draft, verification: [] }, "Improve the build").task.verification).toEqual([])
})

test("invalid or legacy classifications fail closed rather than silently permitting coding", () => {
  for (const questions of [
    ["Which test filename?"],
    [{ kind: "optional", question: "Which test filename?" }],
    [{ kind: "blocking", question: "Delete records?", options: ["Retain", "Delete"] }],
    [{ kind: "blocking", question: "Delete records?", impact: "Data loss", options: ["Delete"] }],
    [{ kind: "blocking", question: "Delete records?", impact: "Data loss", options: ["Delete", " Delete "] }],
    [{ kind: "blocking", question: "Delete records?", impact: "Data loss", options: ["Retain", " "] }],
    [{ kind: "blocking", question: "Delete records?", impact: " ", options: ["Retain", "Delete"] }],
    [{ kind: "assumption", statement: "Choose a test filename", reason: "" }],
    [{ kind: "answered", statement: "Delete records", basis: "" }],
    [{ kind: "inspect", action: " " }],
  ]) {
    expect(() => prepare({ ...draft, questions }, "Implement the change")).toThrow()
  }
})

test("object-valued inspect entries fail closed instead of authorizing a malformed preparation", () => {
  for (const inspect of [
    [{ action: "Read the existing implementation", reason: "Check callers" }],
    [{ path: "src/code.ts", reason: "Locate the public API" }],
    ["Read the tests", { kind: "inspect", action: "Check callers" }],
    { action: "Read the tests" },
  ]) {
    expect(() => prepare({ ...draft, inspect }, "Implement the fully specified change")).toThrow()
  }
  expect(prepare({ ...draft, inspect: ["Read the existing implementation"] }, "Implement the change").status).toBe(
    "ready",
  )
})

test("optional vague-request questions retain single-choice controls without blocking the task", () => {
  const question = { kind: "clarify", question: "Who is the audience?", impact: "The audience changes the level of explanation.", options: ["Developers", "End users", " Developers "] }
  const first = prepare({ ...draft, questions: [question] }, "Improve the guide")
  const second = prepare({ ...draft, questions: [question] }, "Improve the guide")
  expect(first.status).toBe("ready")
  expect(first.task.questions).toEqual([])
  expect(first.questions).toEqual([{
    id: second.questions.at(0)!.id, question: question.question, impact: question.impact,
    options: ["Developers", "End users"], optional: true,
  }])
  expect(prepare({ ...draft, questions: [question, question] }, "Improve the guide").questions).toHaveLength(1)
})

test("structured blocking questions remain blocking even when selection is skipped", () => {
  const result = prepare({ ...draft, questions: [{
    kind: "blocking", question: "May these records be permanently deleted?",
    impact: "Deletion cannot be undone.", options: ["Keep records", "Delete with explicit authorization"],
  }] }, "Clean up records", "The selection was skipped; no deletion was authorized.")
  expect(result.status).toBe("needs_clarification")
  expect(result.questions.at(0)?.optional).toBe(false)
  expect(result.questions.at(0)?.options).toHaveLength(2)
  expect(result.prompt).toContain("no deletion was authorized")
})

test.each([
  { name: "missing", value: undefined, path: ["verification"], expected: "array", actual: "missing" },
  { name: "null", value: null, path: ["verification"], expected: "array", actual: "null" },
  { name: "scalar", value: "PRIVATE_MODEL_TEXT", path: ["verification"], expected: "array", actual: "string" },
  { name: "object entries", value: [{ command: "PRIVATE_MODEL_TEXT", reason: "PRIVATE_REASON" }], path: ["verification", 0], expected: "string", actual: "object" },
  { name: "mixed entries", value: ["Run tests", { action: "PRIVATE_MODEL_TEXT" }], path: ["verification", 1], expected: "string", actual: "object" },
])("verification $name has safe precise diagnostics and agrees with the provider contract", async (item) => {
  const value = item.value === undefined ? Object.fromEntries(Object.entries(draft).filter(([key]) => key !== "verification")) : { ...draft, verification: item.value }
  expect((await response["~standard"].validate({ ...value, summary: "Preserve the task" })).issues).toBeDefined()
  const err = (() => {
    try { prepare(value, "Improve the build"); throw new Error("Expected rejection") }
    catch (err) { return err }
  })()
  expect(err).toBeInstanceOf(EnhancementError)
  if (!(err instanceof EnhancementError)) throw err
  expect(err.failure.issues).toContainEqual({ path: item.path, expected: item.expected, actual: item.actual })
  expect(diagnostic(err.failure)).toEqual(err.failure)
  expect(JSON.stringify(err.failure)).not.toContain("PRIVATE_")
  expect(err.message).not.toContain("PRIVATE_")
  expect(guidance(err.failure.issues)).toContain("not new developer requirements")
  expect(guidance(err.failure.issues)).toContain(describe(err.failure.issues.at(0)!))
})

test("diagnostics bound issue counts and omit arbitrary model-generated property names", () => {
  const err = (() => {
    try { prepare({ ...draft, verification: Array.from({ length: 30 }, () => ({ PRIVATE_PROPERTY: "PRIVATE_TEXT" })) }, "Build"); throw new Error("Expected rejection") }
    catch (err) { return err }
  })()
  if (!(err instanceof EnhancementError)) throw err
  expect(err.failure.issues).toHaveLength(8)
  expect(JSON.stringify(err.failure)).not.toContain("PRIVATE_")
  expect(diagnostic({ ...err.failure, private: "PRIVATE_TEXT" })).toBeUndefined()
  expect(() => guidance([{ path: ["verification"], expected: "array", actual: "missing" }, ...Array.from({ length: 8 }, () => ({ path: [] as const, expected: "object" as const, actual: "null" as const }))])).toThrow()
})

test("human edits amend prior requirements and leave untouched AI assumptions non-authoritative", () => {
  const edits = [{ before: "Include screenshots", after: "Do not include screenshots" }, { before: "", after: "Support offline usage" }]
  const result = prepare(draft, "Include screenshots. Preserve compatibility.", "Keep the public API.", edits)
  expect(result.prompt).toContain(amendments(edits))
  expect(result.prompt).toContain("replacements and removals amend earlier requirements")
  expect(result.prompt).toContain("unchanged AI notes are not requirements")
  expect(result.prompt).toContain("Support offline usage")
  expect(result.prompt).toContain("Keep the public API.")
  expect(() => amendments([{ before: "", after: "a".repeat(30_001) }])).toThrow("No edits were discarded")
})
