import { Result, Schema } from "effect"
import { EnhancementFailure, EnhancementIssue, type PromptEdit } from "./schema"

export class EnhancementError extends Error {
  constructor(message: string, readonly failure: EnhancementFailure) {
    super(message)
    this.name = "EnhancementError"
  }
}

export function failure(code: EnhancementFailure["code"], issues: EnhancementIssue[] = []): EnhancementFailure {
  return { code, schema: "forge-enhancement-v2", issues }
}

export function describe(issue: EnhancementIssue) {
  const path = issue.path.map((part, index) => typeof part === "number" ? `[${part}]` : `${index ? "." : ""}${part}`).join("") || "response"
  return issue.actual === "missing" ? `${path}: missing (required ${issue.expected})` : `${path}: expected ${issue.expected}, received ${issue.actual}`
}

export function diagnostic(value: unknown) {
  const result = Schema.decodeUnknownResult(EnhancementFailure)(value, { onExcessProperty: "error" })
  return Result.isSuccess(result) ? result.success : undefined
}

export function guidance(issues: readonly EnhancementIssue[] = []) {
  const values = Schema.decodeUnknownSync(Schema.Array(EnhancementIssue).check(Schema.isMaxLength(8)))(issues)
  return values.length ? `Response-format correction for this explicit retry, not new developer requirements:\n${values.map(describe).join("\n")}\nReturn every required section in its declared shape. Never invent missing verification or authorization.` : ""
}

export function amendments(edits: readonly PromptEdit[] = []) {
  if (!edits.length) return ""
  if (edits.length > 100) throw new Error("Too many prompt edits. No edits were discarded; start a fresh workshop.")
  const text = edits.filter((edit) => edit.before !== edit.after).map((edit, index) =>
    `Edit ${index + 1}:\n${JSON.stringify(edit)}`).join("\n")
  if (text.length > 30_000) throw new Error("Your prompt edits exceed the enhancement conversation limit. No edits were discarded.")
  return text ? `Explicit developer edits (in order; replacements and removals amend earlier requirements, unchanged AI notes are not requirements). This consolidated list is not a new event: use the chronological developer conversation to resolve conflicts with feedback:\n${text}` : ""
}
