import type { EmbeddingUsage } from "./schema"

export type Observation =
  | { state: "ready" }
  | { state: "attempt"; inputs: number; bytes: number }
  | { state: "response"; prompt?: number; total?: number }
  | { state: "failed" }

export type Observer = (event: Observation) => Promise<void>

export function consistent(value: EmbeddingUsage) {
  return (
    Object.values(value).every((count) => Number.isSafeInteger(count) && count >= 0) &&
    value.responses + value.failed + value.pending === value.attempts &&
    value.promptReports <= value.responses &&
    value.totalReports <= value.responses &&
    (value.promptReports > 0 || value.promptTokens === 0) &&
    (value.totalReports > 0 || value.totalTokens === 0)
  )
}

export function summary(value?: EmbeddingUsage) {
  if (!value) return "Usage accounting unavailable for this job."
  if (!consistent(value)) return "Usage accounting unavailable: inconsistent counters."
  return [
    `Locally admitted attempts: ${value.attempts}; inputs: ${value.inputs}; request-body bytes: ${value.bytes}.`,
    `Observed JSON responses: ${value.responses}; failed without a JSON report: ${value.failed}; unresolved: ${value.pending}.`,
    `Provider prompt-token subtotal: ${value.promptTokens} from ${value.promptReports} reports; ${value.attempts - value.promptReports} attempts unknown.`,
    `Provider total-token subtotal: ${value.totalTokens} from ${value.totalReports} reports; ${value.attempts - value.totalReports} attempts unknown.`,
    "Admission is not proof of transmission. Provider reports are not verified billing; missing usage is not zero. Indexing job only, not query embeddings. Monetary cost unknown.",
  ].join("\n")
}

export function reported(body: unknown): Extract<Observation, { state: "response" }> {
  const empty = { state: "response" as const }
  if (!body || typeof body !== "object" || !("usage" in body)) return empty
  const usage = body.usage
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return empty
  const prompt = "prompt_tokens" in usage ? usage.prompt_tokens : undefined
  const total = "total_tokens" in usage ? usage.total_tokens : undefined
  const valid = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0
  if ((prompt != null && !valid(prompt)) || (total != null && !valid(total))) return empty
  if (valid(prompt) && valid(total) && total < prompt) return empty
  return { ...empty, ...(valid(prompt) ? { prompt } : {}), ...(valid(total) ? { total } : {}) }
}

export function account(previous: EmbeddingUsage | undefined, event: Observation): EmbeddingUsage {
  const valid = (count: number) => Number.isSafeInteger(count) && count >= 0
  if (
    (event.state === "attempt" && (!valid(event.inputs) || !event.inputs || !valid(event.bytes) || !event.bytes)) ||
    (event.state === "response" &&
      ((event.prompt != null && !valid(event.prompt)) || (event.total != null && !valid(event.total))))
  )
    throw new Error("Invalid embedding usage observation")
  const value = {
    ...(previous ?? {
      attempts: 0,
      inputs: 0,
      bytes: 0,
      responses: 0,
      failed: 0,
      pending: 0,
      promptTokens: 0,
      promptReports: 0,
      totalTokens: 0,
      totalReports: 0,
    }),
  }
  if (event.state === "attempt") {
    value.attempts++
    value.pending++
    value.inputs += event.inputs
    value.bytes += event.bytes
  }
  if (event.state === "response" || event.state === "failed") {
    if (!value.pending) throw new Error("Embedding usage has no pending attempt")
    value.pending--
    if (event.state === "failed") value.failed++
    if (event.state === "response") {
      value.responses++
      if (event.prompt != null) {
        value.promptTokens += event.prompt
        value.promptReports++
      }
      if (event.total != null) {
        value.totalTokens += event.total
        value.totalReports++
      }
    }
  }
  if (Object.values(value).some((count) => !Number.isSafeInteger(count) || count < 0))
    throw new Error("Embedding usage exceeds safe counter bounds")
  return value
}
