import path from "node:path"
import type { Node } from "web-tree-sitter"
import { loadRequiredLanguageParsers, type LanguageParser } from "@kilocode/kilo-indexing/parser"
import { parse as json } from "jsonc-parser"
import { parse as toml } from "smol-toml"
import type { Source, Relation } from "./schema"
import { hash, id, redact, terms } from "./util"
import { checkpoint } from "./cooperate"

export type Parsed = { sources: Source[]; relations: Relation[]; imports: Array<{ specifier: string; evidence: string; python: boolean }>; warnings: string[] }
export function source(uri: string, text: string, kind: Source["kind"], opts: Partial<Source> = {}): Source {
  return { id: id(uri, kind), uri, text: redact(text), kind, label: path.basename(uri), hash: hash(text), start: 1, end: text.split("\n").length, observed: Date.now(), method: "file", status: "current", inferred: false, evidence: [], detail: {}, ...opts }
}

export function relation(from: string, to: string, kind: string, evidence: readonly string[], reason = "", inferred = false): Relation {
  return { id: id(from, to, kind), from, to, kind, evidence, reason, inferred }
}

const definitions = new Set(["function_declaration", "generator_function_declaration", "method_definition", "class_declaration", "interface_declaration", "type_alias_declaration", "function_definition", "class_definition"])
const imports = new Set(["import_statement", "import_from_statement", "export_statement"])
const extensions = new Set([".ts", ".tsx", ".js", ".jsx", ".py"])

export function parser() {
  const languages = new Map<string, LanguageParser>()
  return {
    async parse(file: Source): Promise<Parsed> {
      const result: Parsed = { sources: [], relations: [], imports: [], warnings: [] }
      const ext = path.extname(file.uri)
      if (!extensions.has(ext)) return supplement(file, result)
      const parsers = languages.get(ext) ?? await loadRequiredLanguageParsers([file.uri])
      languages.set(ext, parsers)
      const language = parsers[ext.slice(1)] ?? Object.values(parsers).at(0)
      if (!language) throw new Error(`No parser for ${ext}`)
      const tree = language.parser.parse(file.text)
      if (!tree) throw new Error(`Could not parse ${file.uri}`)
      try {
        const queue: Node[] = [tree.rootNode]
        let visited = 0
        for (let node = queue.pop(); node && visited < 50_000; node = queue.pop()) {
          visited++
          const name = node.childForFieldName("name")?.text
          const callable = node.type === "variable_declarator" && node.namedChildren.some((child) => child?.type === "arrow_function" || child?.type === "function_expression")
          if ((definitions.has(node.type) || callable) && name) {
            const item = source(file.uri, node.text.slice(0, 8000), "symbol", {
              id: id(file.id, name, String(node.startPosition.row)), label: name,
              start: node.startPosition.row + 1, end: node.endPosition.row + 1,
              method: `tree-sitter:${node.type}`, evidence: [file.id],
              detail: { declaration: node.type, truncated: String(node.text.length > 8000), fileHash: file.hash },
            })
            result.sources.push(item)
            result.relations.push(relation(file.id, item.id, "declares", [file.id]))
          }
          if (imports.has(node.type)) {
            const specifier = node.childForFieldName("source")?.text.replace(/^['"]|['"]$/g, "")
            if (specifier) result.imports.push({ specifier, evidence: file.id, python: false })
            if (ext === ".py") {
              const from = node.text.match(/^from\s+([\w.]+)\s+import\s+([\w., *]+)/)
              if (from) {
                result.imports.push({ specifier: from[1]!, evidence: file.id, python: true })
                if (/^\.+$/.test(from[1]!)) for (const name of from[2]!.split(",")) result.imports.push({ specifier: `${from[1]}${name.trim().split(/\s+as\s+/)[0]}`, evidence: file.id, python: true })
              }
              if (!from && node.type === "import_statement") {
                for (const name of node.text.replace(/^import\s+/, "").split(",")) result.imports.push({ specifier: name.trim().split(/\s+as\s+/)[0]!, evidence: file.id, python: true })
              }
            }
          }
          if (node.type === "call_expression" || node.type === "call") {
            const called = node.childForFieldName("function")?.text ?? ""
            const argument = node.childForFieldName("arguments")?.namedChildren.at(0)
            if ((called === "require" || called === "import") && argument?.type === "string") result.imports.push({ specifier: argument.text.slice(1, -1), evidence: file.id, python: false })
            if (/^(?:pgTable|sqliteTable|mysqlTable|Table)$/.test(called) && argument?.type === "string") {
              const name = argument.text.slice(1, -1)
              const table = source(file.uri, node.text.slice(0, 8000), "schema", { id: id(file.id, "table", name), label: name, start: node.startPosition.row + 1, end: node.endPosition.row + 1, method: "declared-orm-schema", evidence: [file.id], detail: { observation: "checked-in declaration; live state unknown" } })
              result.sources.push(table)
              result.relations.push(relation(file.id, table.id, "declares", [file.id]))
            }
            if (/^(?:test|it|describe)(?:\.(?:skip|only|todo))?$/.test(called) && argument?.type === "string") {
              const item = source(file.uri, node.text.slice(0, 4000), "test", { id: id(file.id, "test", String(node.startPosition.row)), label: argument.text.slice(1, -1), start: node.startPosition.row + 1, end: node.endPosition.row + 1, method: "tree-sitter:test-declaration", evidence: [file.id], detail: { execution: "not observed", skipped: String(called.endsWith(".skip") || called.endsWith(".todo")) } })
              result.sources.push(item)
              result.relations.push(relation(file.id, item.id, "declares", [file.id]))
            }
          }
          queue.push(...node.namedChildren.filter((child): child is Node => child != null))
        }
        if (visited >= 50_000) result.warnings.push(`${file.uri}: syntax traversal limit reached`)
        if (tree.rootNode.hasError) result.warnings.push(`${file.uri}: syntax errors; extraction may be incomplete`)
      } finally {
        tree.delete()
      }
      return supplement(file, result)
    },
    dispose() {
      for (const parsers of languages.values()) for (const item of Object.values(parsers)) {
        item.query.delete()
        item.parser.delete()
      }
      languages.clear()
    },
  }
}

function supplement(file: Source, result: Parsed) {
  const lines = file.text.split("\n")
  // Line windows include comments, module-level code and short declarations absent from symbol chunks.
  for (let offset = 0; offset < lines.length; offset += 50) {
    const text = lines.slice(offset, offset + 60).join("\n")
    if (!text.trim()) continue
    const item = source(file.uri, text, file.kind, { id: id(file.id, "chunk", String(offset)), label: `${file.label}:${offset + 1}`, start: offset + 1, end: Math.min(lines.length, offset + 60), method: "line-window", evidence: [file.id], detail: { fileHash: file.hash } })
    result.sources.push(item)
    result.relations.push(relation(file.id, item.id, "contains", [file.id]))
  }
  for (const match of file.text.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?([\w.]+)["`]?\s*\(([\s\S]*?);/gi)) {
    const table = source(file.uri, match[0], "schema", { id: id(file.id, "sql", match[1]!), label: match[1]!, start: file.text.slice(0, match.index).split("\n").length, method: "declared-sql-schema", evidence: [file.id], detail: { observation: "SQL declaration; live state unknown" } })
    result.sources.push(table)
    result.relations.push(relation(file.id, table.id, "declares", [file.id]))
    for (const column of match[2]!.matchAll(/(?:^|,)\s*["`]?([A-Za-z_]\w*)["`]?\s+([A-Za-z_]\w*)(?:\([^)]*\))?/g)) {
      if (/^(?:PRIMARY|FOREIGN|CONSTRAINT|UNIQUE|CHECK)$/i.test(column[1]!)) continue
      const item = source(file.uri, column[0], "schema", { id: id(table.id, column[1]!), label: `${table.label}.${column[1]}`, method: "declared-sql-column", evidence: [file.id], detail: { type: column[2]!, table: table.label, observation: "checked-in declaration" } })
      result.sources.push(item)
      result.relations.push(relation(table.id, item.id, "declares-column", [file.id]))
    }
  }
  if (file.uri.endsWith(".py")) {
    for (const match of file.text.matchAll(/__tablename__\s*=\s*["']([\w.]+)["']/g)) {
      const start = file.text.slice(0, match.index).split("\n").length
      const item = source(file.uri, lines.slice(start - 1, start + 40).join("\n"), "schema", { id: id(file.id, "sqlalchemy", match[1]!), label: match[1]!, start, end: Math.min(lines.length, start + 40), method: "declared-sqlalchemy-subset", evidence: [file.id], detail: { observation: "static table declaration; dynamic expressions unresolved" } })
      result.sources.push(item)
      result.relations.push(relation(file.id, item.id, "declares", [file.id]))
    }
  }
  if (path.basename(file.uri) === "package.json") {
    const pkg = json(file.text) as { name?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string>; scripts?: Record<string, string> }
    for (const [name, version] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
      const item = source(`npm:${name}`, `${name} ${version}`, "dependency", { id: id(file.id, name), label: name, method: "manifest", evidence: [file.id], detail: { declared: version, ecosystem: "npm", manifest: file.uri, resolved: "unknown" } })
      result.sources.push(item)
      result.relations.push(relation(file.id, item.id, "declares-dependency", [file.id]))
    }
    for (const [name, command] of Object.entries(pkg.scripts ?? {})) {
      const item = source(file.uri, command, "configuration", { id: id(file.id, "script", name), label: `script:${name}`, method: "package-script", evidence: [file.id], detail: { execution: "not run", script: name } })
      result.sources.push(item)
      result.relations.push(relation(file.id, item.id, "declares", [file.id]))
    }
  }
  if (path.basename(file.uri) === "pyproject.toml") {
    const pkg = toml(file.text)
    const project = pkg.project as { dependencies?: string[] } | undefined
    for (const value of project?.dependencies ?? []) {
      const name = value.match(/^[\w.-]+/)?.[0]
      if (!name) continue
      const item = source(`pypi:${name}`, value, "dependency", { id: id(file.id, name), label: name, method: "manifest", evidence: [file.id], detail: { declared: value.slice(name.length), ecosystem: "pypi", manifest: file.uri, resolved: "unknown" } })
      result.sources.push(item)
      result.relations.push(relation(file.id, item.id, "declares-dependency", [file.id]))
    }
  }
  return result
}

export async function associations(sources: readonly Source[], signal?: AbortSignal) {
  signal?.throwIfAborted()
  const pause = checkpoint(signal)
  const files = sources.filter((item) => item.method === "file")
  const codes = files.filter((item) => item.kind === "code" || item.kind === "test")
    .map((item) => ({ item, name: path.basename(item.uri, path.extname(item.uri)) }))
    .filter(({ name }) => name.length >= 4 && !["index", "main", "test", "utils"].includes(name))
  const result: Relation[] = []
  for (const doc of files.filter((item) => item.kind === "document")) {
    await pause()
    const words = new Set(terms(doc.text))
    for (const { item: code, name } of codes) {
      await pause()
      if (!words.has(name.toLowerCase())) continue
      result.push(relation(doc.id, code.id, "likely-documents", [doc.id, code.id], `Document mentions module name ${name}; behavior coverage is unverified`, true))
      if (result.length === 2000) return result
    }
  }
  return result
}
