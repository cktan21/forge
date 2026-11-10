import type { Round } from "@kilocode/forge/investigation"
import type { Source } from "@kilocode/forge/schema"

export function describe(call: Round["inspections"][number], sources: readonly Source[] = []) {
  const clean = (text: string) => text.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 256)
  const input: unknown = (() => {
    try {
      return JSON.parse(call.input)
    } catch (err) {
      if (err instanceof SyntaxError) return undefined
      throw err
    }
  })()
  const value = (key: string) => {
    const text: unknown = input != null && typeof input === "object" && !Array.isArray(input) ? Reflect.get(input, key) : undefined
    return typeof text === "string" ? clean(text) : undefined
  }
  const path = value("path")
  const query = value("query")
  const text = value("text")
  const source = sources.find((item) => item.id === value("id"))
  if (call.tool === "forge_read_file") return path ? `Reading ${path}` : "Reading a repository file"
  if (call.tool === "forge_search_code") return query ? `Searching repository for "${query}"` : "Searching repository code"
  if (call.tool === "forge_search_docs") return query ? `Searching documentation for "${query}"` : "Searching documentation"
  if (call.tool === "forge_lookup") return path && text ? `Finding files matching "${path}" and "${text}"`
    : path ? `Finding files matching "${path}"` : text ? `Finding files containing "${text}"` : "Finding repository files"
  if (call.tool === "forge_get_symbol") return source ? `Inspecting ${clean(source.uri)}:${source.start}-${source.end}` : "Inspecting source details"
  if (call.tool === "forge_relationships") return source ? `Following imports and callers of ${clean(source.uri)}` : "Following source imports and callers"
  if (call.tool === "forge_finish") return "Preparing findings from the inspected evidence"
  return "Inspecting repository evidence"
}

export function progress(turn: Round, sources: readonly Source[] = []) {
  if (turn.state === "failed" || turn.state === "cancelled" || turn.state === "limited") return turn.summary
  if (turn.state === "model") return turn.final ? "Preparing findings from the inspected evidence" : "Waiting for the next model update"
  const call = turn.inspections.find((item) => item.state === "running")
    ?? turn.inspections.find((item) => item.state === "requested")
    ?? turn.inspections.at(-1)
  if (!call) return "No inspection was requested"
  const item = call.state === "running" ? call.activity?.entries.at(-1) : undefined
  if (item?.action === "Scan repository") return "Scanning repository inventory"
  if (item?.action === "Wait for inventory") return "Waiting for the existing repository scan"
  if (item?.action === "Use indexed inventory") return "Using the existing repository inventory"
  if (item?.action === "Read locally" && item.path) return `Reading ${item.path}`
  if (item?.action === "Parse locally" && item.path) return `Parsing ${item.path}`
  if (item?.action === "Retrieved candidate" && item.path) return `Matching ${item.path}`
  if (item?.action === "Selected for model" && item.path) return `Selecting context from ${item.path}`
  if (item?.action === "Evidence rechecked" && item.path) return `Checking evidence from ${item.path}`
  const label = describe(call, sources)
  if (call.state === "requested") return `Next: ${label}`
  if (call.state === "skipped") return `Skipped: ${label}`
  if (call.state === "discarded") return `Discarded result: ${label}`
  if (call.state === "failed") return `Inspection failed: ${label}`
  return label
}
