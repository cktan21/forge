import { expect } from "bun:test"
import { Database } from "bun:sqlite"
import path from "node:path"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Exit, Fiber } from "effect"
import { config } from "@kilocode/forge/config"
import { engine, fingerprint } from "@kilocode/forge/engine"
import { store } from "@kilocode/forge/store"
import { MCP } from "../../src/mcp"
import { documents } from "../../src/kilocode/forge/sources"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(MCP.node))

const serve = Effect.acquireRelease(
  Effect.promise(async () => {
    const calls: string[] = []
    const gates = new Map<string, { started: ReturnType<typeof Promise.withResolvers<void>>; release: ReturnType<typeof Promise.withResolvers<void>> }>()
    const protocol = new Server({ name: "forge-docs", version: "1.0.0" }, { capabilities: { tools: {} } })
    protocol.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        { name: "resolve-library-id", inputSchema: { type: "object", properties: { libraryName: { type: "string" }, query: { type: "string" } } } },
        { name: "query-docs", inputSchema: { type: "object", properties: { libraryId: { type: "string" }, query: { type: "string" } } } },
      ],
    }))
    protocol.setRequestHandler(CallToolRequestSchema, async (request) => {
      calls.push(request.params.name)
      const gate = gates.get(request.params.name)
      if (gate) { gate.started.resolve(); await gate.release.promise }
      return { content: [{ type: "text", text: request.params.name === "resolve-library-id" ? "Library ID: /fixture/queue" : "Queue API documentation" }] }
    })
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      enableJsonResponse: true,
    })
    await protocol.connect(transport)
    const http = Bun.serve({ port: 0, fetch: (request) => transport.handleRequest(request) })
    return {
      calls, url: http.url.toString(),
      pause(name: string) {
        const gate = { started: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() }
        gates.set(name, gate)
        return { started: gate.started.promise, release: () => { gates.delete(name); gate.release.resolve() } }
      },
      async close() {
        for (const gate of gates.values()) gate.release.resolve()
        await http.stop(true)
        await protocol.close()
      },
    }
  }),
  (server) => Effect.promise(() => server.close()),
)

it.instance("documentation fingerprints and cache identity track dependency metadata through the real MCP adapter", () =>
  Effect.gen(function* () {
    const instance = yield* TestInstance
    const root = instance.directory
    const db = yield* Effect.acquireRelease(Effect.sync(() => new Database(":memory:")), (db) => Effect.sync(() => db.close()))
    const storage = store({
      all: async (query) => db.query<Record<string, unknown>, (string | number | null)[]>(query.text).all(...query.values ?? []),
      batch: async (queries) => {
        db.transaction(() => {
          for (const query of queries) db.query(query.text).run(...query.values ?? [])
        })()
      },
    })
    const api = yield* Effect.acquireRelease(
      Effect.sync(() => engine({ root, store: storage, complete: async () => { throw new Error("Unexpected model call") } })),
      (api) => Effect.promise(() => api.dispose()),
    )
    yield* Effect.promise(async () => {
      await Bun.write(path.join(root, ".kilo/forge.jsonc"), JSON.stringify({ documents: { server: "docs" } }))
      await Bun.write(path.join(root, "package.json"), JSON.stringify({ dependencies: { queue: "^1.0.0" } }))
      await Bun.write(path.join(root, "package-lock.json"), JSON.stringify({ packages: { "node_modules/queue": { version: "1.0.0" } } }))
    })
    const server = yield* serve
    const mcp = yield* MCP.Service
    yield* mcp.add("docs", { type: "remote", url: server.url, oauth: false })
    const cfg = yield* Effect.promise(() => config(root))
    const initial = yield* Effect.promise(() => api.refresh())
    const dep = initial.sources.find((item) => item.kind === "dependency" && item.label === "queue")!
    const input = { query: "queue API", dependencies: [dep], cfg }
    const first = (yield* documents(input, storage, root)).at(0)!
    expect(JSON.parse(first.detail.dependencies)).toEqual({ [dep.id]: fingerprint(dep) })
    expect(server.calls).toHaveLength(2)
    expect((yield* documents(input, storage, root)).at(0)).toEqual(first)
    expect(server.calls).toHaveLength(2)
    yield* Effect.promise(() => storage.external(root, first))
    expect((yield* Effect.promise(() => api.refresh(true))).sources.find((item) => item.id === first.id)?.status).toBe("current")

    yield* Effect.promise(() => Bun.write(path.join(root, "package-lock.json"), JSON.stringify({ packages: { "node_modules/queue": { version: "1.1.0" } } })))
    const changed = yield* Effect.promise(() => api.refresh(true))
    expect(changed.sources.find((item) => item.id === first.id)?.status).toBe("stale")
    const next = changed.sources.find((item) => item.id === dep.id)!
    expect(next.hash).toBe(dep.hash)
    expect(fingerprint(next)).not.toBe(fingerprint(dep))
    const second = (yield* documents({ ...input, dependencies: [next] }, storage, root)).at(0)!
    expect(second.id).not.toBe(first.id)
    expect(second.detail.projectVersion).toBe("1.1.0")
    expect(server.calls).toHaveLength(4)

    yield* Effect.promise(() => storage.cache(root, second.id, { ...second, detail: { ...second.detail, dependencies: "{}" } }))
    expect((yield* documents({ ...input, dependencies: [next] }, storage, root)).at(0)?.detail.dependencies).toBe(second.detail.dependencies)
    expect(server.calls).toHaveLength(6)
    const sibling = { ...next, id: "other-workspace-manifest" }
    const third = (yield* documents({ ...input, dependencies: [sibling] }, storage, root)).at(0)!
    expect(third.id).not.toBe(second.id)
    expect(third.evidence).toEqual([sibling.id])
    expect(server.calls).toHaveLength(8)
    expect(yield* documents({ ...input, dependencies: [{ ...next, status: "unavailable" }] }, storage, root)).toEqual([])
    expect(server.calls).toHaveLength(8)
    for (const name of ["resolve-library-id", "query-docs"]) {
      const gate = server.pause(name)
      const controller = new AbortController()
      const before = db.query("SELECT count(*) AS count FROM forge_records WHERE kind = 'cache'").get()
      const count = server.calls.length
      const fiber = yield* documents({ ...input, query: `cancel ${name}`, signal: controller.signal }, storage, root).pipe(Effect.exit, Effect.forkChild)
      yield* Effect.promise(() => gate.started).pipe(Effect.timeout("5 seconds"))
      controller.abort(new Error("Cancel documentation lookup"))
      gate.release()
      const result = yield* Fiber.join(fiber)
      expect(Exit.isFailure(result)).toBe(true)
      expect(server.calls.slice(count)).toEqual(name === "resolve-library-id" ? ["resolve-library-id"] : ["resolve-library-id", "query-docs"])
      expect(db.query("SELECT count(*) AS count FROM forge_records WHERE kind = 'cache'").get()).toEqual(before)
    }
  }),
  30_000,
)
