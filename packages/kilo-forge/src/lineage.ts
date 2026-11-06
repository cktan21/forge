const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/

export function reference(key?: string) {
  return key && uuid.test(key) ? `<forge-preparation request="${key}" />` : ""
}

export const caveat = "Preparation reference observed in the latest user message; not proof of approval, unchanged evidence, or model retention."

export function lineage(messages: unknown) {
  if (!Array.isArray(messages)) return undefined
  const message: unknown = messages.findLast((item: unknown) =>
    item != null && typeof item === "object" && "role" in item && item.role === "user",
  )
  if (!message || typeof message !== "object" || !("content" in message)) return undefined
  const content = message.content
  const text = typeof content === "string" ? content : Array.isArray(content)
    ? content.flatMap((part: unknown) => part && typeof part === "object" && "type" in part &&
        part.type === "text" && "text" in part && typeof part.text === "string" ? [part.text] : []).join("\n")
    : ""
  // Fail closed on oversized or ambiguous input; a reference is never authorization.
  if (text.length > 2_000_000) return undefined
  const matches = [...text.matchAll(/^<forge-preparation request="([^"\n]+)" \/>$/gm)]
  if (matches.length !== 1) return undefined
  const key = matches.at(0)?.at(1)
  return key && uuid.test(key) ? key : undefined
}
