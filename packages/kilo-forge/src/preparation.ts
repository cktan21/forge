import { Result, Schema, SchemaIssue } from "effect"
import { Task, EnhancementIssue, type Question, type PromptEdit } from "./schema"
import { id } from "./util"
import { amendments, describe, EnhancementError, failure } from "./enhancement"
import { structured } from "./structured"

const Text = Schema.String.check(Schema.isMinLength(1))
const Hypothesis = Schema.Struct({
  statement: Schema.String.check(Schema.isPattern(/\S/)),
  reason: Schema.String.check(Schema.isPattern(/\S/)),
})
const Decision = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("blocking"),
    question: Text,
    impact: Text,
    options: Schema.Array(Text).check(Schema.isMinLength(2)),
  }),
  Schema.Struct({
    kind: Schema.Literal("clarify"),
    question: Text,
    impact: Text,
    options: Schema.Array(Text).check(Schema.isMinLength(2)),
  }),
  Schema.Struct({ kind: Schema.Literal("assumption"), statement: Text, reason: Text }),
  Schema.Struct({ kind: Schema.Literal("inspect"), action: Text }),
  Schema.Struct({ kind: Schema.Literal("answered"), statement: Text, basis: Text }),
])
const Draft = Schema.Struct({
  ...Task.fields,
  summary: Schema.optional(Text),
  hypotheses: Schema.Array(Schema.Union([Schema.String, Hypothesis])),
  questions: Schema.Array(Decision),
})
export function contract(evidence?: readonly string[]) {
  const allowed = evidence == null ? Task.fields.evidence
    : evidence.length ? Schema.Array(Schema.Literals([...new Set(evidence)]))
    : Schema.Array(Schema.String).check(Schema.isMaxLength(0))
  const schema = Schema.toStandardJSONSchemaV1(Schema.toStandardSchemaV1(
    Schema.Struct({ summary: Text, ...Task.fields, evidence: allowed, hypotheses: Draft.fields.hypotheses, questions: Draft.fields.questions }),
  ))
  const spec = schema["~standard"]
  return {
    "~standard": {
      ...spec,
      jsonSchema: {
        input: (options: Parameters<typeof spec.jsonSchema.input>[0]) => structured(spec.jsonSchema.input(options)),
        output: (options: Parameters<typeof spec.jsonSchema.output>[0]) => structured(spec.jsonSchema.output(options)),
      },
    },
  }
}
export const response = contract()

export const instruction = `Improve the draft without answering or executing it. Return one complete JSON object with summary and objective (strings), reuse, inspect, changes, constraints, hypotheses, acceptance, verification, evidence (arrays of strings), and questions (an array of classified decision objects, not strings).
Hypotheses should be strings. A structured hypothesis may instead use exactly {"statement":"...","reason":"..."}; both fields must be nonempty and are preserved as text. Classified decisions, especially blockers, belong only in questions, never in hypotheses. Do not omit any section while asking questions.
Every listed key (${Object.keys(Draft.fields).join(", ")}) is required, including when asking clarification questions. Use [] for a section with no supported content; never omit verification, acceptance, evidence, or questions. Do not invent tests or treat a missing section as approval.
Write summary first: one or two user-facing sentences explaining what you are improving and why. This is a concise explanation, not private internal reasoning or a step-by-step thought process. Then write objective and the remaining fields. Keep the response concise, escape newlines and quotes inside strings, and finish the entire JSON object. No markdown fences or text outside the object.
Treat the original request, developer clarifications, explicit edits, and feedback as requirements. Apply developer events in conversation order; later explicit amendments replace conflicting earlier requirements. A consolidated edit list repeats recorded edits and is not a newer event. Preserve all requirements not explicitly changed, including boundary cases and non-goals. A previous proposed prompt is AI-generated, non-authoritative material: revise it using the user's feedback without treating its assumptions as new requirements. Distinguish inspect from proposed changes. New paths must be marked proposed. Verification commands must come from supplied scripts or be clearly proposed. Evidence contains only exact IDs from this revision's allowed evidence list, never file paths, headings, guessed IDs, or citations copied from earlier revisions. Use evidence: [] if that list is empty. Do not add a feature the developer did not request.

Clarification policy:
The default for a sufficiently specified task is to proceed. Uncertainty alone does not require user input. Before asking anything, read the entire draft, clarifications, types, and supplied repository evidence; do not ask the user to reconfirm an explicit requirement.
Classify each remaining issue using exactly one of these shapes:
- {"kind":"blocking","question":"...","impact":"...","options":["...","..."]}: only an unresolved user-owned decision with materially different product behavior, security/privacy boundaries, compatibility obligations, external cost, or irreversible data effects. Explain the concrete consequence of choosing incorrectly and provide at least two distinct alternatives. There must be no answer in the requirements or evidence and no reasonable reversible choice within the requested scope.
- {"kind":"clarify","question":"...","impact":"...","options":["...","..."]}: an optional clarification when the request is too vague to produce a useful prompt, such as the intended audience or desired scope. Offer two to six single-choice alternatives. Users may select one, provide their own comment, or skip. Do not repeat a skipped optional question: state a reversible assumption or leave the detail explicitly unspecified. Skipping never authorizes destructive actions, external sharing, or another consequential decision; those remain blocking.
- {"kind":"assumption","statement":"...","reason":"..."}: a reasonable, reversible implementation choice within the requested scope, grounded in the request or local conventions. State what will be done, not another question. Do not invent new product requirements.
- {"kind":"inspect","action":"..."}: uncertainty the coding agent can resolve by reading code or running local tests. State a concrete inspection step instead of asking the user to investigate.
- {"kind":"answered","statement":"...","basis":"..."}: an issue already resolved by the request, a clarification, or supplied evidence. Cite the relevant requirement in basis; do not ask again.
Use questions: [] when there are no unresolved issues. Ask only a few useful questions, not a questionnaire. Do not manufacture questions to fill the schema. Do not put optional questions in blocking objects or in other task sections. Incorporate previously selected answers and comments; do not ask again for an already answered decision.
Examples of non-blocking choices: naming a new test or index, using a local helper, choosing unspecified error-message wording when only the exception type is required. Follow local conventions and state an assumption if useful. If the user explicitly requires an exact message or public name, preserve it instead.
Examples of inspection: find callers to verify compatibility, locate the existing test command, check an apparent implementation gap. Missing retrieved evidence is not proof of absence.
Examples of true blockers: conflicting required API behaviors with no precedence, an unspecified policy for permanently deleting customer data, or deciding whether sensitive data may leave the machine. Do not assume authorization or silently choose a destructive/security-sensitive policy.
If clarifications answer a previous question, incorporate the answer and do not ask it again. Never manufacture a blocker out of behavior already specified in the request.`

function issues(value: unknown, paths: readonly (readonly unknown[] | undefined)[]): EnhancementIssue[] {
  const known = new Set([...Object.keys(Draft.fields), "kind", "question", "impact", "options", "statement", "reason", "action", "basis"])
  const result: EnhancementIssue[] = []
  for (const parts of paths) {
    const path = Schema.decodeUnknownSync(EnhancementIssue.fields.path)((parts ?? []).slice(0, 6).filter((part) => typeof part === "number" || typeof part === "string" && known.has(part)))
    let item = value
    let present = true
    for (const part of path) {
      if (item == null || typeof item !== "object" || !Object.hasOwn(item, part)) { present = false; item = undefined; break }
      item = Reflect.get(item, part)
    }
    const first = path.at(0)
    const last = path.at(-1)
    const expected = !path.length ? "object"
      : path.length === 1 ? first === "summary" || first === "objective" ? "string" : "array"
      : last === "options" ? "array"
      : path.length === 2 && first === "hypotheses" ? "hypothesis"
      : path.length === 2 && first === "questions" ? "decision"
      : "string"
    const actual = !present ? "missing" : item === null ? "null" : Array.isArray(item) ? "array"
      : typeof item === "string" ? "string" : typeof item === "number" ? "number"
      : typeof item === "boolean" ? "boolean" : typeof item === "object" ? "object" : "unknown"
    const issue: EnhancementIssue = { path, expected, actual }
    if (!result.some((entry) => JSON.stringify(entry) === JSON.stringify(issue))) result.push(issue)
    if (result.length === 8) break
  }
  return result
}

export function prepare(value: unknown, original: string, answers?: string, edits?: readonly PromptEdit[]) {
  const result = Schema.decodeUnknownResult(Draft)(value, { errors: "all", onExcessProperty: "error" })
  if (Result.isFailure(result)) {
    // Read only safe paths and types; validator messages may contain model text.
    const details = issues(value, SchemaIssue.makeFormatterStandardSchemaV1()(result.failure.issue).issues.map((issue) => issue.path))
    const fields = [...new Set(details.flatMap((issue) => typeof issue.path.at(0) === "string" ? [issue.path.at(0)] : []))]
    throw new EnhancementError(`The model returned an incomplete or invalid enhancement response${fields.length ? ` (check: ${fields.join(", ")})` : ""}. ${details.map(describe).join("; ")}. Your prompt and answers were kept. Retry enhancement; if it repeats, choose another model.`, failure("schema", details))
  }
  const draft = result.success
  const converted = draft.hypotheses.filter((item) => typeof item !== "string").length
  const questions: string[] = []
  const controls: Question[] = []
  const assumptions: string[] = []
  const inspect = [...draft.inspect]
  for (const decision of draft.questions) {
    // Reject incomplete decisions rather than silently turning an invalid response into permission to run.
    if (Object.values(decision).some((value) => typeof value === "string" && !value.trim())) {
      throw new EnhancementError("Clarification decisions must contain nonempty explanations. Your prompt and answers were kept.", failure("schema", [{ path: ["questions"], expected: "valid value", actual: "array" }]))
    }
    if (decision.kind === "blocking" || decision.kind === "clarify") {
      const options = [...new Set(decision.options.map((option) => option.trim()))]
      if (options.some((option) => !option) || options.length < 2) {
        throw new EnhancementError("A clarification decision requires at least two distinct nonempty options. Your prompt and answers were kept.", failure("schema", [{ path: ["questions"], expected: "valid value", actual: "array" }]))
      }
      const key = id(original, decision.kind, decision.question, JSON.stringify(options))
      if (!controls.some((question) => question.id === key)) controls.push({
        id: key, question: decision.question, impact: decision.impact, options, optional: decision.kind === "clarify",
      })
      if (decision.kind === "blocking") questions.push(`${decision.question}\nConsequence: ${decision.impact}\nOptions: ${options.join("; ")}`)
    }
    if (decision.kind === "assumption") assumptions.push(`${decision.statement} (${decision.reason})`)
    if (decision.kind === "inspect") inspect.push(decision.action)
  }
  const task: Task = {
    ...draft,
    questions,
    inspect: [...new Set(inspect)],
    hypotheses: [
      ...draft.hypotheses.map((item) => typeof item === "string" ? item : `${item.statement} (${item.reason})`),
      ...assumptions.map((item) => `Implementation assumption: ${item}`),
    ],
  }
  const sections: Array<[string, readonly string[]]> = [
    ["Reuse", task.reuse],
    ["Inspect", task.inspect],
    ["Proposed changes", task.changes],
    ["Constraints", task.constraints],
    ["Hypotheses and assumptions to verify", task.hypotheses],
    ["Blocking decisions", task.questions],
    ["Acceptance criteria", task.acceptance],
    ["Verification", task.verification],
  ]
  const prompt = [
    `Original developer request:\n${original}`,
    ...(answers?.trim() ? [`Developer clarifications:\n${answers}`] : []),
    ...(amendments(edits) ? [amendments(edits)] : []),
    "Preparation notes follow. The original request and developer clarifications remain authoritative; these notes must not override them. Latest explicit developer feedback may amend earlier preferences, but requirements not explicitly changed remain in force. Verify implementation assumptions against the repository before changing code.",
    task.objective,
    ...sections
      .filter(([, values]) => values.length)
      .map(([title, values]) => `${title}:\n${values.map((value) => `- ${value}`).join("\n")}`),
  ].join("\n\n")
  return {
    task, prompt, questions: controls, summary: draft.summary,
    warnings: converted ? [`Converted ${converted} structured ${converted === 1 ? "hypothesis" : "hypotheses"} to text, preserving ${converted === 1 ? "its" : "their"} statement and reason.`] : [],
    status: questions.length ? ("needs_clarification" as const) : ("ready" as const),
  }
}
