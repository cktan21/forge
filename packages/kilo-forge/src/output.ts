import { parse, type ParseError } from "jsonc-parser"
import { EnhancementError, failure } from "./enhancement"

export function object(text: string): unknown {
  const body = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "")
  const start = body.indexOf("{")
  const end = body.lastIndexOf("}")
  if (start < 0 || end < start || body.length > 100_000) {
    throw new EnhancementError("The model returned incomplete or invalid JSON. Your prompt was kept. Retry enhancement or choose another model.", failure("json"))
  }
  const errors: ParseError[] = []
  const value: unknown = parse(body.slice(start, end + 1), errors, { allowTrailingComma: true })
  if (errors.length || value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new EnhancementError("The model returned incomplete or invalid JSON. Your prompt was kept. Retry enhancement or choose another model.", failure("json"))
  }
  return value
}
