import type { Attempt, Manifest } from "./schema"

export function attempts(value: Manifest) {
  if (value.attempts == null) return "Transport attempt history unavailable for this capture."
  return `${value.attempts.length} transport attempts retained; ${value.discarded ?? 0} older attempts omitted. Entry stages follow the latest started attempt.`
}

export function outcome(value: Attempt) {
  const state = value.state === "response" ? `HTTP ${value.status ?? "unknown"}; ${value.membership === "matched" ? `${value.sent.length} excerpt matches` : "membership unknown"}`
    : value.state === "blocked" ? "blocked before fetch"
    : value.state === "error" ? "fetch error; transmission unknown"
    : "pending; outcome unknown"
  const elapsed = value.finished == null ? "" : `; ${Math.max(0, value.finished - value.started)} ms`
  return `Attempt ${value.sequence}: ${state}${elapsed}`
}
