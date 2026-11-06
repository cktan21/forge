import type { Collection, ImportHistory } from "./schema"

export function activity(value: NonNullable<Collection["progress"]>) {
  if (value.started == null || value.deadline == null) return "Completion time unavailable."
  const elapsed = Math.max(0, Math.floor((value.updated - value.started) / 1000))
  const remaining = Math.max(0, Math.ceil((value.deadline - value.updated) / 1000))
  return `${elapsed}s elapsed at last update. ${remaining}s until deadline; not a completion estimate.`
}

export function outcome(value: NonNullable<Collection["result"]>) {
  const elapsed = Math.max(0, (value.finished - value.started) / 1000).toFixed(1)
  return `Last run ${value.state}: ${value.extracted} parsed, ${value.reused} reused, ${value.empty} without text, ${value.failed} file errors; ${value.bytes} bytes read in ${elapsed}s.`
}

export function history(value: ImportHistory) {
  const run = value.selected
  if (!run) return ["No retained import history. Older imports may have only aggregate results."]
  return [
    `Import run ${run.state}; started ${new Date(run.started).toISOString()}.`,
    `Last stage: ${run.stage}; ${run.count} authorized document attempts; ${run.withheld} withheld entries.`,
    ...(run.generation ? [`Published generation: ${run.generation}`] : []),
    ...value.documents.map((item) => `${item.name}: ${item.state === "processing" && run.state !== "running" ? "unfinished (last observed processing)" : item.state}; ${item.bytes} bytes; ${item.chunks} records.`),
    `Documents ${value.page.total ? value.page.offset + 1 : 0}-${value.page.offset + value.documents.length} of ${value.page.total ?? run.count}.`,
    "Last 16 runs retained per collection. Checkpoints can omit work after the last write. Running is not proof of a live process; extraction is not proof of publication. Denied paths and document contents are not recorded here.",
  ]
}
