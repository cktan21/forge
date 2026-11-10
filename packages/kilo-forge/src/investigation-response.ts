import { isDeepStrictEqual as equal } from "node:util"
import { Result as Outcome, Schema, SchemaIssue } from "effect"
import { EnhancementError, failure } from "./enhancement"
import type { EnhancementFailure } from "./schema"
import { Clarification } from "./clarification"
import {
  actions,
  Candidate,
  Conclusion,
  Response,
  limits,
  unverified,
  type Call,
  type Observation,
  type Round,
} from "./investigation-schema"
import { redact } from "./util"

export function invalid(message: string) {
  return new EnhancementError(
    `Investigation response rejected: ${message}. No findings were approved. Your request was kept; retry explicitly or choose another model.`,
    failure("schema"),
  )
}

export function findings(
  value: unknown,
  observations: readonly Observation[],
): typeof Conclusion.Type & { failure?: EnhancementFailure } {
  const parsed = Schema.decodeUnknownResult(Response)(value, { onExcessProperty: "error" })
  if (Outcome.isFailure(parsed)) {
    const known = new Set([
      ...Object.keys(Conclusion.fields),
      ...Object.keys(Candidate.fields),
      ...Object.keys(Clarification.fields),
    ])
    const paths = SchemaIssue.makeFormatterStandardSchemaV1()(parsed.failure.issue)
      .issues.slice(0, 4)
      .map((issue) =>
        (issue.path ?? [])
          .filter(
            (part): part is string | number =>
              typeof part === "number" || (typeof part === "string" && known.has(part)),
          )
          .slice(0, 6)
          .join("."),
      )
      .filter(Boolean)
    throw invalid(`Invalid findings or clarification format${paths.length ? ` (check ${paths.join(", ")})` : ""}`)
  }
  const result = parsed.success
  const questions = new Map<string, typeof Clarification.Type>()
  for (const question of result.questions) {
    if (
      !question.id.trim() ||
      questions.has(question.id) ||
      !question.question.trim() ||
      !question.impact.trim() ||
      question.options.length < 2 ||
      question.options.some((option) => !option.trim()) ||
      new Set(question.options).size !== question.options.length
    )
      throw invalid("Clarification requires unique IDs, a question, consequence and distinct options")
    if (question.when) {
      const parent = questions.get(question.when.question)
      if (!parent || question.when.options.some((option) => !parent.options.includes(option)))
        throw invalid("Clarification conditions must reference an earlier question and its exact options")
    }
    questions.set(question.id, question)
  }
  if (result.questions.some((question) => !question.optional))
    return {
      ...result,
      findings: [],
      limitations: [
        ...result.limitations,
        ...(result.findings.length
          ? ["Proposed findings were not accepted while required clarification remains."]
          : []),
      ],
    }
  const notes: string[] = []
  const candidates = result.findings.flatMap((value, index) => {
    // Extra proposal metadata is not evidence or an instruction. Keep only the
    // declared fields, without relaxing their types or inventing missing values.
    const parsed = Schema.decodeUnknownResult(Candidate)(value, { onExcessProperty: "ignore" })
    if (Outcome.isSuccess(parsed)) return [parsed.success]
    const fields = new Set(Object.keys(Candidate.fields))
    const paths = SchemaIssue.makeFormatterStandardSchemaV1()(parsed.failure.issue)
      .issues.slice(0, 4)
      .map((issue) =>
        (issue.path ?? [])
          .filter(
            (part): part is string | number =>
              typeof part === "number" || (typeof part === "string" && fields.has(part)),
          )
          .slice(0, 6)
          .join("."),
      )
      .filter(Boolean)
    notes.push(
      `Model proposal ${index + 1} was discarded: invalid ${paths.join(", ") || "finding"} format. No change was approved for it.`,
    )
    return []
  })
  const sources = new Map(observations.flatMap((item) => item.sources).map((item) => [item.id, item]))
  const inspected = new Set(
    observations
      .filter((item) => item.tool === "forge_read_file" || item.tool === "forge_get_symbol")
      .flatMap((item) => item.sources.map((source) => source.id)),
  )
  for (const item of candidates) {
    if ([...item.evidence, ...item.counterevidence].some((key) => !sources.has(key)))
      throw invalid("Finding cites evidence that was not observed")
    if (item.support !== "unresolved" && !item.evidence.length)
      throw invalid("Supported findings require original evidence")
    if (item.support === "observed" && !item.evidence.some((key) => inspected.has(key)))
      throw invalid("Observed findings require direct source inspection")
    if (item.support === "inferred" && !item.unknowns.length)
      throw invalid("Inferred findings must preserve uncertainty")
    if (!item.verification.length) throw invalid("Findings require a verification step")
  }
  if (candidates.some((item) => item.support === "unresolved")) notes.push(unverified)
  return {
    ...result,
    findings: candidates,
    limitations: [...result.limitations, ...notes],
    ...(result.findings.length && !candidates.length
      ? { failure: { ...failure("schema"), stage: "response" as const } }
      : {}),
  }
}

export function admit(calls: readonly Call[], seen: ReadonlySet<string>, final: boolean) {
  if (
    calls.some((call) => !Object.hasOwn(actions, call.name) || !call.id || seen.has(call.id)) ||
    new Set(calls.map((call) => call.id)).size !== calls.length
  )
    return {
      kind: "invalid" as const,
      inspections: [],
      error: invalid("Investigator returned an invalid or repeated tool call"),
    }
  const finishing =
    calls.length <= limits.calls &&
    calls.some((call) => call.name === "forge_finish") &&
    (final || calls.every((call) => call.name === "forge_finish"))
  const decoded = calls.slice(0, limits.calls).map((call) => ({
    call,
    parsed: Schema.decodeUnknownResult(call.name === "forge_finish" ? Response : actions[call.name])(call.input, {
      onExcessProperty: "error",
    }),
  }))
  const inspections: Round["inspections"] = decoded.map(({ call, parsed }) => ({
    id: call.id,
    tool: call.name,
    input: Outcome.isFailure(parsed)
      ? "Arguments rejected; raw model values are not displayed."
      : call.name === "forge_finish"
        ? "Conclusion payload; see the validated review."
        : redact(JSON.stringify(parsed.success)).slice(0, 1000),
    state: finishing
      ? call.name === "forge_finish"
        ? "requested"
        : "skipped"
      : call.name === "forge_finish" || Outcome.isFailure(parsed)
        ? "skipped"
        : "requested",
  }))
  if (finishing)
    return {
      kind: "finish" as const,
      inspections,
      finish: (observations: readonly Observation[]) => {
        const conclusions = calls
          .filter((call) => call.name === "forge_finish")
          .map((call) => findings(call.input, observations))
        const conclusion = conclusions.at(0)!
        if (conclusions.some((item) => !equal(item, conclusion)))
          throw invalid("The model returned multiple distinct conclusions")
        return {
          ...conclusion,
          limitations: [
            ...conclusion.limitations,
            ...(calls.length > conclusions.length
              ? ["Additional inspection calls returned with the final conclusion were not executed."]
              : []),
            ...(conclusions.length > 1 ? ["Repeated identical conclusions were treated as one validated result."] : []),
          ],
        }
      },
    }
  const admitted = decoded
    .filter((item) => item.call.name !== "forge_finish")
    .map(({ call, parsed }) =>
      Outcome.isSuccess(parsed)
        ? { ...call, input: parsed.success, rejected: false }
        : { ...call, input: {}, rejected: true },
    )
  const purposes = admitted.flatMap((call) => {
    const value = Reflect.get(call.input, "purpose")
    return typeof value === "string" && value.trim() ? [value] : []
  })
  return {
    kind: "inspect" as const,
    inspections,
    calls: admitted,
    note: [...new Set(purposes)].join("\n"),
    discarded: calls.some((call) => call.name === "forge_finish"),
  }
}

export function report(
  err: unknown,
  stage: NonNullable<EnhancementFailure["stage"]>,
  request?: string,
  signal?: AbortSignal,
) {
  const cause =
    signal?.aborted && !(err instanceof EnhancementError && ["timeout", "cancelled"].includes(err.failure.code))
      ? signal.reason
      : err
  const reference = cause instanceof EnhancementError ? (cause.failure.request ?? request) : request
  if (cause instanceof EnhancementError)
    return new EnhancementError(cause.message, {
      ...cause.failure,
      stage: cause.failure.stage ?? stage,
      ...(reference == null ? {} : { request: reference }),
    })
  if (signal?.aborted)
    return new EnhancementError("Investigation cancelled. Your request and recorded evidence were kept.", {
      ...failure("cancelled"),
      stage,
      ...(request == null ? {} : { request }),
    })
  const code = cause != null && typeof cause === "object" ? Reflect.get(cause, "code") : undefined
  const text = cause instanceof Error ? cause.message.slice(0, 4096) : ""
  const reason =
    stage === "persistence"
      ? "storage"
      : code === "EACCES" ||
          code === "EPERM" ||
          /denied|denies|permission|excluded|not approved|Registered paths/i.test(text)
        ? "permission"
        : /policy.*changed|destination.*changed|purged|access changed/i.test(text)
          ? "policy-changed"
          : /(?:file|source|evidence|amendments).*changed/i.test(text)
            ? "source-changed"
            : /accounting|usage is invalid|exceed.*budget/i.test(text)
              ? "accounting"
              : "unknown"
  const messages = {
    storage: "Investigation history could not be saved. Check local storage before retrying.",
    permission: "Investigation access was denied. Review permissions and source sharing before retrying.",
    "policy-changed": "Investigation policy or destination changed. Review access before retrying.",
    "source-changed": "Investigation evidence changed. Inspect the current sources before retrying.",
    accounting: "Investigation request accounting or budget validation failed. No further model call was admitted.",
    unknown: `Investigation failed during ${stage}. No findings were approved.`,
  }
  return new EnhancementError(`${messages[reason]} Your request was kept.`, {
    ...failure("transport"),
    reason,
    stage,
    ...(request == null ? {} : { request }),
  })
}
