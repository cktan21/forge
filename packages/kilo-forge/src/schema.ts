import { Schema } from "effect"

export const EmbeddingTarget = Schema.Struct({
  fingerprint: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
  model: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  dimensions: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 4096 })),
})
export const EmbeddingReview = Schema.Struct({
  endpoint: Schema.String,
  target: EmbeddingTarget,
  revision: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  approved: Schema.Boolean,
})
const EmbeddingCount = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
export const EmbeddingUsage = Schema.Struct({
  attempts: EmbeddingCount,
  inputs: EmbeddingCount,
  bytes: EmbeddingCount,
  responses: EmbeddingCount,
  failed: EmbeddingCount,
  pending: EmbeddingCount,
  promptTokens: EmbeddingCount,
  promptReports: EmbeddingCount,
  totalTokens: EmbeddingCount,
  totalReports: EmbeddingCount,
})
export type EmbeddingUsage = typeof EmbeddingUsage.Type
export const EmbeddingAttempt = Schema.Struct({
  id: Schema.String,
  session: Schema.String,
  collections: Schema.Array(Schema.String),
  target: EmbeddingTarget,
  purpose: Schema.Literals(["query", "index", "job"]),
  started: EmbeddingCount,
  finished: Schema.optional(EmbeddingCount),
  usage: EmbeddingUsage,
})
export type EmbeddingAttempt = typeof EmbeddingAttempt.Type
export const EmbeddingObservation = Schema.Struct({
  revision: Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/)),
  since: EmbeddingCount,
  before: Schema.Literal("unknown"),
  deleted: Schema.Boolean,
})
export const EmbeddingLedger = Schema.Struct({
  session: Schema.String,
  entries: Schema.Array(EmbeddingAttempt),
  next: Schema.optional(Schema.String),
  observation: Schema.optional(EmbeddingObservation),
})
export type EmbeddingLedger = typeof EmbeddingLedger.Type
export const EmbeddingRetention = Schema.Struct({
  session: Schema.String,
  before: EmbeddingCount,
  keep: EmbeddingCount,
  selected: EmbeddingCount,
  limit: Schema.Literal(100),
  more: Schema.Boolean,
  revision: Schema.String,
  observation: EmbeddingObservation,
})
export const EmbeddingResult = Schema.Struct({ sections: EmbeddingCount, embedded: EmbeddingCount, reused: EmbeddingCount })
export const EmbeddingCoverage = Schema.Struct({
  collection: Schema.String,
  session: Schema.String,
  target: EmbeddingTarget,
  started: EmbeddingCount,
  finished: EmbeddingCount,
  sections: EmbeddingCount,
  reusable: EmbeddingCount,
  missing: EmbeddingCount,
  outdated: EmbeddingCount,
  stale: EmbeddingCount,
  excluded: EmbeddingCount,
})
export type EmbeddingCoverage = typeof EmbeddingCoverage.Type
export const EmbeddingApproval = Schema.Struct({ approved: Schema.Literal(true) })
export const EmbeddingRevocation = Schema.Struct({ revoked: Schema.Literal(true) })
export const EmbeddingProgress = Schema.Struct({
  phase: Schema.Literals(["queued", "checking", "embedding", "publishing", "validating"]),
  sections: Schema.optional(EmbeddingCount),
  processed: EmbeddingCount,
  embedded: EmbeddingCount,
  reused: EmbeddingCount,
})
export type EmbeddingProgress = typeof EmbeddingProgress.Type
export const EmbeddingJob = Schema.Struct({
  id: Schema.String,
  collection: Schema.String,
  session: Schema.String,
  revision: Schema.String,
  target: EmbeddingTarget,
  state: Schema.Literals(["queued", "running", "completed", "failed", "cancelled", "interrupted"]),
  started: EmbeddingCount,
  updated: EmbeddingCount,
  progressed: EmbeddingCount,
  finished: Schema.optional(EmbeddingCount),
  progress: EmbeddingProgress,
  usage: Schema.optional(EmbeddingUsage),
  result: Schema.optional(EmbeddingResult),
  error: Schema.optional(Schema.String),
})
export type EmbeddingJob = typeof EmbeddingJob.Type
export const EmbeddingJobs = Schema.Array(EmbeddingJob)

export const Kind = Schema.Literals([
  "agent", "directory", "code", "symbol", "test", "document", "dependency", "schema", "configuration",
  "instruction", "goal", "memory", "history", "tool", "attachment", "summary", "opportunity",
])
export const Source = Schema.Struct({
  id: Schema.String,
  kind: Kind,
  label: Schema.String,
  uri: Schema.String,
  hash: Schema.String,
  text: Schema.String,
  start: Schema.Finite,
  end: Schema.Finite,
  observed: Schema.Finite,
  method: Schema.String,
  status: Schema.Literals(["current", "stale", "unavailable"]),
  inferred: Schema.Boolean,
  evidence: Schema.Array(Schema.String),
  detail: Schema.Record(Schema.String, Schema.String),
})
export type Source = typeof Source.Type

export const Relation = Schema.Struct({
  id: Schema.String,
  from: Schema.String,
  to: Schema.String,
  kind: Schema.String,
  inferred: Schema.Boolean,
  evidence: Schema.Array(Schema.String),
  reason: Schema.String,
})
export type Relation = typeof Relation.Type

export const Snapshot = Schema.Struct({
  root: Schema.String,
  revision: Schema.String,
  generation: Schema.String,
  observed: Schema.Finite,
  sources: Schema.Array(Source),
  relations: Schema.Array(Relation),
  warnings: Schema.Array(Schema.String),
  partial: Schema.Boolean,
  files: Schema.Finite,
})
export type Snapshot = typeof Snapshot.Type

export const Page = Schema.Struct({
  offset: Schema.Finite,
  limit: Schema.Finite,
  next: Schema.optional(Schema.Finite),
  total: Schema.optional(Schema.Finite),
})
export const View = Schema.Struct({
  ...Snapshot.fields,
  page: Page,
  categories: Schema.optional(Schema.Record(Schema.String, Schema.Finite)),
})
export type View = typeof View.Type

export const Match = Schema.Struct({ source: Source, score: Schema.Finite, reason: Schema.String })
export type Match = typeof Match.Type
export const Semantic = Schema.Struct({
  state: Schema.Literals(["uninitialized", "initializing", "disabled", "indexing", "ready", "paused", "error", "unknown"]),
  searchable: Schema.optional(Schema.Boolean),
})
export type Semantic = typeof Semantic.Type
export const RetrievalChannel = Schema.Struct({
  name: Schema.Literals(["keyword", "semantic", "collection-semantic", "domains", "memory", "relationships", "public-docs", "dependency-docs"]),
  state: Schema.Literals(["completed", "fallback", "disabled", "unavailable", "failed"]),
  candidates: Schema.Finite,
  withheld: Schema.Finite,
  readiness: Schema.optional(Semantic),
})
export type RetrievalChannel = typeof RetrievalChannel.Type
export const RetrievalRun = Schema.Struct({
  started: Schema.Finite,
  updated: Schema.Finite,
  generation: Schema.optional(Schema.String),
  finished: Schema.optional(Schema.Finite),
  state: Schema.Literals(["running", "completed", "failed", "cancelled"]),
  phase: Schema.Literals(["setup", "channels", "selection"]),
  channels: Schema.Array(Schema.Struct({
    name: RetrievalChannel.fields.name,
    state: Schema.Literals(["pending", "running", "completed", "fallback", "disabled", "unavailable", "failed", "abandoned"]),
    started: Schema.optional(Schema.Finite),
    finished: Schema.optional(Schema.Finite),
  })),
})
export type RetrievalRun = typeof RetrievalRun.Type

export const SelectionInfo = Schema.Struct({
  candidates: Schema.Array(Schema.Struct({
    source: Schema.String,
    hash: Schema.String,
    retrieval: Schema.String,
    score: Schema.Finite,
    state: Schema.Literals(["selected", "omitted"]),
    reason: Schema.String,
    channels: Schema.optional(Schema.Array(Schema.Struct({
      name: RetrievalChannel.fields.name,
      rank: Schema.Finite,
      score: Schema.Finite,
      reason: Schema.String,
    }))),
  })),
  channels: Schema.optional(Schema.Array(RetrievalChannel)),
  total: Schema.Finite,
  unrecorded: Schema.Finite,
  withheld: Schema.Finite,
  budget: Schema.Finite,
  tokens: Schema.Finite,
  estimator: Schema.String,
  policy: Schema.optional(Schema.String),
  provider: Schema.optional(Schema.String),
  destination: Schema.optional(Schema.String),
})
export type SelectionInfo = typeof SelectionInfo.Type
export const Selection = Schema.Struct({
  matches: Schema.Array(Match),
  text: Schema.String,
  tokens: Schema.Finite,
  budget: Schema.Finite,
  estimator: Schema.String,
  omitted: Schema.Array(Schema.String),
  reasons: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  provider: Schema.optional(Schema.String),
  destination: Schema.optional(Schema.String),
  policy: Schema.optional(Schema.String),
  audit: Schema.optional(SelectionInfo),
})
export type Selection = typeof Selection.Type

export const Usage = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  cached: Schema.Finite,
  milliseconds: Schema.Finite,
  model: Schema.String,
  measured: Schema.Boolean,
})
export type Usage = typeof Usage.Type

export const EnhancementModel = Schema.Struct({
  providerID: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  modelID: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
})
export type EnhancementModel = typeof EnhancementModel.Type
export const PromptEdit = Schema.Struct({
  before: Schema.String.check(Schema.isMaxLength(100_000)),
  after: Schema.String.check(Schema.isMaxLength(100_000)),
})
export type PromptEdit = typeof PromptEdit.Type
const Field = Schema.Literals(["summary", "objective", "reuse", "inspect", "changes", "constraints", "hypotheses", "acceptance", "verification", "evidence", "questions", "kind", "question", "impact", "options", "statement", "reason", "action", "basis"])
const Shape = Schema.Literals(["missing", "null", "string", "number", "boolean", "array", "object", "unknown"])
export const EnhancementIssue = Schema.Struct({
  path: Schema.Array(Schema.Union([Field, Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))])).check(Schema.isMaxLength(6)),
  expected: Schema.Literals(["string", "array", "object", "hypothesis", "decision", "valid value"]),
  actual: Shape,
})
export type EnhancementIssue = typeof EnhancementIssue.Type
export const EnhancementFailure = Schema.Struct({
  code: Schema.Literals(["schema", "json", "cutoff", "citation", "transport", "timeout", "cancelled"]),
  schema: Schema.Literal("forge-enhancement-v2"),
  issues: Schema.Array(EnhancementIssue).check(Schema.isMaxLength(8)),
  request: Schema.optional(Schema.String.check(Schema.isMaxLength(128))),
  stage: Schema.optional(Schema.Literals(["setup", "model", "response", "inspection", "validation", "persistence"])),
  model: Schema.optional(Schema.String.check(Schema.isMaxLength(512))),
  status: Schema.optional(Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 100, maximum: 599 }))),
  reason: Schema.optional(Schema.Literals(["request-schema", "unsupported-format", "authentication", "permission", "credits", "rate-limit", "context-limit", "unavailable", "invalid-request", "network", "source-changed", "policy-changed", "storage", "accounting", "unknown"])),
  finish: Schema.optional(Schema.Literals(["stop", "length", "content-filter", "tool-calls", "error", "other", "unknown"])),
  usage: Schema.optional(Usage),
})
export type EnhancementFailure = typeof EnhancementFailure.Type
export const EnhancementInput = Schema.Struct({
  text: Schema.String.check(Schema.isMaxLength(30_000)),
  answers: Schema.optional(Schema.String.check(Schema.isMaxLength(30_000))),
  feedback: Schema.optional(Schema.String.check(Schema.isMaxLength(30_000))),
  revision: Schema.optional(Schema.String.check(Schema.isMaxLength(100_000))),
  edits: Schema.optional(Schema.Array(PromptEdit).check(Schema.isMaxLength(100))),
  model: Schema.optional(EnhancementModel),
  retry: Schema.optional(Schema.Array(EnhancementIssue).check(Schema.isMaxLength(8))),
  session: Schema.optional(Schema.String),
  pin: Schema.optional(Schema.Array(Schema.String)),
  exclude: Schema.optional(Schema.Array(Schema.String)),
})
export type EnhancementInput = typeof EnhancementInput.Type

export const Opportunity = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  goal: Schema.String,
  benefit: Schema.String,
  evidence: Schema.Array(Schema.String),
  counterevidence: Schema.Array(Schema.String),
  uncertainty: Schema.String,
  verification: Schema.String,
  prompt: Schema.String,
  status: Schema.Literals(["proposed", "confirmed", "rejected", "superseded", "stale"]),
  generation: Schema.String,
  observed: Schema.Finite,
})
export type Opportunity = typeof Opportunity.Type

export const Task = Schema.Struct({
  objective: Schema.String,
  reuse: Schema.Array(Schema.String),
  inspect: Schema.Array(Schema.String),
  changes: Schema.Array(Schema.String),
  constraints: Schema.Array(Schema.String),
  hypotheses: Schema.Array(Schema.String),
  questions: Schema.Array(Schema.String),
  acceptance: Schema.Array(Schema.String),
  verification: Schema.Array(Schema.String),
  evidence: Schema.Array(Schema.String),
})
export type Task = typeof Task.Type

export const Question = Schema.Struct({
  id: Schema.String,
  question: Schema.String,
  impact: Schema.String,
  options: Schema.Array(Schema.String),
  optional: Schema.Boolean,
})
export type Question = typeof Question.Type

export const Activity = Schema.Struct({
  action: Schema.String,
  path: Schema.optional(Schema.String),
  detail: Schema.String,
})
export type Activity = typeof Activity.Type
export const ActivityLog = Schema.Struct({
  entries: Schema.Array(Activity).check(Schema.isMaxLength(100)),
  counts: Schema.optional(Schema.Record(Schema.String, Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)))),
  total: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
})
export type ActivityLog = typeof ActivityLog.Type

export const Proposal = Schema.Struct({
  id: Schema.String,
  original: Schema.String,
  generation: Schema.String,
  status: Schema.Literals(["ready", "needs_clarification"]),
  task: Task,
  context: Selection,
  prompt: Schema.String,
  usage: Usage,
  warnings: Schema.Array(Schema.String),
  questions: Schema.optional(Schema.Array(Question)),
  session: Schema.optional(Schema.String),
  summary: Schema.optional(Schema.String),
  activity: Schema.optional(ActivityLog),
  model: Schema.optional(EnhancementModel),
})
export type Proposal = typeof Proposal.Type

export const EnhancementProgress = Schema.Struct({
  type: Schema.Literal("progress"),
  stage: Schema.String,
  summary: Schema.optional(Schema.String.check(Schema.isMaxLength(2000))),
  preview: Schema.optional(Schema.String.check(Schema.isMaxLength(12000))),
  activity: Schema.optional(ActivityLog),
})
export type EnhancementProgress = typeof EnhancementProgress.Type
export const EnhancementFrame = Schema.Union([
  EnhancementProgress,
  Schema.Struct({ type: Schema.Literal("result"), proposal: Proposal }),
  Schema.Struct({ type: Schema.Literal("error"), message: Schema.String, failure: Schema.optional(EnhancementFailure) }),
])
export type EnhancementFrame = typeof EnhancementFrame.Type

export const Entry = Schema.Struct({
  source: Schema.String,
  kind: Schema.optional(Kind),
  label: Schema.optional(Schema.String),
  uri: Schema.optional(Schema.String),
  hash: Schema.String,
  text: Schema.String,
  stage: Schema.Literals(["retrieved", "selected", "assembled", "sent", "summarized", "pruned"]),
  tokens: Schema.Finite,
})
export type Entry = typeof Entry.Type
const ModelCount = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))
export const ModelUsage = Schema.Struct({
  format: Schema.Literals(["openai-chat", "openai-responses"]),
  input: Schema.optional(ModelCount),
  output: Schema.optional(ModelCount),
  total: Schema.optional(ModelCount),
  cached: Schema.optional(ModelCount),
  reasoning: Schema.optional(ModelCount),
  invalid: Schema.optional(Schema.Boolean),
})
export type ModelUsage = typeof ModelUsage.Type
export const ModelResponse = Schema.Struct({
  state: Schema.Literals(["pending", "completed", "cancelled", "error", "limited", "unsupported"]),
  bytes: ModelCount,
  usage: Schema.optional(ModelUsage),
})
export type ModelResponse = typeof ModelResponse.Type
export const RequestObservation = Schema.Struct({
  revision: Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/)),
  since: ModelCount,
  before: Schema.Literal("unknown"),
  deleted: Schema.Boolean,
  admitted: ModelCount,
})
export type RequestObservation = typeof RequestObservation.Type
export const Attempt = Schema.Struct({
  id: Schema.String,
  sequence: Schema.Finite,
  started: Schema.Finite,
  finished: Schema.optional(Schema.Finite),
  state: Schema.Literals(["pending", "response", "blocked", "error"]),
  status: Schema.optional(Schema.Finite),
  hash: Schema.optional(Schema.String),
  sent: Schema.Array(Schema.String),
  membership: Schema.Literals(["unknown", "matched"]),
  response: Schema.optional(ModelResponse),
})
export type Attempt = typeof Attempt.Type
export const Manifest = Schema.Struct({
  id: Schema.String,
  operation: Schema.optional(Schema.String),
  selection: Schema.optional(SelectionInfo),
  retrieval: Schema.optional(RetrievalRun),
  preparation: Schema.optional(Schema.String),
  lookup: Schema.optional(Schema.Struct({
    tool: Schema.String,
    call: Schema.optional(Schema.String),
    message: Schema.optional(Schema.String),
    query: Schema.String,
  })),
  lookups: Schema.optional(Schema.Array(Schema.String)),
  attempts: Schema.optional(Schema.Array(Attempt)),
  discarded: Schema.optional(Schema.Finite),
  session: Schema.String,
  root: Schema.String,
  generation: Schema.String,
  purpose: Schema.String,
  model: Schema.String,
  observed: Schema.Finite,
  entries: Schema.Array(Entry),
  coverage: Schema.Array(Schema.String),
  usage: Usage,
  state: Schema.Literals(["retrieving", "assembled", "sent", "completed", "failed"]),
  failure: Schema.optional(EnhancementFailure),
  finish: EnhancementFailure.fields.finish,
})
export type Manifest = typeof Manifest.Type

export const Inventory = Schema.Struct({
  root: Schema.String,
  generation: Schema.String,
  revision: Schema.String,
  observed: Schema.Finite,
  files: Schema.Finite,
  partial: Schema.Boolean,
  indexed: Schema.Boolean,
  counts: Schema.Record(Schema.String, Schema.Finite),
  warnings: Schema.Array(Schema.String),
})
export type Inventory = typeof Inventory.Type

export const RequestInfo = Schema.Struct({
  id: Schema.String,
  revision: Schema.optional(Schema.String),
  session: Schema.String,
  purpose: Schema.String,
  model: Schema.String,
  observed: Schema.Finite,
  state: Manifest.fields.state,
  entries: Schema.Finite,
  sent: Schema.Finite,
  usage: Usage,
})
export type RequestInfo = typeof RequestInfo.Type

export const Job = Schema.Struct({
  id: Schema.String,
  state: Schema.Literals(["idle", "running", "completed", "failed", "cancelled"]),
  started: Schema.Finite,
  updated: Schema.Finite,
  message: Schema.String,
})
export type Job = typeof Job.Type

export const Change = Schema.Struct({
  topic: Schema.Literals(["knowledge", "policy", "request", "job", "invalidate"]),
  session: Schema.String,
  revision: Schema.String,
})
export type Change = typeof Change.Type

export const Destination = Schema.Struct({
  fingerprint: Schema.String,
  origins: Schema.Array(Schema.String),
})
export type Destination = typeof Destination.Type

export const Collection = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  kind: Schema.Literals(["file", "folder", "text", "url", "upload"]),
  location: Schema.String,
  session: Schema.String,
  origin: Schema.Literals(["interface", "config"]),
  include: Schema.Array(Schema.String),
  exclude: Schema.Array(Schema.String),
  watch: Schema.Boolean,
  approved: Schema.Boolean,
  providers: Schema.Array(Schema.String),
  grants: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  state: Schema.Literals(["registered", "indexing", "ready", "failed", "paused", "removed"]),
  observed: Schema.Finite,
  generation: Schema.String,
  files: Schema.Finite,
  chunks: Schema.Finite,
  warnings: Schema.Array(Schema.String),
  progress: Schema.optional(Schema.Struct({
    stage: Schema.Literals(["discover", "extract", "publish"]),
    files: Schema.Finite,
    bytes: Schema.Finite,
    chunks: Schema.Finite,
    updated: Schema.Finite,
    document: Schema.String,
    started: Schema.optional(Schema.Finite),
    deadline: Schema.optional(Schema.Finite),
  })),
  result: Schema.optional(Schema.Struct({
    started: Schema.Finite,
    finished: Schema.Finite,
    state: Schema.Literals(["published", "failed"]),
    files: Schema.Finite,
    bytes: Schema.Finite,
    extracted: Schema.Finite,
    reused: Schema.Finite,
    empty: Schema.Finite,
    failed: Schema.Finite,
  })),
})
export type Collection = typeof Collection.Type

export const ImportFile = Schema.Struct({
  name: Schema.String,
  state: Schema.Literals(["processing", "extracted", "reused", "empty", "failed", "cancelled"]),
  bytes: Schema.Finite,
  chunks: Schema.Finite,
})
export type ImportFile = typeof ImportFile.Type

export const ImportInfo = Schema.Struct({
  id: Schema.String,
  collection: Schema.String,
  session: Schema.String,
  started: Schema.Finite,
  updated: Schema.Finite,
  finished: Schema.optional(Schema.Finite),
  state: Schema.Literals(["running", "published", "failed", "cancelled", "interrupted"]),
  stage: Schema.Literals(["discover", "extract", "publish"]),
  generation: Schema.optional(Schema.String),
  count: Schema.Finite,
  withheld: Schema.Finite,
})
export type ImportInfo = typeof ImportInfo.Type
export const ImportRun = Schema.Struct({ ...ImportInfo.fields, documents: Schema.Array(ImportFile) })
export type ImportRun = typeof ImportRun.Type
export const ImportHistory = Schema.Struct({
  runs: Schema.Array(ImportInfo),
  selected: Schema.optional(ImportInfo),
  documents: Schema.Array(ImportFile),
  page: Page,
})
export type ImportHistory = typeof ImportHistory.Type

export const Registry = Schema.Struct({
  collections: Schema.Array(Collection),
  references: Schema.optional(Schema.String),
  generation: Schema.String,
  page: Page,
  provider: Schema.String,
  destination: Schema.optional(Destination),
  warning: Schema.optional(Schema.String),
})
export type Registry = typeof Registry.Type

export const Registration = Schema.Struct({
  label: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  kind: Collection.fields.kind,
  location: Schema.String.check(Schema.isMaxLength(4096)),
  session: Schema.optional(Schema.String),
  include: Schema.optional(Schema.Array(Schema.String)),
  exclude: Schema.optional(Schema.Array(Schema.String)),
  watch: Schema.optional(Schema.Boolean),
  content: Schema.optional(Schema.String.check(Schema.isMaxLength(28_000_000))),
})
export type Registration = typeof Registration.Type

export const Preview = Schema.Struct({
  location: Schema.String,
  files: Schema.Finite,
  bytes: Schema.Finite,
  excluded: Schema.Finite,
  partial: Schema.Boolean,
  samples: Schema.Array(Schema.Struct({
    name: Schema.String,
    bytes: Schema.Finite,
    text: Schema.String,
  })),
  warnings: Schema.Array(Schema.String),
})
export type Preview = typeof Preview.Type

export const Policy = Schema.Struct({
  version: Schema.String,
  session: Schema.String,
  pin: Schema.Array(Schema.String),
  exclude: Schema.Array(Schema.String),
  versions: Schema.optional(Schema.Record(Schema.String, Schema.String)),
})
export type Policy = typeof Policy.Type

export const Status = Schema.Struct({
  inventory: Inventory,
  references: Schema.optional(Schema.String),
  session: Schema.String,
  job: Job,
  semantic: Schema.optional(Semantic),
  coding: Schema.optional(RequestInfo),
  preparation: Schema.optional(RequestInfo),
})
export type Status = typeof Status.Type

export const Overview = Schema.Struct({
  snapshot: Snapshot,
  summary: Schema.String,
  evidence: Schema.Array(Schema.String),
  usage: Usage,
})
export type Overview = typeof Overview.Type

export function decode<A, I>(schema: Schema.Codec<A, I>, value: unknown): A {
  return Schema.decodeUnknownSync(schema)(value)
}

export function usage(model = "none"): Usage {
  return { input: 0, output: 0, cached: 0, milliseconds: 0, model, measured: false }
}
