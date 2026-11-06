import type { Match } from "./schema"
import { EnhancementError, failure } from "./enhancement"

export function citations(values: readonly string[], matches: readonly Match[]) {
  const known = new Map(matches.map((match) => [match.source.id, match.source]))
  const named = (source: Match["source"], uri: string) =>
    source.uri === uri || (source.method === "collection-section" && source.detail.document === uri)
  const error = "The model cited evidence outside this revision or an ambiguous file reference. Your prompt and answers were kept. Retry with the current context; only its retrieved evidence can be cited."
  const ids = new Set<string>()
  let changed = 0
  for (const value of values) {
    const key = value.trim().replace(/^\[([^\]]+)\]$|^`([^`]+)`$/g, "$1$2")
    if (known.has(key)) {
      ids.add(key)
      if (key !== value) changed++
      continue
    }
    // Only recover a missing final hex character, never edit-distance guesses.
    const prefixes = /^[a-f0-9]{23}$/.test(key)
      ? [...known.keys()].filter((id) => /^[a-f0-9]{24}$/.test(id) && id.startsWith(key))
      : []
    if (prefixes.length) {
      if (prefixes.length !== 1) throw new EnhancementError(error, failure("citation"))
      ids.add(prefixes.at(0)!)
      changed++
      continue
    }
    const range = key.match(/^(.*?)(?::(\d+)(?:-(\d+))?|#L(\d+)(?:-L?(\d+))?)$/)
    const uri = (range?.at(1) ?? key).replace(/^\.\//, "")
    const start = Number(range?.at(2) ?? range?.at(4))
    const end = Number(range?.at(3) ?? range?.at(5) ?? start)
    const exact = matches.filter(({ source }) => named(source, key.replace(/^\.\//, "")))
    const candidates = exact.length ? exact : matches.filter(({ source }) =>
      named(source, uri) && (!range || (start >= source.start && end >= start && end <= source.end)))
    if (candidates.length !== 1) {
      throw new EnhancementError(error, failure("citation"))
    }
    ids.add(candidates.at(0)!.source.id)
    changed++
  }
  return { ids: [...ids], changed }
}
