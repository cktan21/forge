import path from "node:path"
import type { Source } from "./schema"

const formats = [
  { id: "pdf", label: "PDFs", extensions: [".pdf"] },
  { id: "word", label: "Word Documents", extensions: [".docx", ".doc"] },
  { id: "markdown", label: "Markdown", extensions: [".md", ".mdx"] },
  { id: "text", label: "Text Documents", extensions: [".txt", ".rst"] },
  { id: "web", label: "Web Documents", extensions: [".html", ".htm"] },
]

export const labels: Record<string, string> = {
  agent: "Agents", directory: "Directories", code: "Code", symbol: "Symbols",
  test: "Tests", document: "Other Documents", dependency: "Dependencies",
  schema: "Schemas", configuration: "Configuration", instruction: "Instructions",
  goal: "Goals", memory: "Memory", history: "History", tool: "Tools",
  attachment: "Attachments", summary: "Summaries", opportunity: "Opportunities",
  ...Object.fromEntries(formats.map((format) => [format.id, format.label])),
}

export function references(root = ".") {
  const paths = /^[a-z]:[\\/]|^\\\\/i.test(root) ? path.win32 : path.posix
  return paths.join(root, "references")
}

export function category(source: Pick<Source, "kind" | "uri" | "detail">) {
  if (source.kind !== "document" && source.kind !== "attachment") return source.kind
  const name = (source.detail?.document || source.uri).toLowerCase().split(/[?#]/).at(0) ?? ""
  return formats.find((format) => format.extensions.some((extension) => name.endsWith(extension)))?.id ?? source.kind
}

// Share extension definitions with SQLite so category filtering happens before paging.
const location = "coalesce(nullif(json_extract(body, '$.detail.document'), ''), json_extract(body, '$.uri'), '')"
const filename = `lower(substr(${location}, 1, min(coalesce(nullif(instr(${location}, '?'), 0), length(${location}) + 1), coalesce(nullif(instr(${location}, '#'), 0), length(${location}) + 1)) - 1))`
export const classification = "CASE WHEN json_extract(body, '$.kind') IN ('document', 'attachment') THEN CASE "
  + formats.map((format) => `WHEN ${format.extensions.map((extension) => `${filename} LIKE '%${extension}'`).join(" OR ")} THEN '${format.id}'`).join(" ")
  + " ELSE json_extract(body, '$.kind') END ELSE json_extract(body, '$.kind') END"
