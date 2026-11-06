import path from "node:path"
import type { Match, Source } from "./schema"
import { source } from "./parse"
import { id, keywords } from "./util"
import { brief } from "./briefs"
import { order } from "./order"

export function domain(item: Source) {
  if (item.detail.collection) return `knowledge/${item.detail.collection}`
  const parts = item.uri.split("/")
  if (item.uri.includes(":")) return item.detail.domain ?? ""
  if (parts.at(0) === "packages" && parts.length > 2) return parts.slice(0, 2).join("/")
  if (parts.at(0) === "src" && parts.length > 2) return parts.slice(0, 2).join("/")
  return path.posix.dirname(item.uri)
}

export function domains(sources: readonly Source[]) {
  const groups = new Map<string, Source[]>()
  for (const item of sources) {
    if (item.status !== "current" || !["file", "collection-document"].includes(item.method)) continue
    const key = domain(item)
    if (!key) continue
    const items = groups.get(key) ?? []
    items.push(item)
    groups.set(key, items)
  }
  return [...groups].sort(([a], [b]) => a.localeCompare(b)).slice(0, 200).map(([name, files]) => {
    const chosen = [...files].sort((a, b) => Number(/readme/i.test(b.uri)) - Number(/readme/i.test(a.uri)) || a.uri.localeCompare(b.uri)).slice(0, 32)
    const ids = new Set(chosen.map((item) => item.id))
    const symbols = sources.filter((item) => item.kind === "symbol" && item.evidence.some((key) => ids.has(key))).slice(0, 24)
    const descriptions = chosen.filter((item) => item.kind === "document").map((item) => `${item.label}: ${item.text.split("\n").filter((line) => line.trim()).slice(0, 3).join(" ").slice(0, 240)}`)
    const text = [
      `Domain inventory: ${name}. Grouped by source location, not a verified responsibility boundary.`,
      `Files (${files.length} total, bounded sample): ${chosen.map((item) => item.uri).join(", ")}`,
      `Declared symbols: ${symbols.map((item) => item.label).join(", ") || "not extracted"}`,
      ...descriptions,
    ].join("\n").slice(0, 3000)
    return source(`domain:${name}`, text, "summary", {
      id: id("domain", name), label: name, method: "domain-index", inferred: true,
      evidence: [...ids, ...symbols.map((item) => item.id)],
      detail: { domain: name, coverage: `${chosen.length} of ${files.length} files represented; expand originals before changing code`, dependencies: JSON.stringify(Object.fromEntries([...chosen, ...symbols].map((item) => [item.id, item.hash]))) },
    })
  })
}

export function route(query: string, sources: readonly Source[]): Match[] {
  const words = keywords(query)
  const briefs = sources.filter((item) => item.method === "domain-index")
  const ranked = briefs.map((item) => ({ item, score: words.filter((word) => `${item.label} ${item.text}`.toLowerCase().includes(word)).length })).filter((item) => item.score > 1).sort((a, b) => b.score - a.score || order(a.item, b.item)).slice(0, 3)
  const matches: Match[] = []
  for (const { item, score } of ranked) {
    matches.push({ source: item, score, reason: `Bounded domain route: ${item.label}; inferred membership` })
    const candidates = sources.filter((source) => item.evidence.includes(source.id) && source.text)
      .map((source) => ({ source, score: words.filter((word) => `${source.label} ${source.text}`.toLowerCase().includes(word)).length, reason: `Original evidence in domain ${item.label}` }))
      .filter((match) => match.score > 0).sort((a, b) => b.score - a.score || order(a.source, b.source)).slice(0, 8)
    matches.push(...candidates)
  }
  // Cached descriptors are reusable only for the currently eligible dependency set.
  const documents = new Map(sources.filter((item) => item.method === "collection-document" && item.status === "current").map((item) => [item.id, item]))
  const sections = new Map<string, Source[]>()
  for (const item of sources) {
    if (item.method !== "collection-section" || item.status !== "current" || !item.text) continue
    for (const key of item.evidence) {
      const parent = documents.get(key)
      if (!parent || item.detail.collection !== parent.detail.collection || item.detail.session !== parent.detail.session || item.detail.fileHash !== parent.detail.fileHash) continue
      const group = sections.get(key) ?? []
      group.push(item)
      sections.set(key, group)
    }
  }
  const selected = [...sections].map(([key, items]) => {
    const parent = documents.get(key)!
    const descriptor = brief(parent, items)
    const text = descriptor.text.toLowerCase()
    return { parent, items, cached: descriptor.cached, score: words.filter((word) => text.includes(word)).length }
  }).filter((item) => item.score > 1).sort((a, b) => b.score - a.score || order(a.parent, b.parent)).slice(0, 3)
  for (const { parent, items, cached } of selected) {
    matches.push(...items.map((source) => ({
      source,
      score: words.filter((word) => `${(source.detail.heading ?? "").slice(0, 240)} ${source.text}`.toLowerCase().includes(word)).length,
      reason: `Bounded document route: ${parent.label.slice(0, 240)}; original section${source.detail.page ? ` on page ${source.detail.page}` : ""}; routing sampled at most 24 sections; ${cached ? "persisted brief" : "eligible-section fallback"}`,
    })).filter((item) => item.score > 0).sort((a, b) => b.score - a.score || order(a.source, b.source)).slice(0, 8))
  }
  return matches
}
