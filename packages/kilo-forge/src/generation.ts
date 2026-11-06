import { createHash } from "node:crypto"
import type { Source, Relation } from "./schema"
import { checkpoint } from "./cooperate"

export async function generation(sources: readonly Source[], relations: readonly Relation[], partial: boolean, signal?: AbortSignal) {
  const pause = checkpoint(signal)
  const records: string[] = []
  const edges: string[] = []
  for (const item of sources) {
    await pause()
    records.push(JSON.stringify(Object.entries(item).filter(([key]) => key !== "observed").sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, key === "detail" ? Object.entries(item.detail).sort(([a], [b]) => a.localeCompare(b)) : value])))
  }
  for (const item of relations) {
    await pause()
    edges.push(JSON.stringify(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))))
  }
  records.sort()
  await pause()
  edges.sort()
  await pause()
  // Emit the exact legacy JSON bytes, including its double-encoded records,
  // without constructing and hashing one catalog-sized string synchronously.
  const digest = createHash("sha256")
  for (const [name, items] of [["sources", records], ["relations", edges]] as const) {
    digest.update(name === "sources" ? '{"sources":[' : '],"relations":[')
    for (const [index, item] of items.entries()) {
      await pause()
      if (index) digest.update(",")
      digest.update(JSON.stringify(item))
    }
  }
  signal?.throwIfAborted()
  return digest.update(`],"partial":${partial}}`).digest("hex")
}
