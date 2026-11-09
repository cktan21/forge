import path from "node:path"
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises"
import ignore from "ignore"
import { parse as json, type ParseError } from "jsonc-parser"
import { parse as toml } from "smol-toml"
import type { Settings } from "./config"
import type { Snapshot, Source, Relation } from "./schema"
import { parser, source, relation, associations } from "./parse"
import { hash, id, inside, message } from "./util"
import { checkpoint } from "./cooperate"
import { generation as version } from "./generation"
import { extraction } from "./extraction"
import { blocked, supported, secret, kind } from "./repository"

export async function scan(input: {
  root: string; cfg: Settings; previous?: Snapshot; revision?: string; signal?: AbortSignal
  changed?: readonly string[]
  progress?: (files: number) => void
  read?: (file: Source) => void
  parsed?: (file: Source) => void
  visited?: (uri: string) => void
}): Promise<Snapshot> {
  const pause = checkpoint(input.signal)
  const root = await realpath(input.root)
  const cfg = input.cfg
  const sources: Source[] = []
  const relations: Relation[] = []
  const warnings: string[] = []
  const pending: Array<{ file: Source; specifier: string; evidence: string; python: boolean }> = []
  const saved = input.previous?.root === root ? input.previous : undefined
  const cached = await extraction(saved?.sources ?? [], saved?.relations ?? [], input.signal)
  const previous = new Map(saved?.sources.filter((item) => item.method === "file").map((item) => [item.uri, item]))
  // Bump the catalog version when extraction or resolution semantics change.
  const stamp = hash(JSON.stringify(["catalog-v2", cfg.exclude, cfg.files, cfg.bytes]))
  const delta = input.changed != null && saved && !saved.partial && !saved.warnings.length
    && saved.sources.find((item) => item.method === "directory" && item.uri === ".")?.detail.catalog === stamp
    && [...previous.values()].every((item) => item.status === "current" && cached.get(item.id)?.stamp === item.detail.extraction)
    && input.changed.every((uri) => uri && !path.isAbsolute(uri) && !uri.includes("\\") && !uri.split("/").includes("..")
      && !/(?:^|\/)(?:\.gitignore|\.kilocodeignore|forge\.jsonc|tsconfig[^/]*\.json|package\.json|pyproject\.toml|[^/]*lock[^/]*)$/.test(uri))
      ? input.changed : undefined
  const affected = (uri: string) => delta == null || delta.some((item) => item === uri || item.startsWith(`${uri}/`) || uri.startsWith(`${item}/`))
  const unavailable = new Set<string>()
  const parsed = parser()
  const files = new Map<string, Source>()
  const matches = ignore().add(cfg.exclude)
  let partial = false
  let total = 0

  function missing(uri: string, reason: string) {
    unavailable.add(uri)
    warnings.push(`${uri || "."}: ${reason}`)
    partial = true
  }

  function reuse(file: Source) {
    const group = cached.get(file.id)!
    files.set(file.uri, file)
    sources.push(file, ...group.sources)
    relations.push(relation(id(path.posix.dirname(file.uri), "directory"), file.id, "contains", []), ...group.relations)
    if (file.detail.imports) for (const value of JSON.parse(file.detail.imports) as Array<{ specifier: string; evidence: string; python: boolean }>) pending.push({ file, ...value })
  }

  async function visit(dir: string, rules: Array<{ base: string; matcher: ReturnType<typeof ignore> }>) {
    input.signal?.throwIfAborted()
    const relative = path.relative(root, dir).split(path.sep).join("/")
    if (relative && !affected(relative) && saved?.sources.some((item) => item.method === "directory" && item.uri === relative)
      && total + saved.sources.filter((item) => item.method === "file" && item.uri.startsWith(`${relative}/`)).length <= cfg.files) {
      for (const item of saved.sources) {
        await pause()
        if (item.uri !== relative && !item.uri.startsWith(`${relative}/`)) continue
        if (item.method === "directory") {
          sources.push(item)
          relations.push(relation(id(path.posix.dirname(item.uri), "directory"), item.id, "contains", []))
        }
        if (item.method === "file") { total++; reuse(item) }
      }
      input.progress?.(total)
      return
    }
    input.visited?.(relative || ".")
    const directory = source(relative || ".", "", "directory", { method: "directory", label: relative ? path.basename(dir) : path.basename(root), detail: relative ? {} : { catalog: stamp } })
    sources.push(directory)
    if (relative) relations.push(relation(id(path.posix.dirname(relative) === "." ? "." : path.posix.dirname(relative), "directory"), directory.id, "contains", []))
    const local = ignore()
    for (const name of [".gitignore", ".kilocodeignore"]) {
      const file = path.join(dir, name)
      // Only an absent directory entry means no policy; a dangling link is unreadable.
      const text = await lstat(file).then(
        () => readFile(file, "utf8"),
        (err: NodeJS.ErrnoException) => {
          if (err.code === "ENOENT") return ""
          throw err
        },
      ).catch((err) => {
        missing(relative, `${name}: ignore policy unavailable: ${message(err)}`)
        return undefined
      })
      if (text == null) return
      local.add(text)
    }
    const inherited = [...rules, { base: relative, matcher: local }]
    const entries = await readdir(dir, { withFileTypes: true }).catch((err) => {
      missing(relative, message(err))
      return []
    })
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      input.signal?.throwIfAborted()
      if (entry.isSymbolicLink() || blocked.has(entry.name)) continue
      const rel = relative ? `${relative}/${entry.name}` : entry.name
      if (secret.test(rel) || matches.ignores(rel)) continue
      const ignored = inherited.reduce((prior, rule) => {
        const result = rule.matcher.test(`${rule.base ? rel.slice(rule.base.length + 1) : rel}${entry.isDirectory() ? "/" : ""}`)
        return result.unignored ? false : result.ignored ? true : prior
      }, false)
      if (ignored) continue
      if (total >= cfg.files) { missing(rel, "file count limit reached"); continue }
      const absolute = path.join(dir, entry.name)
      if (entry.isDirectory()) { await visit(absolute, inherited); continue }
      if (!entry.isFile() || !supported.has(path.extname(rel))) continue
      total++
      input.progress?.(total)
      const prior = previous.get(rel)
      if (prior && !affected(rel)) { reuse(prior); continue }
      input.visited?.(rel)
      const resolved = await realpath(absolute).catch((err) => { missing(rel, message(err)); return undefined })
      if (!resolved || !inside(root, resolved) || resolved !== absolute) continue
      const info = await stat(resolved).catch((err) => { missing(rel, message(err)); return undefined })
      if (!info) continue
      if (info.size > cfg.bytes) { missing(rel, `exceeds ${cfg.bytes} byte limit`); continue }
      const bytes = await readFile(absolute).catch((err) => { missing(rel, message(err)); return undefined })
      if (!bytes || bytes.includes(0)) continue
      if (bytes.byteLength > cfg.bytes) { missing(rel, `exceeds ${cfg.bytes} byte limit`); continue }
      const file = source(rel, bytes.toString("utf8"), kind(rel))
      input.read?.(file)
      files.set(rel, file)
      relations.push(relation(directory.id, file.id, "contains", []))
      const group = prior && cached.get(prior.id)
      // File bytes and a versioned extraction stamp must agree before reuse.
      // Unstamped legacy snapshots are reparsed once, without trusting cached imports.
      if (prior?.hash === file.hash && prior.text === file.text && prior.status === "current" && group && group.stamp === prior.detail.extraction) {
        sources.push(prior)
        sources.push(...group.sources)
        relations.push(...group.relations)
        const imports = prior.detail.imports
        if (imports) for (const value of JSON.parse(imports) as Array<{ specifier: string; evidence: string; python: boolean }>) pending.push({ file: prior, ...value })
        continue
      }
      input.parsed?.(file)
      const result = await parsed.parse(file).catch((err) => {
        missing(rel, `extraction unavailable: ${message(err)}`)
        return { sources: [], relations: [], imports: [], warnings: [] }
      })
      const updated = { ...file, detail: { ...file.detail, imports: JSON.stringify(result.imports) } }
      files.set(rel, updated)
      sources.push(updated, ...result.sources)
      relations.push(...result.relations)
      warnings.push(...result.warnings)
      pending.push(...result.imports.map((value) => ({ file: updated, ...value })))
    }
  }

  try { await visit(root, []) } finally { parsed.dispose() }

  const aliases: Array<{ owner: string; base: string; pattern: string; targets: string[] }> = []
  const packages = new Map<string, Array<{ file: Source; value: { name?: string; exports?: unknown; main?: string; module?: string } }>>()
  for (const file of files.values()) {
    await pause()
    if (path.posix.basename(file.uri) === "package.json") {
      const value = json(file.text) as { name?: string; exports?: unknown; main?: string; module?: string } | null
      if (value?.name) packages.set(value.name, [...packages.get(value.name) ?? [], { file, value }])
    }
    if (!file.uri.endsWith("tsconfig.json")) continue
    const cfg = json(file.text) as { compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } }
    for (const [pattern, targets] of Object.entries(cfg?.compilerOptions?.paths ?? {})) aliases.push({ owner: path.posix.dirname(file.uri), base: path.posix.join(path.posix.dirname(file.uri), cfg.compilerOptions?.baseUrl ?? "."), pattern, targets })
  }
  aliases.sort((a, b) => b.owner.length - a.owner.length)
  function target(value: unknown): string | undefined {
    if (typeof value === "string") return value
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
    const fields = value as Record<string, unknown>
    for (const key of ["source", "import", "default", "require", "types"]) {
      const found = target(fields[key])
      if (found) return found
    }
  }
  function resolve(file: Source, specifier: string, python: boolean) {
    const choices: string[] = []
    if (python) {
      const dots = specifier.match(/^\.+/)?.[0].length ?? 0
      const parent = dots ? path.posix.join(path.posix.dirname(file.uri), ...Array.from({ length: dots - 1 }, () => "..")) : "."
      choices.push(path.posix.join(parent, specifier.slice(dots).replaceAll(".", "/")))
      if (!dots) choices.push(path.posix.join("src", specifier.replaceAll(".", "/")))
    }
    if (!python && specifier.startsWith(".")) choices.push(path.posix.join(path.posix.dirname(file.uri), specifier))
    const owner = aliases.find((alias) => alias.owner === "." || file.uri.startsWith(`${alias.owner}/`))?.owner
    if (!python) for (const alias of aliases) {
      if (alias.owner !== owner) continue
      const [prefix, suffix = ""] = alias.pattern.split("*")
      if (!alias.pattern.includes("*") && specifier !== alias.pattern) continue
      if (!specifier.startsWith(prefix!) || !specifier.endsWith(suffix)) continue
      const middle = specifier.slice(prefix!.length, suffix ? -suffix.length : undefined)
      for (const target of alias.targets) choices.push(path.posix.join(alias.base, target.replace("*", middle)))
    }
    if (!python && !specifier.startsWith(".")) {
      const name = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/").at(0)!
      const matches = packages.get(name) ?? []
      const pkg = matches.length === 1 ? matches.at(0) : undefined
      if (pkg) {
        const subpath = specifier === name ? "." : `.${specifier.slice(name.length)}`
        const exports = pkg.value.exports
        const selected = exports && typeof exports === "object" && !Array.isArray(exports)
          ? (exports as Record<string, unknown>)[subpath] ?? (subpath === "." ? exports : undefined)
          : subpath === "." ? exports : undefined
        const entry = target(selected) ?? (exports == null ? subpath === "." ? pkg.value.module ?? pkg.value.main ?? "./index" : subpath : undefined)
        if (entry?.startsWith("./") && !entry.split("/").includes("..")) choices.push(path.posix.join(path.posix.dirname(pkg.file.uri), entry))
      }
    }
    for (const value of choices) {
      for (const name of [value, `${value}.ts`, `${value}.tsx`, `${value}.js`, `${value}.py`, `${value}/index.ts`, `${value}/index.tsx`, `${value}/index.js`, `${value}/__init__.py`, value.replace(/\.js$/, ".ts")]) {
        const found = files.get(name.replace(/^\.\//, ""))
        if (found) return found
      }
    }
  }
  const dependencies = new Map<string, Source>()
  for (const item of sources) {
    await pause()
    if (item.kind === "dependency") dependencies.set(`${path.posix.dirname(item.detail.manifest ?? "")}:${item.label}`, item)
  }
  for (const item of pending) {
    await pause()
    const target = resolve(item.file, item.specifier, item.python)
    if (target) { relations.push(relation(item.file.id, target.id, item.file.kind === "test" ? "test-imports" : "imports", [item.evidence], `Resolved ${item.specifier}`)); continue }
    const name = item.python ? item.specifier.split(".")[0] : item.specifier.startsWith("@") ? item.specifier.split("/").slice(0, 2).join("/") : item.specifier.split("/")[0]
    let owner = path.posix.dirname(item.file.uri)
    while (owner !== "." && !files.has(path.posix.join(owner, item.python ? "pyproject.toml" : "package.json"))) owner = path.posix.dirname(owner)
    const dep = dependencies.get(`${owner}:${name ?? ""}`)
    if (dep) relations.push(relation(item.file.id, dep.id, "imports-dependency", [item.evidence], item.specifier))
  }
  for (const doc of files.values()) {
    await pause()
    if (doc.kind !== "document" && doc.kind !== "instruction") continue
    for (const link of doc.text.matchAll(/\]\(([^\s)#]+)(?:#[^)]*)?\)/g)) {
      const target = files.get(path.posix.normalize(path.posix.join(path.posix.dirname(doc.uri), link[1]!)))
      if (target) relations.push(relation(doc.id, target.id, "document-links-to", [doc.id], link[0]))
    }
  }
  await resolveVersions(sources, files, warnings, input.signal)
  const tables = sources.filter((item) => item.kind === "schema" && /declared-(?:sql-schema|orm-schema|sqlalchemy-subset)/.test(item.method))
  for (const table of tables) {
    await pause()
    for (const reference of table.text.matchAll(/REFERENCES\s+["`]?([\w.]+)|\.references\(\s*\(\)\s*=>\s*(\w+)\./gi)) {
      const name = reference[1] ?? reference[2]
      const target = tables.find((item) => item.label === name)
      if (target) relations.push(relation(table.id, target.id, "declares-foreign-key", table.evidence, reference[0]))
    }
  }
  relations.push(...await associations(sources, input.signal))
  const retained = new Set(sources.map((item) => item.id))
  for (const item of saved?.sources ?? []) {
    await pause()
    if (retained.has(item.id)) continue
    const uri = item.detail.manifest ?? item.uri
    if (!previous.has(uri) && item.method !== "directory") continue
    if (secret.test(uri) || uri.split("/").some((part) => blocked.has(part)) || matches.ignores(item.method === "directory" ? `${uri}/` : uri)) continue
    if (![...unavailable].some((prefix) => !prefix || uri === prefix || uri.startsWith(`${prefix}/`))) continue
    sources.push({ ...item, status: "unavailable" })
  }
  const unique = [...new Map(sources.map((item) => [item.id, item])).values()]
  const edges = [...new Map(relations.map((item) => [item.id, item])).values()]
  const stamps = await extraction(unique, edges, input.signal)
  for (const [index, item] of unique.entries()) {
    await pause()
    const group = stamps.get(item.id)
    if (item.method === "file" && item.status === "current" && group) {
      unique[index] = { ...item, detail: { ...item.detail, extraction: group.stamp } }
    }
  }
  const generation = await version(unique, edges, partial, input.signal)
  if (partial) warnings.push("Repository coverage is partial; missing results do not establish absence.")
  return { root, revision: input.revision ?? "working-tree", generation, observed: Date.now(), sources: unique, relations: edges, warnings, partial, files: total }
}

async function resolveVersions(sources: Source[], files: Map<string, Source>, warnings: string[], signal?: AbortSignal) {
  const pause = checkpoint(signal)
  const locks = [...files.values()].filter((file) => ["package-lock.json", "bun.lock", "uv.lock", "poetry.lock"].includes(path.posix.basename(file.uri)))
    .sort((a, b) => path.posix.dirname(b.uri).length - path.posix.dirname(a.uri).length || a.uri.localeCompare(b.uri))
  const nearest = (item: Source) => locks.find((file) => {
    const base = path.posix.dirname(file.uri)
    return (item.detail.ecosystem === "npm" ? /(?:package-lock\.json|bun\.lock)$/.test(file.uri) : /(?:uv|poetry)\.lock$/.test(file.uri))
      && (base === "." || item.detail.manifest?.startsWith(`${base}/`))
  })?.id
  for (let index = 0; index < sources.length; index++) {
    await pause()
    const item = sources.at(index)!
    if (item.kind !== "dependency" || item.method !== "manifest") continue
    const detail = { ...Object.fromEntries(Object.entries(item.detail).filter(([key]) => !["lockfile", "versionStatus"].includes(key))), resolved: "unknown" }
    sources[index] = { ...item, detail, evidence: files.get(item.detail.manifest ?? "") ? [files.get(item.detail.manifest ?? "")!.id] : [] }
  }
  for (const file of locks) {
    await pause()
    const name = path.posix.basename(file.uri)
    if (!["package-lock.json", "bun.lock", "uv.lock", "poetry.lock"].includes(name)) continue
    try {
      const errors: ParseError[] = []
      const lock = (name.endsWith(".json") || name === "bun.lock" ? json(file.text, errors, { allowTrailingComma: true }) : toml(file.text)) as { packages?: Record<string, { version?: string } | unknown[]>; package?: Array<{ name: string; version: string }> }
      if (errors.length || !lock || typeof lock !== "object") throw new Error("Invalid lockfile")
      const versions = new Map<string, Set<string>>()
      const locations = new Map<string, string>()
      const add = (name: string, version: string) => versions.set(name, new Set([...versions.get(name) ?? [], version]))
      for (const [key, value] of Object.entries(lock.packages ?? {})) {
        await pause()
        if (Array.isArray(value)) {
          const spec = String(value.at(0))
          const split = spec.lastIndexOf("@")
          if (split > 0) add(spec.slice(0, split), spec.slice(split + 1))
          continue
        }
        if (value.version) {
          add(key.replace(/^.*node_modules\//, ""), value.version)
          locations.set(key, value.version)
        }
      }
      for (const pkg of lock.package ?? []) add(pkg.name, pkg.version)
      for (let index = 0; index < sources.length; index++) {
        await pause()
        const item = sources.at(index)!
        if (item.kind !== "dependency") continue
        const manifest = item.detail.manifest ?? ""
        if (nearest(item) !== file.id) continue
        const candidates = versions.get(item.label)
        const version = (() => {
          if (name !== "package-lock.json") return candidates?.size === 1 ? [...candidates].at(0) : candidates?.has(item.detail.declared ?? "") ? item.detail.declared : undefined
          let dir = path.posix.relative(path.posix.dirname(file.uri), path.posix.dirname(manifest)) || "."
          while (true) {
            const found = locations.get(path.posix.join(dir, "node_modules", item.label))
            if (found || dir === ".") return found
            dir = path.posix.dirname(dir)
          }
        })()
        if (version) sources[index] = { ...item, detail: { ...item.detail, resolved: version, lockfile: file.uri, versionStatus: "lockfile; installed state unverified" }, evidence: [...new Set([...item.evidence, file.id])] }
        if (!version && candidates && candidates.size > 1) sources[index] = { ...item, detail: { ...item.detail, versionStatus: "multiple lockfile versions; owning resolution unknown" } }
      }
    } catch (err) { signal?.throwIfAborted(); warnings.push(`${file.uri}: version resolution failed: ${message(err)}`) }
  }
}

export async function fresh(root: string, item: Source) {
  if (item.status !== "current") return false
  if (item.uri.includes(":")) return item.status === "current"
  const absolute = path.resolve(root, item.uri)
  const resolved = await realpath(absolute).catch(() => undefined)
  const canonical = await realpath(root)
  if (!resolved || !inside(canonical, resolved)) return false
  const info = await stat(resolved)
  if (!info.isFile()) return item.kind === "directory"
  const current = await readFile(resolved, "utf8")
  return hash(current) === (item.detail.fileHash ?? item.hash)
}
