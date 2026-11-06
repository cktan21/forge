import type { Source } from "./schema"

function binary(a: string, b: string) {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"))
}

function numeric(value?: string) {
  // Match SQLite's REAL cast, including its zero default for nonnumeric text.
  return Number(value?.match(/^[\t\n\v\f\r ]*[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/)?.at(0) ?? 0)
}

export function order(a: Source, b: Source) {
  // Registration IDs and locations are identity, not ranking keys.
  return binary(a.detail.collection != null ? a.detail.document ?? a.label : a.uri,
    b.detail.collection != null ? b.detail.document ?? b.label : b.uri) ||
    binary(a.detail.fileHash ?? a.hash, b.detail.fileHash ?? b.hash) ||
    numeric(a.detail.page) - numeric(b.detail.page) ||
    a.start - b.start || a.end - b.end ||
    binary(a.detail.heading ?? "", b.detail.heading ?? "") ||
    binary(a.text, b.text) || binary(a.label, b.label)
}

const field = (name: string) => `json_extract(s.body, '$.${name}')`

// BLOB comparison uses the same UTF-8 bytes as Buffer.compare, including NULs.
export const ordering = [
  `CAST(CASE WHEN ${field("detail.collection")} IS NOT NULL THEN coalesce(${field("detail.document")}, ${field("label")}) ELSE ${field("uri")} END AS BLOB)`,
  `CAST(coalesce(${field("detail.fileHash")}, ${field("hash")}) AS BLOB)`,
  ...["detail.page", "start", "end"].map((name) => `CAST(coalesce(${field(name)}, 0) AS REAL)`),
  `CAST(coalesce(${field("detail.heading")}, '') AS BLOB)`,
  ...["text", "label"].map((name) => `CAST(${field(name)} AS BLOB)`),
].join(", ")
