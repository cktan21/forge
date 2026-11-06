import type { Activity, EnhancementProgress } from "./schema"
import { redact } from "./util"

export function group(action: string) {
  if (action.startsWith("Search")) return "search"
  if (action === "Retrieved candidate") return "retrieval"
  if (action === "Selection complete" || action === "Selected for model") return "context"
  if (action === "Evidence rechecked" || action === "Citations verified") return "checks"
  return "repository"
}

export function activity(update?: (value: EnhancementProgress) => void, signal?: AbortSignal) {
  const groups = new Map<string, { total: number; entries: Array<{ order: number; item: Activity }> }>()
  let total = 0
  let updated = 0
  const clean = (text: string, limit: number) => redact(text).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, limit)
  const snapshot = () => ({
    entries: [...groups.values()].flatMap((value) => value.entries).toSorted((a, b) => a.order - b.order).map((value) => value.item),
    counts: Object.fromEntries([...groups].map(([key, value]) => [key, value.total])),
    total,
  })
  return {
    snapshot,
    add: (value: Activity) => {
      if (signal?.aborted) return
      const item = { action: clean(value.action, 128), ...(value.path == null ? {} : { path: clean(value.path, 2048) }), detail: clean(value.detail, 1024) }
      total++
      const key = group(item.action)
      const section = groups.get(key) ?? { total: 0, entries: [] }
      section.total++
      section.entries.push({ order: total, item })
      if (section.entries.length > 20) section.entries.shift()
      groups.set(key, section)
      if (total > 1 && Date.now() - updated < 80) return
      updated = Date.now()
      update?.({ type: "progress", stage: item.action, activity: snapshot() })
    },
  }
}
