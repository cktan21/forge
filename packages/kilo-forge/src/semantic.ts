import type { Semantic } from "./schema"

// Readiness is an observation, not a request to initialize or build an index.
export function readiness(value?: { initialized: boolean; state: string }): Semantic {
  if (!value) return { state: "uninitialized", searchable: false }
  if (value.state === "Disabled") return { state: "disabled", searchable: false }
  if (value.state === "Error") return { state: "error", searchable: false }
  if (!value.initialized) return { state: "initializing", searchable: false }
  if (value.state === "In Progress") return { state: "indexing", searchable: true }
  if (value.state === "Standby") return { state: "paused", searchable: true }
  if (value.state === "Complete") return { state: "ready", searchable: true }
  return { state: "unknown" }
}

export function semantic(value?: Semantic) {
  if (!value) return "Semantic index: readiness not reported."
  const label = value.state === "uninitialized" ? "not initialized" : value.state
  const search = value.searchable == null ? "search capability unknown"
    : value.searchable ? "search available; completeness and freshness not guaranteed" : "search unavailable"
  return `Semantic index: ${label}; ${search}.`
}

export const coverage = "Repository semantic search reuses Kilo's repository-file index. Collection semantic search requires separate host configuration, destination approval and explicit indexing; repository readiness does not describe collection coverage."
