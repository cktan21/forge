import { usage, type Manifest, type ModelUsage } from "./schema"

/** Reconcile retained HTTP attempts, not historical coverage or provider invoices. */
export function reconcile(value: Manifest) {
  const attempts = value.attempts ?? []
  const reports = attempts.flatMap((attempt) => {
    const report = attempt.response?.usage
    return attempt.state === "response" &&
      attempt.status != null &&
      attempt.status >= 200 &&
      attempt.status < 300 &&
      report &&
      !report.invalid
      ? [report]
      : []
  })
  const count = (value: number | undefined) => value != null && Number.isSafeInteger(value) && value >= 0
  const known = (report: ModelUsage) => count(report.input) && count(report.output)
  const total = reports.reduce(
    (sum, report) => ({
      ...sum,
      input: sum.input + (report.input ?? 0),
      output: sum.output + (report.output ?? 0),
      cached: sum.cached + (report.cached ?? 0),
    }),
    { ...usage(value.model), milliseconds: value.usage.milliseconds, measured: reports.length > 0 },
  )
  const safe = [total.input, total.output, total.cached, total.input + total.output].every(count)
  const fallback =
    value.usage.measured &&
    [value.usage.input, value.usage.output, value.usage.cached].every(count) &&
    value.usage.cached <= value.usage.input &&
    value.usage.input + value.usage.output > 0
  // Final adapter usage overlaps response reports. Keep one whole measurement,
  // never add it again or independently maximize overlapping token categories.
  const selected =
    fallback && (!safe || value.usage.input + value.usage.output > total.input + total.output)
      ? value.usage
      : safe
        ? total
        : usage(value.model)
  const complete =
    value.attempts != null &&
    value.discarded === 0 &&
    attempts.length > 0 &&
    (value.state === "completed" || value.state === "failed") &&
    safe &&
    new Set(attempts.map((attempt) => attempt.id)).size === attempts.length &&
    attempts.every(
      (attempt, index) =>
        attempt.sequence === index + 1 &&
        (attempt.state === "blocked" ||
          (attempt.state === "response" &&
            attempt.status != null &&
            attempt.status >= 200 &&
            attempt.status < 300 &&
            attempt.response?.state === "completed" &&
            attempt.response.usage != null &&
            !attempt.response.usage.invalid &&
            known(attempt.response.usage))),
    ) &&
    !(fallback && (value.usage.input > total.input || value.usage.output > total.output))
  return {
    usage: selected,
    complete,
    priced: complete && reports.every((report) => count(report.cached)),
    attempts: attempts.length,
    reports: reports.length,
    unknown: attempts.filter(
      (attempt) =>
        attempt.state !== "blocked" &&
        (attempt.state !== "response" ||
          attempt.status == null ||
          attempt.status < 200 ||
          attempt.status >= 300 ||
          attempt.response?.state !== "completed" ||
          !attempt.response.usage ||
          attempt.response.usage.invalid ||
          !known(attempt.response.usage)),
    ).length,
    discarded: value.discarded ?? null,
  }
}
