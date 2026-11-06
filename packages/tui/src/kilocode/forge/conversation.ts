import type { Proposal, Question, PromptEdit } from "@kilocode/forge/schema"
import { diffLines } from "diff"

export type Answer = { option?: string; comment?: string; skipped?: boolean }

export function identity(item: Question) {
  const normalize = (value: string) => value.trim().replace(/\s+/g, " ").toLowerCase()
  return JSON.stringify([item.optional, normalize(item.question), item.options.map(normalize).sort()])
}

export function edits(before: string, after: string): PromptEdit[] {
  const changes: PromptEdit[] = []
  let removed = ""
  let added = ""
  const flush = () => {
    if (removed !== added) changes.push({ before: removed, after: added })
    removed = ""
    added = ""
  }
  for (const part of diffLines(before, after)) {
    if (part.removed) { removed += part.value; continue }
    if (part.added) { added += part.value; continue }
    flush()
  }
  flush()
  return changes
}

export function questions(proposal?: Proposal): readonly Question[] {
  if (proposal?.questions?.length) return proposal.questions
  return (proposal?.task?.questions ?? []).map((question, index) => ({
    id: `legacy:${index}`, question, impact: "This decision remains unresolved until clarified.",
    options: [], optional: false,
  }))
}

export function responses(items: readonly Question[], values: Record<string, Answer>) {
  return items.map((item) => {
    const value = values[item.id] ?? {}
    if (value.option != null && !item.options.includes(value.option)) throw new Error("The selected answer is no longer available.")
    const comment = value.comment?.trim() ?? ""
    return JSON.stringify({
      id: item.id, question: item.question, option: value.option ?? null, comment,
      skipped: !value.option && !comment, optional: item.optional,
    })
  }).join("\n")
}

export function transcript(values: readonly string[]) {
  const text = values.filter((value) => value.trim()).join("\n\n")
  if (text.length > 30_000) throw new Error("This enhancement conversation is too long. Close and reopen /enhance with a fresh prompt.")
  return text
}
