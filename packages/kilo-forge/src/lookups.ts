const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/

export function marker(key: string) {
  return uuid.test(key) ? `<forge-retrieval request="${key}" />` : ""
}

export const caveat = "Forge-tool references observed in tool results after the latest user message; not proof of approval, full output transmission, or model retention. At most 32 references from the latest 64 messages are resolved."

export function lookups(messages: unknown) {
  if (!Array.isArray(messages)) return []
  const start = messages.findLastIndex((item) => item && typeof item === "object" && item.role === "user")
  if (start < 0) return []
  const references: { id: string; call: string; tool: string }[] = []
  for (const message of messages.slice(start + 1).slice(-64)) {
    if (!message || message.role !== "tool" || !Array.isArray(message.content)) continue
    for (const part of message.content.slice(-64)) {
      if (part?.type !== "tool-result" || typeof part.toolCallId !== "string" || !part.toolCallId || !["forge_search_code", "forge_search_docs", "forge_get_symbol", "forge_relationships"].includes(part.toolName)) continue
      const text = part.output?.type === "text" && typeof part.output.value === "string" ? part.output.value : ""
      if (text.length > 2_000_000) continue
      const found = [...text.matchAll(/^<forge-retrieval request="([^"\n]+)" \/>$/gm)]
      const key = found.length === 1 ? found.at(0)?.at(1) : undefined
      if (!key || !uuid.test(key)) continue
      references.push({ id: key, call: part.toolCallId, tool: part.toolName })
    }
  }
  return references.slice(-32)
}
