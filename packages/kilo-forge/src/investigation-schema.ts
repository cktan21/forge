import { Effect, Schema } from "effect"
import { ActivityLog, EnhancementFailure, EnhancementModel, PromptEdit, Source, Usage } from "./schema"
import { Clarification } from "./clarification"

const Text = Schema.String.check(Schema.isPattern(/\S/), Schema.isMaxLength(4000))
const Key = Schema.String.check(Schema.isPattern(/^[a-f0-9-]{36}$/))
const IDs = Schema.Array(Schema.String.check(Schema.isPattern(/^[a-f0-9]{24}$/))).check(Schema.isMaxLength(24))
const Statements = Schema.Array(Text).check(Schema.isMaxLength(12))
const Count = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))

export const unverified =
  "Unverified direction: treat its cause, proposed change, and benefit as unproven. Investigate and measure first; implement only changes supported by evidence and the user's stated goal."

export const Candidate = Schema.Struct({
  title: Text,
  kind: Schema.Literals(["defect", "improvement", "feature", "diagnostic"]),
  support: Schema.Literals(["observed", "inferred", "unresolved", "contradicted"]),
  explanation: Text,
  benefit: Text,
  evidence: IDs,
  counterevidence: IDs,
  unknowns: Statements,
  action: Text,
  verification: Statements,
})
export const Finding = Schema.Struct({ id: Schema.String, ...Candidate.fields })
export type Finding = typeof Finding.Type
export const Conclusion = Schema.Struct({
  intent: Text,
  summary: Text,
  findings: Schema.Array(Candidate).check(Schema.isMaxLength(5)),
  questions: Schema.Array(Clarification)
    .annotate({
      description:
        "Return a concise branching questionnaire in one response. Put parents before children; use when to tie follow-ups to exact options of earlier questions. Ask only what is missing, with no fixed question quota. All applicable answers are collected locally before investigation resumes.",
    })
    .check(Schema.isMaxLength(12)),
  limitations: Statements,
})

// Clarification remains blocking when a model omits the optional flag.
export const Response = Schema.Struct({
  ...Conclusion.fields,
  findings: Schema.Array(Schema.Unknown).check(Schema.isMaxLength(5)),
  questions: Schema.Array(
    Schema.Struct({
      ...Clarification.fields,
      optional: Clarification.fields.optional.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
    }),
  ).check(Schema.isMaxLength(12)),
})

const Purpose = Schema.optionalKey(
  Schema.String.annotate({
    description:
      "One brief public sentence explaining the purpose of this inspection. No private reasoning or chain-of-thought.",
  }).check(Schema.isMaxLength(500)),
)
export const actions = {
  forge_search_code: Schema.Struct({ query: Text, purpose: Purpose }),
  forge_search_docs: Schema.Struct({ query: Text, dependency: Schema.optional(Schema.String), purpose: Purpose }),
  forge_lookup: Schema.Struct({
    path: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
    text: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
    purpose: Purpose,
  }),
  forge_read_file: Schema.Struct({
    path: Text,
    start: Schema.optional(Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 1_000_000 }))),
    lines: Schema.optional(Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 160 }))),
    purpose: Purpose,
  }),
  forge_get_symbol: Schema.Struct({ id: Text, purpose: Purpose }),
  forge_relationships: Schema.Struct({ id: Text, purpose: Purpose }),
  forge_finish: Conclusion,
}
export const Action = Schema.Literals([
  "forge_search_code",
  "forge_search_docs",
  "forge_lookup",
  "forge_read_file",
  "forge_get_symbol",
  "forge_relationships",
  "forge_finish",
])
export type Action = typeof Action.Type
export type Call = { id: string; name: Action; input: unknown }
export const Observation = Schema.Struct({
  id: Schema.String,
  turn: Schema.optional(Count),
  tool: Action,
  input: Schema.Unknown,
  output: Schema.String,
  sources: Schema.Array(Source).check(Schema.isMaxLength(100)),
  observed: Count,
  rejected: Schema.optional(Schema.Boolean),
})
export type Observation = typeof Observation.Type
const Inspection = Schema.Struct({
  id: Schema.String,
  tool: Schema.String,
  input: Schema.String.check(Schema.isMaxLength(1000)),
  state: Schema.Literals(["requested", "running", "complete", "skipped", "discarded", "failed"]),
  activity: Schema.optional(ActivityLog),
})
export const Round = Schema.Struct({
  request: Key,
  number: Count,
  final: Schema.Boolean,
  state: Schema.Literals(["model", "tools", "complete", "limited", "failed", "cancelled"]),
  started: Count,
  updated: Count,
  summary: Schema.String,
  note: Schema.optional(Schema.String.check(Schema.isMaxLength(2000))),
  usage: Schema.optional(Usage),
  reasoning: Schema.optional(Count),
  bytes: Schema.optional(Count),
  included: Schema.Array(Schema.String).check(Schema.isMaxLength(24)),
  omitted: Schema.Array(Schema.String).check(Schema.isMaxLength(24)),
  requested: Count,
  inspections: Schema.Array(Inspection).check(Schema.isMaxLength(24)),
})
export type Round = typeof Round.Type
const Journal = Schema.Array(Round).check(Schema.isMaxLength(12))
export const Previous = Schema.Struct({ id: Key, revision: Key, session: Schema.optional(Schema.String) })
export const Resume = Schema.Struct({ id: Key, revision: Key })
export const InvestigationInput = Schema.Struct({
  key: Key,
  text: Schema.String.check(Schema.isPattern(/\S/), Schema.isMaxLength(30_000)),
  session: Schema.optional(Schema.String),
  model: Schema.optional(EnhancementModel),
  answers: Schema.optional(Schema.String.check(Schema.isMaxLength(30_000))),
  feedback: Schema.optional(Schema.String.check(Schema.isMaxLength(30_000))),
  previous: Schema.optional(Previous),
  resume: Schema.optional(Resume),
})
export type InvestigationInput = typeof InvestigationInput.Type
export const Investigation = Schema.Struct({
  version: Schema.Literal(1),
  id: Key,
  revision: Key,
  digest: Schema.String,
  root: Schema.String,
  session: Schema.String,
  original: Schema.String,
  answers: Schema.String,
  feedback: Schema.String,
  previous: Schema.optional(Previous),
  resume: Schema.optional(Resume),
  edits: Schema.optional(Schema.Array(PromptEdit).check(Schema.isMaxLength(100))),
  dependencies: Schema.optional(Schema.Array(Source)),
  model: EnhancementModel,
  destination: Schema.String,
  policy: Schema.String,
  state: Schema.Literals([
    "investigating",
    "findings_ready",
    "needs_input",
    "unstructured",
    "limited",
    "failed",
    "cancelled",
    "interrupted",
  ]),
  failure: Schema.optional(EnhancementFailure),
  intent: Schema.String,
  summary: Schema.String,
  findings: Schema.Array(Finding).check(Schema.isMaxLength(5)),
  questions: Schema.Array(Clarification).check(Schema.isMaxLength(12)),
  limitations: Schema.Array(Schema.String),
  observations: Schema.Array(Observation).check(Schema.isMaxLength(24)),
  journal: Schema.optional(Journal),
  turns: Count,
  calls: Count,
  bytes: Count,
  started: Count,
  updated: Count,
  usage: Usage,
})
export type Investigation = typeof Investigation.Type

export function recoverable(value: Investigation) {
  if (value.state === "unstructured") return true
  if (value.state === "failed") return ["schema", "json", "cutoff"].includes(value.failure?.code ?? "")
  // Older records incorrectly marked an all-discarded response as findings_ready.
  return value.state === "findings_ready" && !value.findings.length && !value.questions.length
    && value.limitations.some((item) => /^Model proposal \d+ was discarded: invalid /.test(item))
}

export const InvestigationProgress = Schema.Struct({
  type: Schema.Literal("progress"),
  stage: Schema.String,
  turns: Count,
  calls: Count,
  started: Schema.optional(Count),
  elapsed: Schema.optional(Count),
  request: Schema.optional(Key),
  journal: Schema.optional(Journal),
  observations: Schema.optional(Schema.Array(Observation).check(Schema.isMaxLength(24))),
})
export type InvestigationProgress = typeof InvestigationProgress.Type
export const InvestigationFrame = Schema.Union([
  InvestigationProgress,
  Schema.Struct({ type: Schema.Literal("result"), investigation: Investigation }),
  Schema.Struct({
    type: Schema.Literal("error"),
    message: Schema.String,
    failure: Schema.optional(EnhancementFailure),
  }),
])
export type InvestigationFrame = typeof InvestigationFrame.Type

export const limits = {
  turns: 12,
  calls: 24,
  evidence: 48_000,
  ledger: 512_000,
  request: 96_000,
  cumulative: 384_000,
  output: 12000,
  time: 180_000,
} as const
