export function permutations<T>(items: readonly T[]): T[][] {
  if (!items.length) return [[]]
  return items.flatMap((item, index) =>
    permutations(items.filter((_, next) => next !== index)).map((rest) => [item, ...rest]),
  )
}
