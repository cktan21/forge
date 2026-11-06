import type { Source } from "./schema"

// Metadata only: bind both the excerpt identity and its original document version.
export function binding(source: Source) {
  return JSON.stringify([
    "forge-pin-v1", source.hash, source.uri, source.kind, source.method,
    source.start, source.end, source.detail.page ?? "", source.detail.fileHash ?? "",
  ])
}
