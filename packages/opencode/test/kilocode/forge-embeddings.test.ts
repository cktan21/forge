import { expect } from "bun:test"
import { rejects } from "node:assert/strict"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Forge } from "@/kilocode/forge/service"
import { Env } from "@/env"
import { Config } from "@/config/config"
import { Session } from "@/session/session"
import { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import { Git } from "@/git"
import { TestInstance } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Forge.node,
      Env.node,
      Config.node,
      Session.node,
      SessionProjector.node,
      Agent.node,
      Provider.node,
      Git.node,
    ]),
  ),
)

for (const permission of ["allowed", "forge_embed", "webfetch"] as const) {
  it.instance(
    `host collection embeddings require explicit approval and respect ${permission}`,
    () =>
      Effect.gen(function* () {
        const env = yield* Env.Service
        const { directory } = yield* TestInstance
        const bodies: string[] = []
        const server = yield* Effect.acquireRelease(
          Effect.sync(() =>
            Bun.serve({
              hostname: "127.0.0.1",
              port: 0,
              async fetch(request) {
                bodies.push(await request.text())
                return Response.json({ data: [{ index: 0, embedding: [1, 0] }] })
              },
            }),
          ),
          (server) => Effect.promise(() => server.stop(true)),
        )
        for (const [key, value] of Object.entries({
          KILO_FORGE_EMBEDDING_ENDPOINT: `${server.url}v1/embeddings`,
          KILO_FORGE_EMBEDDING_MODEL: "fixture",
          KILO_FORGE_EMBEDDING_DIMENSIONS: "2",
          KILO_FORGE_EMBEDDING_KEY: "private-key",
        }))
          yield* env.set(key, value)
        const api = yield* (yield* Forge.Service).get()
        const embedding = api.embeddings!
        const collection = yield* Effect.promise(() =>
          api.register({
            kind: "text",
            label: "Operations",
            location: "",
            content: "Release ownership after the signed receipt arrives.",
          }),
        )
        // Resolve configuration only; never call a coding model.
        const sharing = yield* Effect.promise(() => api.destination())
        yield* Effect.promise(() =>
          api.approve(collection.id, "", [sharing.provider], {
            [sharing.provider]: sharing.destination!.fingerprint,
          }),
        )
        yield* Effect.promise(() => api.index(collection.id))
        yield* pollWithTimeout(
          Effect.promise(async () => {
            const current = (await api.collections()).find((item) => item.id === collection.id)
            if (current?.state === "failed") throw new Error(current.warnings.join(" "))
            return current?.state === "ready" ? true : undefined
          }),
          "Local collection did not become ready",
          "10 seconds",
        )
        yield* Effect.promise(async () => {
          const review = await embedding.review(collection.id)
          expect(review.approved).toBe(false)
          expect(review.endpoint).toBe(`${server.url}v1/embeddings`)
          expect(JSON.stringify(review)).not.toContain("private-key")
          expect(bodies).toEqual([])
          await rejects(embedding.index(collection.id), /has not been approved/)
          await rejects(embedding.coverage(collection.id), /has not been approved/)
          if (permission !== "allowed") {
            await rejects(embedding.approve(collection.id, review.revision), /Kilo permission denies/)
            expect(bodies).toEqual([])
            return
          }
          await embedding.approve(collection.id, review.revision)
          expect(await embedding.coverage(collection.id)).toMatchObject({ sections: 1, missing: 1, reusable: 0 })
          expect(bodies).toEqual([])
          expect(await embedding.index(collection.id)).toEqual({ sections: 1, embedded: 1, reused: 0 })
          expect(await embedding.coverage(collection.id)).toMatchObject({ sections: 1, missing: 0, reusable: 1 })
          const selection = await api.retrieve("retire locks", { provider: sharing.provider })
          expect(selection.matches.at(0)?.source.text).toContain("signed receipt")
          expect(selection.audit?.channels?.find((channel) => channel.name === "collection-semantic")).toMatchObject({
            state: "completed",
            candidates: 1,
          })
          expect(bodies).toHaveLength(2)
        })
        if (permission !== "allowed") return
        const sessions = yield* Session.Service
        const session = yield* sessions.create({ title: "Embedding denial" })
        yield* sessions.setPermission({
          sessionID: session.id,
          permission: [{ permission: "forge_embed", pattern: "*", action: "deny" }],
        })
        yield* Effect.promise(async () => {
          await rejects(embedding.index(collection.id, session.id), /Kilo permission denies forge_embed/)
          await rejects(embedding.coverage(collection.id, session.id), /Kilo permission denies forge_embed/)
          const selection = await api.retrieve("retire locks", { session: session.id, provider: sharing.provider })
          expect(selection.matches).toEqual([])
          expect(selection.audit?.channels?.find((item) => item.name === "collection-semantic")?.state).toBe("failed")
          expect(bodies).toHaveLength(2)
        })
        yield* env.set("KILO_FORGE_EMBEDDING_MODEL", "changed")
        yield* Effect.promise(async () => {
          await rejects(embedding.index(collection.id), /has not been approved/)
          await rejects(embedding.coverage(collection.id), /has not been approved/)
          expect((await api.retrieve("retire locks", { provider: sharing.provider })).matches).toEqual([])
          expect(bodies).toHaveLength(2)
        })
        yield* env.set("KILO_FORGE_EMBEDDING_MODEL", "fixture")
        yield* env.remove("KILO_FORGE_EMBEDDING_ENDPOINT")
        yield* Effect.promise(() => rejects(embedding.coverage(collection.id), /not configured/))
        yield* Effect.promise(() => embedding.revoke(collection.id))
        yield* env.set("KILO_FORGE_EMBEDDING_ENDPOINT", `${server.url}v1/embeddings`)
        yield* Effect.promise(async () => {
          await rejects(embedding.index(collection.id), /has not been approved/)
          const selection = await api.retrieve("retire locks", { provider: sharing.provider })
          expect(selection.matches).toEqual([])
          expect(bodies).toHaveLength(2)
          expect(directory).not.toBe("")
        })
      }),
    {
      config: {
        model: "fixture/model",
        small_model: "fixture/model",
        enabled_providers: ["fixture"],
        provider: {
          fixture: {
            npm: "@ai-sdk/openai-compatible",
            api: "http://127.0.0.1:1/v1",
            models: { model: { name: "Fixture", limit: { context: 32000, output: 1000 } } },
            options: { apiKey: "fixture" },
          },
        },
        permission: permission === "allowed" ? {} : { [permission]: "deny" },
      },
    },
    30_000,
  )
}
