import type { ElementDefinition } from "cytoscape"
import type { Snapshot, Manifest, Source } from "@kilocode/forge/schema"

export const colors: Record<string, string> = {
  code: "#83c6de", symbol: "#8faddc", directory: "#7f959e", document: "#d6b887", instruction: "#ef9c89",
  test: "#a8d395", dependency: "#c4ace2", schema: "#e5a275", configuration: "#b4b9c1", memory: "#cca4c9",
  goal: "#e7c875", history: "#92b7a2", tool: "#91c9bc", summary: "#caaae3", attachment: "#a8bdd5", opportunity: "#e9be81",
}

export function projection(snapshot: Snapshot, manifest?: Manifest, filter = "", query = ""): Source[] {
  const indexed = new Map(snapshot.sources.map((source) => [source.id, source]))
  const candidates: Source[] = manifest ? manifest.entries.map((entry) => {
    const current = indexed.get(entry.source)
    const same = current?.hash === entry.hash
    return {
      id: entry.source, kind: entry.kind ?? (same ? current.kind : "tool"), label: entry.label ?? (same ? current.label : entry.source),
      uri: entry.uri ?? (same ? current.uri : "Captured request source"), text: entry.text, hash: entry.hash,
      start: same ? current.start : 0, end: same ? current.end : 0, observed: manifest.observed,
      method: "request-capture", status: same ? current.status : "stale", inferred: same ? current.inferred : false,
      evidence: [], detail: { stage: entry.stage, request: manifest.id, coverage: same ? "Captured excerpt; current source version matches" : "Historical excerpt; current source version is different or not in this view" },
    }
  }) : [...snapshot.sources]
  return [...new Map(candidates.map((source) => [source.id, source])).values()].filter((source) =>
    (!filter || source.kind === filter) && (!query || `${source.label} ${source.uri} ${source.text}`.toLowerCase().includes(query.toLowerCase())),
  )
}

export function elements(snapshot: Snapshot, manifest?: Manifest, filter = "", query = ""): ElementDefinition[] {
  const entries = new Map(manifest?.entries.map((entry) => [entry.source, entry]))
  const visible = projection(snapshot, manifest, filter, query)
  const groups = [...new Set(visible.map((source) => source.kind))].sort()
  const expanded = !!filter || !!manifest
  const rendered = new Set<string>()
  const result: ElementDefinition[] = [{ data: { id: "forge", label: manifest ? `FORGE\n${manifest.purpose}` : "FORGE\navailable", session: manifest?.session ?? "", central: true, color: "#74d8c4" }, position: { x: 0, y: 0 }, locked: true }]
  groups.forEach((kind, index) => {
    const angle = 2 * Math.PI * index / Math.max(1, groups.length) - Math.PI / 2
    const group = `group:${kind}`
    const members = visible.filter((source) => source.kind === kind)
    const children = expanded ? members : [...members].sort((a, b) => Number(b.method === "file") - Number(a.method === "file")).slice(0, 4)
    result.push({ data: { id: group, label: `${kind.toUpperCase()}\n${members.length}`, category: kind, color: colors[kind] }, position: { x: Math.cos(angle) * (expanded ? 210 : 150), y: Math.sin(angle) * (expanded ? 210 : 150) } })
    result.push({ data: { id: `${group}:forge`, source: group, target: "forge", membership: true, label: manifest ? "request context" : "available" } })
    children.forEach((source, offset) => {
      const spread = (offset - (children.length - 1) / 2) * Math.min(0.18, 1.6 / Math.max(1, children.length))
      const radius = (expanded ? 350 : 255) + (offset % 3) * (expanded ? 70 : 35)
      rendered.add(source.id)
      result.push({ data: { id: source.id, label: source.label.length > 28 ? `${source.label.slice(0, 25)}…` : source.label, uri: source.uri, color: colors[source.kind], status: source.status, stage: entries.get(source.id)?.stage ?? "indexed" }, position: { x: Math.cos(angle + spread) * radius, y: Math.sin(angle + spread) * radius } })
      result.push({ data: { id: `${source.id}:group`, source: source.id, target: group, membership: true, label: entries.get(source.id)?.stage ?? "indexed" } })
    })
  })
  const ids = rendered
  // Current repository relationships cannot establish relationships in a historical request.
  for (const edge of manifest ? [] : snapshot.relations) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) continue
    result.push({ data: { id: edge.id, source: edge.from, target: edge.to, label: edge.kind, inferred: edge.inferred, reason: edge.reason } })
  }
  return result
}
