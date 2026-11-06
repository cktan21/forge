import type { Source } from "./schema"
import type { SearchScope } from "@kilocode/kilo-indexing/search-scope"
import { fresh } from "./catalog"

export async function scope(root: string, sources: readonly Source[], excluded: ReadonlySet<string>, signal?: AbortSignal): Promise<SearchScope> {
  const grouped = new Map<string, Source[]>()
  for (const item of sources) {
    const group = grouped.get(item.uri) ?? []
    group.push(item)
    grouped.set(item.uri, group)
  }
  const result: Array<SearchScope[number]> = []
  for (const [uri, items] of grouped) {
    signal?.throwIfAborted()
    const file = items.find((item) => item.method === "file" && !item.detail.collection)
    if (!file || file.status !== "current" || !file.text || uri.includes(":")) continue
    if (!await fresh(root, file).catch(() => false)) continue
    signal?.throwIfAborted()
    const passages = items.map((item) => ({
      text: item.text, start: item.start, end: item.end, window: item.method === "line-window",
      allowed: item.status === "current" && !excluded.has(item.id),
    }))
    if (!passages.some((item) => item.allowed)) continue
    result.push({ paths: [uri], text: file.text, fallback: !excluded.has(file.id), passages })
  }
  return result
}
