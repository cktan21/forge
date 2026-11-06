import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { Database } from "bun:sqlite"
import { expect } from "bun:test"
import { Effect, Fiber, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import { engine } from "@kilocode/forge/engine"
import { knowledge } from "@kilocode/forge/knowledge"
import { store } from "@kilocode/forge/store"
import { Forge } from "@/kilocode/forge/service"
import { ForgeApi } from "@/kilocode/server/httpapi/groups/forge"
import { forgeHandlers } from "@/kilocode/server/httpapi/handlers/forge"
import { Session } from "@/session/session"
import { Authorization } from "@/server/routes/instance/httpapi/middleware/authorization"
import { InstanceContextMiddleware } from "@/server/routes/instance/httpapi/middleware/instance-context"
import { WorkspaceRouteContext, WorkspaceRoutingMiddleware } from "@/server/routes/instance/httpapi/middleware/workspace-routing"
import { schemaErrorLayer } from "@/server/routes/instance/httpapi/middleware/schema-error"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(NodeHttpServer.layerTest, NodeServices.layer))
const api = HttpApi.make("opencode-instance").addHttpApi(ForgeApi)

for (const mode of ["page", "document", "source"] as const) {
  it.live(`HTTP ${mode} interruption cancels the real engine before late permission completes`, () => Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    const db = yield* Effect.acquireRelease(Effect.sync(() => new Database(":memory:")), (db) => Effect.sync(() => db.close()))
    const storage = store({
      all: async (query) => db.query<Record<string, unknown>, (string | number | null)[]>(query.text).all(...query.values ?? []),
      batch: async (queries) => { db.transaction(() => { for (const query of queries) db.query(query.text).run(...query.values ?? []) })() },
    })
    const library = yield* Effect.acquireRelease(Effect.sync(() => knowledge(root, storage)), (library) => Effect.promise(() => library.dispose()))
    const entered = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<void>()
    const done = Promise.withResolvers<{ error?: unknown; value?: unknown }>()
    let signal: AbortSignal | undefined
    let held = true
    const service = yield* Effect.acquireRelease(
      Effect.sync(() => engine({
        root, store: storage,
        authorize: async () => {
          if (!held) return
          held = false
          entered.resolve()
          await gate.promise
        },
        complete: async () => { throw new Error("Unexpected model call") },
      })),
      (service) => Effect.promise(async () => { gate.resolve(); await service.dispose() }),
    )
    async function observe<A>(run: () => Promise<A>, abort?: AbortSignal) {
      signal = abort
      try {
        const value = await run()
        done.resolve({ value })
        return value
      } catch (error) {
        done.resolve({ error })
        throw error
      }
    }
    const view = service.view.bind(service)
    service.view = (opts) => observe(() => view(opts), opts?.signal)
    const symbol = service.symbol.bind(service)
    service.symbol = (key, session, provider, abort) => observe(() => symbol(key, session, provider, abort), abort)
    const sources = yield* Effect.promise(async () => {
      const item = await library.register({ kind: "text", label: "Manual", location: "", content: "# Journal\nRestore the journal before replay." })
      await library.approve(item.id)
      await library.index(item.id)
      return storage.knowledge(root)
    })
    const parent = sources.find((item) => item.method === "collection-document")!
    const section = sources.find((item) => item.method === "collection-section")!
    const route = mode === "source" ? `/forge/source/${section.id}`
      : mode === "document" ? `/forge/view?document=${parent.id}` : "/forge/view"
    // Only routing/authentication/session plumbing is replaced here. The production
    // handlers, HTTP interruption, engine, extraction and SQLite reads are exercised.
    const routes = HttpApiBuilder.layer(api).pipe(
      Layer.provide(forgeHandlers),
      Layer.provide([
        Layer.succeed(Forge.Service, Forge.Service.of({ get: () => Effect.succeed(service) })),
        Layer.mock(Session.Service)({}),
        Layer.succeed(Authorization, Authorization.of((effect) => effect)),
        Layer.succeed(InstanceContextMiddleware, InstanceContextMiddleware.of((effect) => effect)),
        Layer.succeed(WorkspaceRoutingMiddleware, WorkspaceRoutingMiddleware.of((effect) => effect.pipe(Effect.provideService(WorkspaceRouteContext, { directory: root })))),
        schemaErrorLayer,
      ]),
    )
    yield* Effect.gen(function* () {
      const pending = yield* HttpClientRequest.get(route).pipe(HttpClient.execute, Effect.forkChild)
      yield* Effect.promise(() => entered.promise).pipe(Effect.timeout("2 seconds"))
      expect(signal).toBeInstanceOf(AbortSignal)
      yield* Fiber.interrupt(pending)
      const result = yield* Effect.promise(() => done.promise).pipe(Effect.timeout("1 second"))
      expect(signal?.aborted).toBe(true)
      expect(result.error).toBeDefined()
      expect(result.value).toBeUndefined()
      const retry = yield* HttpClientRequest.get(route).pipe(HttpClient.execute)
      expect(retry.status).toBe(200)
      expect(JSON.stringify(yield* retry.json)).toContain("Restore the journal")
      gate.resolve()
      expect(yield* Effect.promise(() => done.promise)).toBe(result)
    }).pipe(Effect.provide(HttpRouter.serve(routes, { disableListenLog: true, disableLogger: true })))
  }))
}
