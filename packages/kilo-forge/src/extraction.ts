import { checkpoint } from "./cooperate"
import { generation } from "./generation"
import type { Relation, Source } from "./schema"

// Only relationships reused by the scanner belong to an extraction unit.
const local = new Set(["declares", "contains", "declares-dependency", "declares-column"])

export async function stamp(sources: readonly Source[], signal?: AbortSignal) {
  const pause = checkpoint(signal)
  const records: Source[] = []
  for (const item of sources) {
    await pause()
    // Availability and sharing are reapplied from the authorized collection.
    records.push({
      ...item, status: "current",
      detail: Object.fromEntries(Object.entries(item.detail).filter(([key]) => key !== "extraction" && key !== "providers")),
    })
  }
  return `v1:${await generation(records, [], false, signal)}`
}

export async function extraction(sources: readonly Source[], relations: readonly Relation[], signal?: AbortSignal) {
  const pause = checkpoint(signal)
  const files = new Map(sources.filter((item) => item.method === "file").map((file) => [
    file.id, { file, sources: [] as Source[], relations: [] as Relation[], stamp: "" },
  ]))
  const owners = new Map<string, Set<string>>()
  for (const item of sources) {
    await pause()
    const groups = new Set<string>()
    if (files.has(item.id)) groups.add(item.id)
    if (!item.inferred) {
      for (const key of item.evidence) {
        const group = files.get(key)
        if (!group || (item.uri !== group.file.uri && !(item.method === "manifest" && item.detail.manifest === group.file.uri))) continue
        group.sources.push(item)
        groups.add(key)
      }
    }
    const existing = owners.get(item.id) ?? new Set<string>()
    for (const key of groups) existing.add(key)
    owners.set(item.id, existing)
  }
  for (const edge of relations) {
    await pause()
    if (!local.has(edge.kind)) continue
    for (const key of owners.get(edge.from) ?? []) {
      if (owners.get(edge.to)?.has(key)) files.get(key)!.relations.push(edge)
    }
  }
  for (const group of files.values()) {
    await pause()
    const file = {
      ...group.file,
      detail: Object.fromEntries(Object.entries(group.file.detail).filter(([key]) => key !== "extraction")),
    }
    group.stamp = `v1:${await generation([file, ...group.sources], group.relations, false, signal)}`
  }
  return files
}
