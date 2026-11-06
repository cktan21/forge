import { decode, EmbeddingLedger, EmbeddingUsage, type EmbeddingAttempt } from "./schema"
import { account, consistent } from "./embedding-usage"
import { wait } from "./wait"

export async function exportEmbeddings(input: {
  session: string
  max?: number
  after?: string
  signal?: AbortSignal
  read(request: { session: string; limit: number; after?: string }, signal?: AbortSignal): Promise<unknown>
}) {
  const started = Date.now()
  const max = input.max ?? 1000
  if (!Number.isInteger(max) || max < 1 || max > 10_000) throw new Error("Export maximum must be 1-10000 attempts")
  const cursor = (value: string) => /^[1-9]\d{0,15}$/.test(value) && Number.isSafeInteger(Number(value))
  if (input.after != null && !cursor(input.after)) throw new Error("Invalid export cursor")
  const entries: EmbeddingAttempt[] = []
  const ids = new Set<string>()
  const groups = new Map<
    string,
    { target: EmbeddingAttempt["target"]; purpose: EmbeddingAttempt["purpose"]; usage: EmbeddingUsage }
  >()
  let after = input.after
  let bytes = 0
  let observation: EmbeddingLedger["observation"]
  let pages = 0
  while (entries.length < max) {
    const limit = Math.min(100, max - entries.length)
    const page = decode(
      EmbeddingLedger,
      await wait(() => input.read({ session: input.session, after, limit }, input.signal), input.signal),
    )
    if (
      page.session !== input.session ||
      page.entries.length > limit ||
      (page.next != null &&
        (!cursor(page.next) || !page.entries.length || (after != null && Number(page.next) >= Number(after))))
    )
      throw new Error("Invalid embedding usage page")
    if (pages && JSON.stringify(page.observation) !== JSON.stringify(observation))
      throw new Error("Ledger changed during embedding usage export. Inspect again; no partial export was produced.")
    observation = page.observation
    pages++
    for (const entry of page.entries) {
      if (
        !entry.id ||
        ids.has(entry.id) ||
        entry.session !== input.session ||
        !entry.collections.length ||
        entry.collections.length > 100 ||
        new Set(entry.collections).size !== entry.collections.length ||
        !consistent(entry.usage) ||
        entry.usage.attempts !== 1 ||
        entry.usage.inputs < 1 ||
        entry.usage.bytes < 1 ||
        entry.usage.pending !== (entry.finished == null ? 1 : 0)
      )
        throw new Error("Invalid or repeated embedding attempt")
      ids.add(entry.id)
      bytes += new TextEncoder().encode(JSON.stringify(entry)).length
      if (bytes > 16 * 1024 * 1024) throw new Error("Embedding export exceeds 16 MiB")
      entries.push(entry)
      const key = JSON.stringify([entry.purpose, entry.target.fingerprint, entry.target.model, entry.target.dimensions])
      const group = groups.get(key) ?? {
        target: entry.target,
        purpose: entry.purpose,
        usage: account(undefined, { state: "ready" }),
      }
      group.usage = decode(
        EmbeddingUsage,
        Object.fromEntries(
          (
            [
              "attempts",
              "inputs",
              "bytes",
              "responses",
              "failed",
              "pending",
              "promptTokens",
              "promptReports",
              "totalTokens",
              "totalReports",
            ] as const
          ).map((name) => [name, group.usage[name] + entry.usage[name]]),
        ),
      )
      if (!consistent(group.usage)) throw new Error("Embedding export subtotal exceeds safe bounds")
      groups.set(key, group)
    }
    after = page.next
    if (after == null) break
  }
  input.signal?.throwIfAborted()
  return {
    version: "forge-embedding-export-v1" as const,
    session: input.session,
    started,
    finished: Date.now(),
    scope: "collection-embedding-transport" as const,
    history: "recorded-admissions-only" as const,
    snapshot: false,
    consistency: observation ? ("revision-checked" as const) : ("unchecked" as const),
    ...(observation ? { observation } : {}),
    traversal: after == null ? ("exhausted" as const) : ("limited" as const),
    ...(input.after == null ? {} : { after: input.after }),
    ...(after == null ? {} : { next: after }),
    cost: null,
    warnings: [
      ...(observation
        ? [
            "Pages share one recorded ledger revision. This is not a retained snapshot; changes after observation require reinspection.",
            `History tracking began at ${observation.since} milliseconds since Unix epoch. Earlier coverage is unknown. ${observation.deleted ? "Recorded history has been deleted." : "No deletion has been recorded since tracking began."}`,
          ]
        : [
            "Live pages are not a frozen snapshot. New admissions and changed outcomes may be absent; reread before reconciliation.",
            "This backend supplies no revision or retained-history metadata. Traversal consistency is unchecked.",
          ]),
      "Old or purged attempts are unavailable. Exhausting these pages does not prove complete historical usage.",
      "Admission is not proof of transmission. Provider reports are not verified billing; missing usage is not zero.",
      "Subtotals cover only these exported entries. Job snapshots overlap these attempts; do not add them again.",
      "Repository embeddings, extraction, routing, preparation and coding are outside this export. Monetary cost is unknown.",
    ],
    groups: [...groups.values()].map((group) => ({
      ...group,
      unknown: {
        prompt: group.usage.attempts - group.usage.promptReports,
        total: group.usage.attempts - group.usage.totalReports,
      },
    })),
    entries,
  }
}
