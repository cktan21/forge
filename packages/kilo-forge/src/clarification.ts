import { Result, Schema } from "effect"
import { Question } from "./schema"

export const Clarification = Schema.Struct({
  ...Question.fields,
  when: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        question: Schema.String,
        options: Schema.Array(Schema.String).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
      }).annotate({
        description:
          "Show this question only when an earlier question with this ID is visible and its selected option matches one of these exact option strings. Omit or use null for questions that apply to every branch.",
      }),
    ),
  ),
})
export type Clarification = typeof Clarification.Type

const Reply = Schema.Struct({
  question: Schema.String,
  option: Schema.optional(Schema.NullOr(Schema.String)),
  comment: Schema.optional(Schema.String),
  skipped: Schema.optional(Schema.Boolean),
  optional: Schema.optional(Schema.Boolean),
})

function key(text: string) {
  return text
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[?!.]+$/, "")
    .trim()
    .toLowerCase()
}

export function replies(text: string) {
  const values = new Map<string, typeof Reply.Type>()
  for (const line of text.split("\n")) {
    if (!line.trim().startsWith("{")) continue
    const value: unknown = (() => {
      try {
        return JSON.parse(line)
      } catch (err) {
        if (!(err instanceof SyntaxError)) throw err
        return undefined
      }
    })()
    const result = Schema.decodeUnknownResult(Reply)(value)
    if (Result.isFailure(result)) continue
    const reply = result.success
    if (!key(reply.question) || !(reply.option?.trim() || reply.comment?.trim() || (reply.skipped && reply.optional)))
      continue
    const id = key(reply.question)
    values.delete(id)
    values.set(id, reply)
  }
  return [...values.values()]
}

export function visible(questions: readonly Clarification[], values: Readonly<Record<string, { option?: string }>>) {
  const active = new Set<string>()
  return questions.filter((question) => {
    const condition = question.when
    if (
      condition &&
      (!active.has(condition.question) || !condition.options.includes(values[condition.question]?.option ?? ""))
    )
      return false
    active.add(question.id)
    return true
  })
}

export function followup(questions: readonly Clarification[], answers: string) {
  const settled = new Map(replies(answers).map((reply) => [key(reply.question), reply]))
  const pending = new Map<string, Clarification>()
  const choices = new Map<string, string>()
  let repeated = 0
  for (const question of questions) {
    const condition = question.when
    if (
      condition &&
      !pending.has(condition.question) &&
      !condition.options.includes(choices.get(condition.question) ?? "")
    )
      continue
    const reply = settled.get(key(question.question))
    if (reply) {
      choices.set(question.id, reply.option ?? "")
      repeated++
      continue
    }
    // A previously answered parent no longer needs to appear in this batch.
    pending.set(
      question.id,
      condition && !pending.has(condition.question) ? { ...question, when: null } : question,
    )
  }
  return { questions: [...pending.values()], repeated }
}
