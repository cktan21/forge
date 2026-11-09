import path from "node:path"
import { constants } from "node:fs"
import { lstat, open, opendir, realpath } from "node:fs/promises"
import ignore from "ignore"
import type { Settings } from "./config"
import type { Source } from "./schema"
import { inside, hash, redact, id } from "./util"
import { source } from "./parse"

export const blocked = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", ".next", "dist", "build", "target", "vendor", ".turbo", ".cache", ".artifacts", ".trae"])
export const supported = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".md", ".mdx", ".rst", ".txt", ".json", ".jsonc", ".toml", ".yaml", ".yml", ".sql", ".prisma", ".lock"])
export const secret = /(?:^|\/)(?:\.env(?:\..*)?|.*\.(?:pem|key|p12|pfx)|credentials(?:\..*)?|secrets?(?:\..*)?)$/i

export function kind(file: string): Source["kind"] {
  if (/(?:^|\/)(?:AGENTS|CLAUDE)\.md$/.test(file)) return "instruction"
  if (/(?:^|\/)(?:test|tests|__tests__)\/|(?:[._-](?:test|spec)\.)|(?:^|\/)test_/.test(file)) return "test"
  if (/\.(mdx?|rst|txt)$/.test(file)) return "document"
  if (/\.(sql|prisma)$/.test(file)) return "schema"
  if (/\.(jsonc?|toml|ya?ml|lock)$/.test(file)) return "configuration"
  return "code"
}

async function bytes(file: string, limit: number, signal?: AbortSignal) {
  signal?.throwIfAborted()
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.size > limit) throw new Error("Repository file is not a bounded regular file")
    const buffer = Buffer.alloc(limit + 1)
    let length = 0
    while (length < buffer.length) {
      signal?.throwIfAborted()
      const result = await handle.read(buffer, length, buffer.length - length, length)
      if (!result.bytesRead) break
      length += result.bytesRead
    }
    const after = await handle.stat()
    const current = await lstat(file)
    if (length > limit) throw new Error("Repository file exceeds its byte limit")
    if (before.dev !== current.dev || before.ino !== current.ino || current.isSymbolicLink()
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || current.size !== after.size || current.mtimeMs !== after.mtimeMs || current.ctimeMs !== after.ctimeMs) {
      throw new Error("Repository file changed during reading")
    }
    signal?.throwIfAborted()
    return buffer.subarray(0, length)
  } finally {
    await handle.close()
  }
}

// Recheck inherited ignore policies on direct reads, including unindexed paths.
export async function permitted(root: string, uri: string, cfg: Pick<Settings, "exclude">, signal?: AbortSignal, historical = false) {
  signal?.throwIfAborted()
  if (!uri || uri.includes("\0") || uri.includes("\\") || path.isAbsolute(uri) || /^[a-z]:/i.test(uri)) throw new Error("Expected a repository-relative path")
  const canonical = await realpath(root)
  const relative = path.posix.normalize(uri)
  const absolute = path.resolve(canonical, relative)
  if (!inside(canonical, absolute) || absolute === canonical || relative.split("/").some((part) => blocked.has(part))
    || secret.test(relative) || !supported.has(path.extname(relative))) throw new Error("Repository path is not eligible for inspection")
  const excluded = ignore().add(cfg.exclude)
  const parts = relative.split("/")
  const rules: Array<{ base: string; matcher: ReturnType<typeof ignore> }> = []
  const policies: Array<{ path: string; digest?: string }> = []
  for (let index = 0; index < parts.length; index++) {
    signal?.throwIfAborted()
    const base = parts.slice(0, index).join("/")
    const matcher = ignore()
    for (const name of [".gitignore", ".kilocodeignore"]) {
      const file = path.join(canonical, base, name)
      const entry = await lstat(file).catch((err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT") return undefined
        throw err
      })
      if (!entry) { policies.push({ path: file }); continue }
      if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("Ignore policy cannot be safely read")
      const text = (await bytes(file, 100_000, signal)).toString("utf8")
      matcher.add(text)
      policies.push({ path: file, digest: hash(text) })
    }
    rules.push({ base, matcher })
    const prefix = parts.slice(0, index + 1).join("/")
    const directory = index < parts.length - 1
    if (excluded.ignores(prefix + (directory ? "/" : ""))) throw new Error("Repository path is excluded")
    const ignored = rules.reduce((prior, rule) => {
      const result = rule.matcher.test(`${rule.base ? prefix.slice(rule.base.length + 1) : prefix}${directory ? "/" : ""}`)
      return result.unignored ? false : result.ignored ? true : prior
    }, false)
    if (ignored) throw new Error("Repository path is ignored")
    const entry = await lstat(path.join(canonical, prefix)).catch((err: NodeJS.ErrnoException) => {
      if (historical && err.code === "ENOENT") return undefined
      throw err
    })
    if (!entry) continue
    if (entry.isSymbolicLink()) throw new Error("Repository symlinks cannot be inspected")
    if (directory && !entry.isDirectory()) throw new Error("Repository parent is not a directory")
  }
  const resolved = await realpath(absolute).catch((err: NodeJS.ErrnoException) => {
    if (historical && err.code === "ENOENT") return absolute
    throw err
  })
  if (resolved !== absolute) throw new Error("Repository path changed during inspection")
  return { absolute, relative, policies, stamp: hash(JSON.stringify(policies)) }
}

export async function read(root: string, input: { path: string; start?: number; lines?: number }, cfg: Pick<Settings, "bytes" | "exclude">, signal?: AbortSignal) {
  const start = input.start ?? 1
  const count = input.lines ?? 160
  if (!Number.isSafeInteger(start) || start < 1 || !Number.isSafeInteger(count) || count < 1 || count > 160) throw new Error("Invalid repository line range")
  const before = await permitted(root, input.path, cfg, signal)
  const buffer = await bytes(before.absolute, cfg.bytes, signal)
  if (buffer.includes(0)) throw new Error("Binary files cannot be inspected")
  const original = new TextDecoder("utf-8", { fatal: true }).decode(buffer)
  const lines = original.split("\n")
  if (start > lines.length) throw new Error("Requested line is outside the file")
  const selected: string[] = []
  let size = 0
  for (const line of lines.slice(start - 1, start - 1 + count)) {
    const cost = Buffer.byteLength(line) + (selected.length ? 1 : 0)
    if (size + cost > 16_384) break
    selected.push(line)
    size += cost
  }
  if (!selected.length) throw new Error("A source line exceeds the inspection byte limit")
  const after = await permitted(root, input.path, cfg, signal)
  if (before.stamp !== after.stamp || before.absolute !== after.absolute) throw new Error("Repository access changed during reading")
  const file = source(before.relative, original, kind(before.relative))
  const end = start + selected.length - 1
  const text = redact(selected.join("\n"))
  const item = source(file.uri, text, file.kind, {
    id: id(file.id, file.hash, String(start), String(end)), start, end,
    method: "direct-read", evidence: [file.id],
    detail: { fileHash: file.hash, policyHash: before.stamp, truncated: String(end < lines.length) },
  })
  return { source: item, file, total: lines.length, next: end < lines.length ? end + 1 : undefined }
}

export async function lookup(
  root: string,
  input: { path?: string; text?: string },
  inspect: (input: { path: string; start?: number; lines?: number }) => ReturnType<typeof read>,
  signal: AbortSignal,
) {
  const canonical = await realpath(root)
  const pending = [""]
  const sources: Source[] = []
  let visited = 0
  let bytes = 0
  let retained = 0
  let unavailable = false
  let limited = false
  while (pending.length && !limited) {
    signal.throwIfAborted()
    const dir = pending.shift()!
    const handle = await opendir(path.join(canonical, dir)).catch(() => { signal.throwIfAborted(); unavailable = true; return undefined })
    if (!handle) continue
    for await (const entry of handle) {
      signal.throwIfAborted()
      if (++visited > 5000 || bytes >= 8_000_000 || sources.length >= 20) { limited = true; break }
      if (entry.isSymbolicLink() || blocked.has(entry.name)) continue
      const uri = dir ? `${dir}/${entry.name}` : entry.name
      if (secret.test(uri)) continue
      if (entry.isDirectory()) { pending.push(uri); continue }
      if (!entry.isFile() || !supported.has(path.extname(uri)) || input.path && !uri.toLowerCase().includes(input.path.toLowerCase())) continue
      // The supplied reader enforces current permissions, ignores and registration
      // rules before any file body or matching location becomes observable.
      const item = await inspect({ path: uri, lines: 3 }).catch(() => { signal.throwIfAborted(); unavailable = true; return undefined })
      if (!item) continue
      bytes += Buffer.byteLength(item.file.text)
      const line = input.text ? item.file.text.split("\n").findIndex((line) => line.includes(input.text!)) : 0
      if (line < 0) continue
      const found = line === 0 ? item : await inspect({ path: uri, start: line + 1, lines: 3 })
      const cost = Buffer.byteLength(JSON.stringify(found.source))
      if (retained + cost > 20_000) { limited = true; break }
      sources.push(found.source)
      retained += cost
    }
  }
  return { sources, limited, unavailable, visited, note: "Bounded literal lookup, independent of the index. No hits do not establish absence. Use file-range reads for implementation details." }
}
