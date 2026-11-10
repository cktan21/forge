import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { followup, replies, visible } from "../src/clarification"
import { findings } from "../src/investigation-response"
import { conclusion, fixture, model, result } from "./investigation-fixture"

const target = {
  id: "target",
  question: "Which backend?",
  impact: "Choose the subsystem.",
  options: ["OpenCode HTTP/CLI", "VS Code backend"],
  optional: false,
}
const answer = JSON.stringify({ ...target, option: "OpenCode HTTP/CLI", comment: "", skipped: false })
const detail = {
  id: "operation",
  question: "Which HTTP request fails?",
  impact: "Narrow the selected HTTP server.",
  options: ["Session creation", "Streaming responses"],
  optional: false,
  when: { question: "target", options: ["OpenCode HTTP/CLI"] },
}

test("answered questions are recognized by their text, not reusable model IDs", () => {
  expect(followup([{ ...target, question: " WHICH   BACKEND? " }, detail], answer).questions).toEqual([
    { ...detail, when: null },
  ])
  expect(followup([{ ...target, question: detail.question }], answer).questions).toEqual([
    { ...target, question: detail.question },
  ])
  expect(
    replies(`${answer}\nnot JSON\n{broken\n${JSON.stringify({ ...target, option: "VS Code backend" })}`),
  ).toMatchObject([{ question: "Which backend?", option: "VS Code backend" }])
  expect(followup([target], JSON.stringify({ ...target, option: null, skipped: true })).questions).toEqual([target])
})

test("a clarification result retains a batch and resolves already answered parents", async () => {
  await using f = await fixture(async (input) => {
    expect(input.input).toContain("OpenCode HTTP/CLI")
    expect(input.system).toContain("locally branching questionnaire")
    return result(input, [
      {
        id: "finish",
        name: "forge_finish",
        input: {
          ...conclusion(),
          questions: [target, detail, { ...detail, id: "environment", question: "Which environment?" }],
        },
      },
    ])
  })
  const record = await f.api.investigate({ key: randomUUID(), text: "Fix the backend", answers: answer, model })
  expect(record.state).toBe("needs_input")
  expect(record.questions).toEqual([
    { ...detail, when: null },
    { ...detail, id: "environment", question: "Which environment?", when: null },
  ])
  expect(record.answers).toBe(answer)
  expect(f.calls).toHaveLength(1)
})

test("nested branches are visible only along the selected path", () => {
  const nested = { ...detail, id: "timing", when: { question: detail.id, options: ["Streaming responses"] } }
  const vscode = { ...detail, id: "vscode", when: { question: target.id, options: ["VS Code backend"] } }
  const questions = [target, detail, nested, vscode]
  expect(visible(questions, {})).toEqual([target])
  expect(visible(questions, { target: { option: "OpenCode HTTP/CLI" } })).toEqual([target, detail])
  expect(
    visible(questions, { target: { option: "OpenCode HTTP/CLI" }, operation: { option: "Streaming responses" } }),
  ).toEqual([target, detail, nested])
  expect(
    visible(questions, { target: { option: "VS Code backend" }, operation: { option: "Streaming responses" } }),
  ).toEqual([target, vscode])
  expect(visible(questions, { target: {} })).toEqual([target])
  expect(followup(questions, answer).questions).toEqual([{ ...detail, when: null }, nested])
})

test.each([
  { question: "missing", options: ["OpenCode HTTP/CLI"] },
  { question: "operation", options: ["Session creation"] },
  { question: "target", options: ["Not an offered option"] },
])("invalid branch condition %j is rejected before display", (when) => {
  expect(() => findings({ ...conclusion(), questions: [target, { ...detail, when }] }, [])).toThrow(
    "conditions must reference an earlier question",
  )
})

test("question IDs are unique within a batch and older unconditional batches still decode", () => {
  expect(() => findings({ ...conclusion(), questions: [target, target] }, [])).toThrow("unique IDs")
  const { optional, ...legacy } = target
  expect(optional).toBe(false)
  expect(findings({ ...conclusion(), questions: [legacy] }, []).questions).toEqual([target])
  const questions = [{ ...target, when: null }, detail]
  expect(findings({ ...conclusion(), questions }, []).questions).toEqual(questions)
  expect(visible(questions, {})).toEqual([{ ...target, when: null }])
})

test("all conditional questions survive persistence without an extra model call", async () => {
  await using f = await fixture(async (input) =>
    result(input, [{ id: "finish", name: "forge_finish", input: { ...conclusion(), questions: [target, detail] } }]),
  )
  const record = await f.api.investigate({ key: randomUUID(), text: "Fix the backend", model })
  expect(record.questions).toEqual([target, detail])
  expect(record.state).toBe("needs_input")
  expect((await f.api.investigation(record.id, record.session)).questions).toEqual(record.questions)
  expect(f.calls).toHaveLength(1)
})

test("a model repeating only an answered question does not send the user through it again", async () => {
  await using f = await fixture(async (input) =>
    result(input, [
      {
        id: "finish",
        name: "forge_finish",
        input: { ...conclusion(), questions: [target] },
      },
    ]),
  )
  const record = await f.api.investigate({ key: randomUUID(), text: "Fix the backend", answers: answer, model })
  expect(record.state).toBe("unstructured")
  expect(record.questions).toEqual([])
  expect(record.findings).toEqual([])
  expect(record.summary).toContain("already answered")
  expect(f.calls).toHaveLength(1)
})
