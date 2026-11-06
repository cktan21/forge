import { createHash } from "node:crypto"
import path from "node:path"

export const stopwords = new Set("a an and are as at be been being both by can could did do does doing for from had has have having he her here hers him his how i if in into is it its itself may me might more most my of on once only or other our ours out over own same she should so some such than that the their theirs them themselves then there these they this those through to too under until up very was we were what when where which while who whom why will with would you your yours".split(" "))

export function literals(text: string) {
  return (text.match(/[\p{L}\p{N}]+(?:[./_:-][\p{L}\p{N}]+)+|[\p{L}\p{N}]*[a-z][A-Z][\p{L}\p{N}]*/gu) ?? []).flatMap(terms)
}

export function keywords(text: string) {
  const all = terms(text)
  // Function words inside explicit paths and identifiers are lookup evidence.
  const literal = new Set(literals(text))
  const words = all.filter((word) => literal.has(word) || !stopwords.has(word))
  return words.length ? words : all
}

export function hash(value: string) {
  return createHash("sha256").update(value).digest("hex")
}

export function id(...parts: string[]) {
  return hash(parts.join("\0")).slice(0, 24)
}

export function inside(root: string, file: string) {
  const relative = path.relative(root, file)
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

export function redact(text: string): string {
  if (/^\s*[[{]/.test(text)) {
    try {
      const value: unknown = JSON.parse(text)
      const safe = JSON.stringify(value, sanitize)
      if (safe !== JSON.stringify(value)) return safe
    } catch (err) {
      // Source excerpts need not be valid JSON; retain them and redact text below.
      if (!(err instanceof SyntaxError)) throw err
    }
  }
  return text
    // Keep complete JSON string pairs together so escaped keys redact the entire decoded value, even in prose.
    .replace(
      /("(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[\da-fA-F]{4}))*")(?:(\s*:\s*)("(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[\da-fA-F]{4}))*"))?/g,
      (match, key: string, separator: string | undefined, literal: string | undefined) => {
        if (literal != null) {
          const value: string = JSON.parse(literal)
          const safe = sanitize(JSON.parse(key), value)
          return safe === value ? match : `${key}${separator}${JSON.stringify(safe)}`
        }
        if (!key.includes("\\")) return match
        const value: string = JSON.parse(key)
        const safe = redact(value)
        return safe === value ? match : JSON.stringify(safe)
      },
    )
    .replace(/(authorization["']?(?:[ \t]|\\+t)*[=:](?:[ \t]|\\+t)*["']?)(?:(?:bearer|basic)(?:[ \t]|\\+t)+)?[^\s\\"',;]+/gi, "$1[REDACTED]")
    .replace(/\b(?:sk|pk|ghp|gho|github_pat)[-_][A-Za-z0-9_-]{16,}\b/g, "[REDACTED]")
    .replace(/((?:password|passwd|api[_-]?key|access[_-]?token|secret)["']?\s*[=:]\s*["']?)[^\s"',;]{4,}/gi, "$1[REDACTED]")
    .replace(/(\w+:\/\/)[^\s/:]+:[^\s/@]+@/g, "$1[REDACTED]@")
}

/** JSON replacer: redact structured credentials and text before serialization adds escapes. */
export function sanitize(key: string, value: unknown): unknown {
  if (typeof value === "function") return undefined
  if (typeof value !== "string") return value
  if (/^(?:(?:proxy-)?authorization|password|passwd|api[_-]?key|access[_-]?token|secret)$/i.test(key)) return "[REDACTED]"
  return redact(value)
}

/** Conservatively budget UTF-8 bytes; this is an upper bound for byte-fallback tokenizers. */
export function tokens(text: string) {
  return new TextEncoder().encode(text).length
}

export function terms(text: string) {
  return [...new Set(text.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [])]
}

export function message(err: unknown) {
  return err instanceof Error ? err.message : String(err)
}
