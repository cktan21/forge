import { limits, type Observation } from "./investigation-schema"
import { hash, tokens } from "./util"

export function checkpoint(observations: readonly Observation[]) {
  if (!observations.length)
    return "Preparation checkpoint: no inspections yet. Clarify only missing user intent; otherwise use the request to choose a targeted starting point. A clear diagnostic request can be handed off without proving its cause."
  const direct = observations.some(
    (item) => !item.rejected && item.sources.length && ["forge_read_file", "forge_get_symbol"].includes(item.tool),
  )
  const stage = direct
    ? "Direct source has been inspected. For proactive assessment, finish when concrete candidate improvements can be offered, not merely because one file was read. If that file only wires components together, follow the relevant implementation before inferring a gap. Additional inspection needs a specific gap that would change the brief, not just increase confidence."
    : "Discovery results are available. Use the strongest relevant result for a targeted read if needed; do not restart broad discovery. If no useful source was found, hand off the scoped diagnostic task with that limitation."
  const latest = observations.at(-1)!
  const batch = observations.filter((item) => item.turn === latest.turn)
  const prior = new Set(
    observations
      .filter((item) => item.turn !== latest.turn)
      .flatMap((item) => item.sources.map((source) => `${source.id}:${source.hash}`)),
  )
  const repeated =
    prior.size > 0 &&
    batch.every(
      (item) => item.sources.length > 0 && item.sources.every((source) => prior.has(`${source.id}:${source.hash}`)),
    )
  return `Preparation checkpoint: ${stage}${
    repeated
      ? " The latest inspections returned only previously available source versions. Reuse that evidence; finish unless a different targeted check is necessary. Repetition does not strengthen a finding."
      : ""
  }`
}

function continuation(item: Observation) {
  if (item.tool !== "forge_read_file") return {}
  try {
    const value: unknown = JSON.parse(item.output)
    if (value == null || typeof value !== "object") return {}
    return Object.fromEntries(
      ["total", "next"].flatMap((key) => {
        const count: unknown = Reflect.get(value, key)
        return typeof count === "number" && Number.isSafeInteger(count) && count > 0 ? [[key, count]] : []
      }),
    )
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err
    return {}
  }
}

export function history(observations: readonly Observation[]) {
  const direct = (item: Observation) =>
    item.sources.length > 0 && (item.tool === "forge_read_file" || item.tool === "forge_get_symbol")
  const latest = new Map<string, string>()
  const signatures = new Map(
    observations.map((item) => [
      item.id,
      hash(
        JSON.stringify([
          direct(item) ? "direct" : item.tool,
          item.sources.map((source) => [source.id, source.hash, source.detail]),
          direct(item) ? undefined : item.output,
        ]),
      ),
    ]),
  )
  for (const item of observations) latest.set(signatures.get(item.id)!, item.id)
  const metadata = new Map<
    string,
    {
      omitted: string
      duplicateOf?: string
      sources: { id: string; path: string; start: number; end: number }[]
      omittedSources: number
    }
  >()
  const values = observations.map((item) => {
    const duplicate = latest.get(signatures.get(item.id)!)!
    const summary = {
      omitted: "Earlier output omitted from this turn. Inspect again if needed.",
      ...(duplicate !== item.id && tokens(duplicate) <= 256 ? { duplicateOf: duplicate } : {}),
      ...continuation(item),
      sources: [],
      omittedSources: item.sources.length,
    }
    metadata.set(item.id, summary)
    return {
      id: item.id,
      tool: item.tool,
      input:
        item.input != null && typeof item.input === "object" && !Array.isArray(item.input)
          ? Object.fromEntries(Object.entries(item.input).filter(([key]) => key !== "purpose"))
          : item.input,
      output: JSON.stringify(summary),
    }
  })
  const selected = new Map(values.map((item) => [item.id, item]))
  let remaining = limits.evidence - values.reduce((sum, item) => sum + tokens(item.output), 0)
  const recent = observations.toReversed()
  const ordered = [...recent.filter(direct), ...recent.filter((item) => !direct(item))]
  const known = new Set<string>()
  // Direct evidence wins over broad search output. The original journal stays intact.
  for (const item of ordered) {
    if (latest.get(signatures.get(item.id)!) !== item.id) continue
    const value = selected.get(item.id)!
    const cost = tokens(item.output) - tokens(value.output)
    if (cost > remaining) continue
    remaining -= cost
    value.output = item.output
    for (const source of item.sources) known.add(source.id)
  }
  // References use only the remaining space, rather than reserving an unbounded
  // inventory before evidence. Complete paths are either included or omitted.
  let allowance = Math.min(remaining, Math.floor(limits.evidence / 4))
  for (const item of ordered) {
    const value = selected.get(item.id)!
    if (value.output === item.output) continue
    for (const source of item.sources) {
      if (known.has(source.id)) continue
      const summary = metadata.get(item.id)!
      const next = {
        ...summary,
        sources: [...summary.sources, { id: source.id, path: source.uri, start: source.start, end: source.end }],
        omittedSources: summary.omittedSources - 1,
      }
      const output = JSON.stringify(next)
      const cost = tokens(output) - tokens(value.output)
      if (cost > allowance) continue
      allowance -= cost
      metadata.set(item.id, next)
      value.output = output
      known.add(source.id)
    }
  }
  return values
}
