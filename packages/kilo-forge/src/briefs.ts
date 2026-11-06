import type { Source } from "./schema"
import { hash } from "./util"
import { order } from "./order"

const version = "forge-extractive-brief-v1"

export function brief(parent: Source, sections: readonly Source[]) {
  const eligible = sections.filter((item) =>
    item.method === "collection-section" && item.status === "current" && item.text &&
    item.evidence.includes(parent.id) && item.detail.collection === parent.detail.collection &&
    item.detail.session === parent.detail.session && item.detail.fileHash === parent.detail.fileHash,
  )
  const items = eligible.toSorted((a, b) =>
    Number(a.detail.page ?? 0) - Number(b.detail.page ?? 0) ||
    a.start - b.start || a.end - b.end || order(a, b),
  ).slice(0, 24)
  const dependencies = JSON.stringify(items.map((item) => [item.id, item.hash, (item.detail.heading ?? "").slice(0, 240)]))
  const fingerprint = hash(JSON.stringify([
    version, parent.id, parent.label.slice(0, 240), parent.detail.collection,
    parent.detail.session, parent.detail.fileHash, eligible.length, dependencies,
  ]))
  const cached = parent.detail.briefVersion === version && parent.detail.briefFingerprint === fingerprint &&
    parent.detail.brief != null && parent.detail.briefHash === hash(parent.detail.brief)
  const text = cached ? parent.detail.brief! :
    `${parent.label.slice(0, 240)}\n${items.map((item) => `${(item.detail.heading ?? "").slice(0, 240)} ${item.text.slice(0, 240)}`).join("\n")}`
  return { text, cached, fingerprint, dependencies, count: eligible.length, ids: items.map((item) => item.id) }
}

// Called on one extracted or reused document, never on a whole mixed-scope corpus.
export function briefs(sources: readonly Source[]): Source[] {
  const parent = sources.find((item) => item.method === "collection-document")
  if (!parent) return [...sources]
  const value = brief(parent, sources)
  if (value.cached) return [...sources]
  const digest = hash(value.text)
  return sources.map((item) => item !== parent ? item : {
    ...parent,
    hash: hash(JSON.stringify([parent.detail.fileHash, value.fingerprint, digest])),
    evidence: value.ids,
    detail: {
      ...parent.detail, brief: value.text, briefVersion: version, briefHash: digest,
      briefFingerprint: value.fingerprint, briefDependencies: value.dependencies,
      coverage: `Extractive routing brief: ${value.ids.length} of ${value.count} eligible sections sampled, at most 24. Titles, headings, and passage prefixes are bounded to 240 characters each. Not a complete summary or selected evidence; inspect original sections/pages.`,
    },
  })
}
