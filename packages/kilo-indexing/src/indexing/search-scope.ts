import type { Payload } from "./interfaces/vector-store"

// This is an internal, serializable excerpt policy, not a vector-store ACL.
// Order preserves the caller's exact-text, containing-window, file fallback mapping.
export type SearchScope = readonly {
  paths: readonly string[]
  text: string
  fallback: boolean
  passages: readonly { text: string; start: number; end: number; window: boolean; allowed: boolean }[]
}[]

export const MASK_LIMIT = 10_000

export function permitted(payload: Payload | null | undefined, scope: SearchScope): boolean {
  if (!payload || typeof payload.filePath !== "string" || typeof payload.codeChunk !== "string" || !payload.codeChunk) return false
  if (!Number.isFinite(payload.startLine) || !Number.isFinite(payload.endLine)) return false
  const file = scope.find((item) => item.paths.includes(payload.filePath))
  if (!file || !file.text.includes(payload.codeChunk)) return false
  const passage = file.passages.find((item) => item.text === payload.codeChunk)
    ?? file.passages.find((item) => item.window && item.start <= payload.startLine && item.end >= payload.startLine)
  return passage?.allowed ?? file.fallback
}
