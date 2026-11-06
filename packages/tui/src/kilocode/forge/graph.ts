import type { Manifest, Source, View } from "@kilocode/forge/schema"
import { category } from "@kilocode/forge/references"

export type Node = {
  id: string
  label: string
  caption: string
  category?: string
  source?: Source
  x: number
  y: number
  width: number
  height: number
}

export function projection(view?: View, manifest?: Manifest): Source[] {
  if (!manifest) return [...view?.sources ?? []]
  const indexed = new Map(view?.sources.map((source) => [source.id, source]))
  return [...new Map(manifest.entries.map((entry) => {
    const current = indexed.get(entry.source)
    const same = current != null && current.hash === entry.hash
    const source: Source = {
      id: entry.source, label: entry.label ?? (same ? current.label : entry.source),
      kind: entry.kind ?? (same ? current.kind : "tool"),
      uri: entry.uri ?? (same ? current.uri : "Captured request source"),
      hash: entry.hash, text: entry.text ?? "", start: same ? current.start : 0,
      end: same ? current.end : 0, observed: manifest.observed, method: "request-capture",
      status: same ? current.status : "stale", inferred: same ? current.inferred : false,
      evidence: [], detail: {
        ...(same ? current.detail : {}), stage: entry.stage, request: manifest.id,
        coverage: same ? "Captured excerpt; version matches this source page" : "Historical excerpt; current version differs or is not on this page",
      },
    }
    return [source.id, source] as const
  })).values()]
}

export function counts(sources: readonly Source[]) {
  const groups: Record<string, number> = {}
  for (const source of sources) {
    const key = category(source)
    groups[key] = (groups[key] ?? 0) + 1
  }
  return groups
}

export function capacity(height: number) {
  return Math.max(2, Math.floor(height / 4) * 2)
}

export function layout(items: readonly Omit<Node, "x" | "y" | "width" | "height">[], width: number, height: number, model: string) {
  const centre = Math.min(30, Math.max(14, Math.floor(width / 3)))
  const side = Math.max(6, Math.min(28, Math.floor((width - centre - 6) / 2)))
  const root: Node = {
    id: "forge", label: "Forge", caption: model.split("/").at(-1) || model,
    x: Math.floor((width - centre) / 2), y: Math.floor((height - 4) / 2),
    width: centre, height: 4,
  }
  const rows = Math.ceil(items.length / 2)
  return [root, ...items.map((item, index): Node => ({
    ...item, width: side, height: 4,
    x: index % 2 ? width - side - 1 : 1,
    y: rows <= 1 ? Math.floor((height - 4) / 2) : Math.round(Math.floor(index / 2) * (height - 4) / (rows - 1)),
  }))]
}

export function move(nodes: readonly Node[], id: string, direction: "up" | "down" | "left" | "right") {
  const current = nodes.find((node) => node.id === id) ?? nodes.at(0)
  if (!current) return id
  const dx = direction === "left" ? -1 : direction === "right" ? 1 : 0
  const dy = direction === "up" ? -1 : direction === "down" ? 1 : 0
  const candidates = nodes.flatMap((node) => {
    if (node.id === current.id) return []
    const x = node.x + node.width / 2 - current.x - current.width / 2
    const y = node.y + node.height / 2 - current.y - current.height / 2
    const forward = x * dx + y * dy
    if (forward <= 0) return []
    return [{ id: node.id, score: Math.hypot(x, y) + Math.abs(x * dy - y * dx) * 2 }]
  }).sort((a, b) => a.score - b.score)
  return candidates.at(0)?.id ?? id
}

export function connections(nodes: readonly Node[], width: number, height: number) {
  const cells = Array.from({ length: height }, () => Array.from({ length: width }, () => " "))
  const root = nodes.at(0)
  if (!root) return ""
  function put(x: number, y: number, value: string) {
    const row = cells.at(y)
    if (!row || x < 0 || x >= width) return
    const current = row.at(x)
    row[x] = current === " " || current === value ? value : "+"
  }
  for (const node of nodes.slice(1)) {
    const left = node.x < root.x
    const start = left ? node.x + node.width : root.x + root.width
    const end = left ? root.x - 1 : node.x - 1
    const middle = Math.floor((start + end) / 2)
    const from = node.y + 1
    const to = root.y + 1
    for (let x = start; x <= end; x++) put(x, (x < middle) === left ? from : to, "-")
    for (let y = Math.min(from, to); y <= Math.max(from, to); y++) put(middle, y, "|")
  }
  return cells.map((row) => row.join("")).join("\n")
}

export function truncate(value: string, width: number) {
  const text = value.replace(/[\x00-\x1f\x7f]/g, " ")
  const chars = Array.from(text)
  if (chars.length <= width) return text
  if (width <= 3) return ".".repeat(Math.max(0, width))
  return `${chars.slice(0, width - 3).join("")}...`
}
