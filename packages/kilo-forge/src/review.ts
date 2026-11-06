import type { Selection } from "./schema"

export function details(value: Selection) {
  return [
    `Prepared provider: ${value.provider ?? "not recorded"}`,
    `Routing fingerprint: ${value.destination ?? "not recorded"}`,
    `Evidence budget: ${value.tokens}/${value.budget} estimated tokens (${value.estimator})`,
    `Policy version: ${value.policy ?? "not recorded"}`,
    "These are preparation-time values. Submission rechecks current policy and source eligibility.",
  ]
}

export function compare(current: Selection, previous?: Selection) {
  if (!previous) return ["No previous selection in this review."]
  const before = new Map(previous.matches.map((item) => [item.source.id, item.source]))
  const after = new Map(current.matches.map((item) => [item.source.id, item.source]))
  const added = [...after.values()].filter((item) => !before.has(item.id))
  const removed = [...before.values()].filter((item) => !after.has(item.id))
  const changed = [...after.values()].filter((item) => before.has(item.id) && before.get(item.id)!.hash !== item.hash)
  const rows = [
    ...added.map((item) => `Added ${item.id} @ ${item.hash}`),
    ...removed.map((item) => `Removed ${item.id}: ${current.reasons?.[item.id] ?? "Not selected in the new bundle; cause not recorded"}`),
    ...changed.map((item) => `Version changed ${item.id}: ${before.get(item.id)!.hash} -> ${item.hash}`),
  ]
  const metadata = (["provider", "destination", "policy", "budget", "estimator"] as const).flatMap((key) =>
    previous[key] === current[key] ? [] : [`${key}: ${previous[key] ?? "not recorded"} -> ${current[key] ?? "not recorded"}`],
  )
  return [
    `Selection changes: ${added.length} added, ${removed.length} removed, ${changed.length} versions changed, ${after.size - added.length - changed.length} unchanged.`,
    `Estimated evidence tokens: ${previous.tokens} -> ${current.tokens}. Estimates are not measured usage.`,
    ...metadata,
    ...rows.slice(0, 100),
    ...(rows.length > 100 ? [`${rows.length - 100} further source changes not displayed.`] : []),
    "Comparison is between reviewed bundles, not proof of transmission or model retention.",
  ]
}
