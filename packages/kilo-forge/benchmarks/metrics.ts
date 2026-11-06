export function coverage(paths: readonly string[], required: readonly string[], supporting: readonly string[]) {
  const selected = new Set(paths)
  const targets = new Set(required)
  const context = new Set(supporting)
  const overlap = [...context].filter((file) => targets.has(file))
  if (overlap.length) throw new Error(`Required and supporting labels overlap: ${overlap.join(", ")}`)
  if (!targets.size) throw new Error("At least one required file must be labeled")
  const hits = [...targets].filter((file) => selected.has(file))
  const support = [...context].filter((file) => selected.has(file))
  return {
    files: [...selected].sort(),
    required: hits.length,
    recall: hits.length / targets.size,
    complete: hits.length === targets.size,
    precision: selected.size ? (hits.length + support.length) / selected.size : 0,
    supporting: context.size ? support.length / context.size : null,
    missing: [...targets].filter((file) => !selected.has(file)).sort(),
    unrelated: [...selected].filter((file) => !targets.has(file) && !context.has(file)).sort(),
  }
}
