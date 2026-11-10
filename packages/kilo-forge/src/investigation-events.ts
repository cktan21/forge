import type { InvestigationProgress } from "./investigation-schema"

// Coalesce replaceable activity snapshots, never lifecycle transitions. Every
// admitted frame is self-contained; this does not introduce lossy SSE deltas.
export function publisher(update?: (frame: InvestigationProgress) => void, signal?: AbortSignal, clock = Date.now) {
  let sent = -Infinity
  return (snapshot: () => InvestigationProgress, sampled = false) => {
    if (!update || signal?.aborted) return
    const now = clock()
    if (sampled && now - sent < 500) return
    const frame = snapshot()
    if (frame.journal) sent = now
    update(frame)
  }
}
