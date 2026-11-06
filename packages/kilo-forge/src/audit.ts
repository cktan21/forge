import type { Match, RetrievalChannel, Selection, SelectionInfo } from "./schema"
import { redact } from "./util"

export type Channel = Pick<RetrievalChannel, "name" | "state" | "readiness"> & { matches: readonly Match[]; withheld?: number }

export function audit(candidates: readonly Match[], selection: Selection, withheld = 0, channels?: readonly Channel[]): SelectionInfo {
  const chosen = new Map(selection.matches.map((item) => [item.source.id, item]))
  const retrieved = new Map(candidates.map((item) => [item.source.id, item.reason]))
  const visible = new Set(candidates.map((item) => item.source.id))
  const origins = new Map<string, NonNullable<SelectionInfo["candidates"][number]["channels"]>[number][]>()
  for (const channel of channels ?? []) {
    channel.matches.forEach((item, rank) => {
      if (!visible.has(item.source.id)) return
      const prior = origins.get(item.source.id) ?? []
      if (prior.some((item) => item.name === channel.name)) return
      origins.set(item.source.id, [...prior, { name: channel.name, rank: rank + 1, score: item.score, reason: redact(item.reason).slice(0, 512) }])
    })
  }
  // Keep selected evidence first; metadata history has an independent retention bound.
  const pool = [...new Map([...selection.matches, ...candidates].map((item) => [item.source.id, chosen.get(item.source.id) ?? item])).values()]
  return {
    candidates: pool.slice(0, 512).map((item) => ({
      source: item.source.id, hash: item.source.hash, score: item.score,
      retrieval: redact([...new Set([retrieved.get(item.source.id), item.reason].filter(Boolean))].join("; ")).slice(0, 512),
      state: chosen.has(item.source.id) ? "selected" : "omitted",
      reason: chosen.has(item.source.id) ? "Selected within the evidence budget" : redact(selection.reasons?.[item.source.id] ?? "Not selected").slice(0, 512),
      ...(channels ? { channels: origins.get(item.source.id) ?? [] } : {}),
    })),
    ...(channels ? { channels: channels.map((channel) => ({
      name: channel.name, state: channel.state,
      ...(channel.readiness ? { readiness: { ...channel.readiness } } : {}),
      candidates: channel.matches.filter((item) => visible.has(item.source.id)).length,
      withheld: (channel.withheld ?? 0) + channel.matches.filter((item) => !visible.has(item.source.id)).length,
    })) } : {}),
    total: pool.length, unrecorded: Math.max(0, pool.length - 512), withheld,
    budget: selection.budget, tokens: selection.tokens, estimator: selection.estimator,
    policy: selection.policy, provider: selection.provider, destination: selection.destination,
  }
}
