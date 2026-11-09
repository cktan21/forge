import { Effect, Schema } from "effect"
import { MCP } from "@/mcp"
import * as Config from "@/config/config"
import { source } from "@kilocode/forge/parse"
import { fingerprint, type Ports } from "@kilocode/forge/engine"
import { id, hash, terms, redact } from "@kilocode/forge/util"
import { decode, Source, type Settings, type Store } from "@kilocode/forge"

function text(value: unknown): string {
  if (value == null || typeof value !== "object") return ""
  const object = value as { content?: Array<{ type?: string; text?: string }>; contents?: Array<{ text?: string }> }
  return [...(object.content ?? []), ...(object.contents ?? [])].flatMap((item) => typeof item.text === "string" ? [item.text] : []).join("\n").slice(0, 20_000)
}

export const documentAccess = Effect.fn("Forge.documentAccess")(function* (item: Source, signal?: AbortSignal) {
  signal?.throwIfAborted()
  if (!item.detail.adapter) return
  const cfg = yield* (yield* Config.Service).get()
  if (hash(JSON.stringify(cfg.mcp?.[item.detail.server ?? ""] ?? null)) !== item.detail.adapter) throw new Error("Documentation server configuration changed")
})

export const documents = Effect.fn("Forge.documents")(function* (input: Parameters<NonNullable<Ports["docs"]>>[0], store: Store, root: string) {
  input.signal?.throwIfAborted()
  if (!input.cfg.documents) return []
  const guard = yield* Effect.promise(() => store.guard(root))
  const server = input.cfg.documents.server
  const words = terms(input.query)
  const deps = input.dependencies.filter((item) => item.status === "current").sort((a, b) => Number(words.some((word) => b.label.includes(word))) - Number(words.some((word) => a.label.includes(word)))).slice(0, input.explicit ? 1 : 2)
  const mcp = yield* MCP.Service
  const tools = Object.values(yield* mcp.tools()).filter((item) => item.clientName === server)
  input.signal?.throwIfAborted()
  const resolve = tools.find((item) => /resolve.library.id/i.test(item.def.name))
  const query = tools.find((item) => /query.docs|get.library.docs/i.test(item.def.name))
  if (!resolve || !query) throw new Error(`Configured documentation server ${server} does not expose a supported Context7 schema`)
  const cfg = yield* (yield* Config.Service).get()
  const adapter = hash(JSON.stringify(cfg.mcp?.[server] ?? null))
  const names = [resolve, query].map((item) => `${server}_${item.def.name}`.replace(/[^a-zA-Z0-9_-]/g, "_"))
  const check = Effect.fn(function* () {
    input.signal?.throwIfAborted()
    for (const name of names) yield* Effect.promise(async () => input.authorize?.(name))
    yield* Effect.promise(async () => input.check?.())
    const current = yield* (yield* Config.Service).get()
    if (hash(JSON.stringify(current.mcp?.[server] ?? null)) !== adapter) throw new Error("Documentation adapter changed during lookup")
  })
  const results: Source[] = []
  for (const dep of deps) {
    input.signal?.throwIfAborted()
    const dependencies = JSON.stringify({ [dep.id]: fingerprint(dep) })
    const key = `docs:${id(server, dep.id, fingerprint(dep), input.query, input.explicit ? JSON.stringify([adapter, input.session, input.provider, input.destination]) : "legacy")}`
    yield* check()
    const saved = yield* Effect.promise(() => store.cached(root, key))
    input.signal?.throwIfAborted()
    if (saved) {
      const cached = Schema.decodeUnknownOption(input.explicit ? Schema.Array(Source) : Source)(saved)
      const records = cached._tag === "Some" ? Array.isArray(cached.value) ? cached.value : [cached.value] : []
      if (input.explicit && records.length && records.every((item) => item.status === "current"
        && item.detail.server === server && item.detail.adapter === adapter && item.detail.dependencies === dependencies
        && item.detail.session === (input.session ?? "") && item.detail.provider === (input.provider ?? "")
        && item.detail.destination === (input.destination ?? "") && Date.now() - item.observed < 24 * 60 * 60 * 1000)) {
        results.push(...records)
        continue
      }
      const legacy = !input.explicit ? records.at(0) : undefined
      if (legacy?.status === "current" && legacy.detail.server === server && legacy.detail.dependencies === dependencies
        && Date.now() - legacy.observed < 24 * 60 * 60 * 1000) {
        results.push(legacy)
        continue
      }
    }
    const resolved = yield* Effect.tryPromise(() => resolve.client.callTool({ name: resolve.def.name, arguments: { libraryName: dep.label, query: input.query } }, undefined, { timeout: 15_000, signal: input.signal }))
    input.signal?.throwIfAborted()
    const resolution = text(resolved)
    const library = resolution.match(/(?:Library ID|libraryId|ID)\s*[:=]\s*["`]?((?:\/[\w.-]+){2,})/i)?.[1] ?? resolution.match(/((?:\/[\w.-]+){2,})/)?.[1]
    if (!library) continue
    const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "")
    if (input.explicit && !library.split("/").some((part) => normalize(part) === normalize(dep.label.split("/").at(-1)!))
      && !resolution.split("\n").some((line) => /(?:title|library name)\s*:/i.test(line) && normalize(line.replace(/^.*?:/, "").trim()) === normalize(dep.label))) {
      throw new Error("Documentation provider resolved a different library; inspect its identity before use")
    }
    const properties = query.def.inputSchema.properties ?? {}
    if (!("libraryId" in properties) && !("context7CompatibleLibraryID" in properties)) throw new Error("Unsupported documentation tool input schema")
    const args = "libraryId" in properties
      ? { libraryId: library, query: `${input.query}\nProject lockfile version: ${dep.detail.resolved ?? "unknown"}. State version limitations.` }
      : { context7CompatibleLibraryID: library, topic: input.query, tokens: 2000 }
    yield* check()
    const response = yield* Effect.tryPromise(() => query.client.callTool({ name: query.def.name, arguments: args }, undefined, { timeout: 15_000, signal: input.signal }))
    input.signal?.throwIfAborted()
    const body = text(response)
    if (!body) continue
    yield* check()
    const item = source(`mcp:${server}:${library}`, body, "document", { id: key, label: `${dep.label} documentation`, method: "context7", evidence: [dep.id], detail: { server, library, dependencies, projectVersion: dep.detail.resolved ?? dep.detail.declared ?? "unknown", documentationVersion: "provider did not establish an exact version", compatibility: "uncertain", urls: [...new Set(body.match(/https?:\/\/[^\s<>"\]]+/g) ?? [])].join("\n") } })
    const version = body.match(/(?:documentation version|version)\s*:\s*v?(\d+\.\d+\.\d+(?:-[\w.-]+)?)/i)?.at(1)
    const passages = input.explicit ? Array.from({ length: Math.ceil(body.length / 3000) }, (_, index) => {
      const text = body.slice(index * 3000, (index + 1) * 3000)
      return source(item.uri, text, "document", {
        ...item, id: id(key, String(index), hash(body)), text: redact(text), hash: hash(text),
        label: `${dep.label} documentation ${index + 1}`, start: index + 1, end: index + 1,
        detail: { ...item.detail, adapter, tools: JSON.stringify(names), session: input.session ?? "", provider: input.provider ?? "", destination: input.destination ?? "",
          documentationVersion: version ?? item.detail.documentationVersion,
          compatibility: version ? version === item.detail.projectVersion ? "provider-reported match; runtime unverified" : "version mismatch; verify compatibility" : "uncertain",
          locator: `${library} passage ${index + 1}`, truncated: String(body.length >= 20_000) },
      })
    }) : [item]
    yield* Effect.promise(() => guard.run(() => {
      input.signal?.throwIfAborted()
      return store.cache(root, key, input.explicit ? passages : item)
    }))
    results.push(...passages)
  }
  yield* Effect.promise(() => guard.check())
  input.signal?.throwIfAborted()
  return results
})

export const database = Effect.fn("Forge.database")(function* (cfg: Settings, signal?: AbortSignal) {
  if (!cfg.database) throw new Error("No read-only database metadata resource configured")
  const mcp = yield* MCP.Service
  const available = yield* mcp.resources(cfg.database.server)
  const resource = Object.values(available).find((item) => item.uri === cfg.database!.resource)
  if (!resource) throw new Error("Configured database metadata resource is not advertised by the MCP server")
  signal?.throwIfAborted()
  const response = yield* mcp.readResource(cfg.database.server, cfg.database.resource).pipe(Effect.timeout("15 seconds"))
  const body = text(response)
  if (!body) return []
  const metadata = decode(Schema.Struct({ database: Schema.String, tables: Schema.Array(Schema.Struct({ name: Schema.String, schema: Schema.optional(Schema.String), columns: Schema.Array(Schema.Struct({ name: Schema.String, type: Schema.String, nullable: Schema.optional(Schema.Boolean) })), constraints: Schema.optional(Schema.Array(Schema.String)), indexes: Schema.optional(Schema.Array(Schema.String)) })) }), JSON.parse(body))
  return metadata.tables.slice(0, 100).map((table) => {
    const value = redact(JSON.stringify(table, null, 2))
    return source(`mcp:${cfg.database!.server}:${cfg.database!.resource}#${table.schema ?? "public"}.${table.name}`, value, "schema", { label: `${table.schema ?? "public"}.${table.name}`, method: "configured-postgresql-metadata", detail: { server: cfg.database!.server, database: metadata.database, resource: cfg.database!.resource, observation: "Provider-reported metadata; read-only connection configured on the MCP server", hash: hash(value) } })
  })
})
