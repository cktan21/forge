import { Effect, Queue, Schema, Stream } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { HttpServerResponse } from "effect/unstable/http"
import * as Sse from "effect/unstable/encoding/Sse"
import type { Engine } from "@kilocode/forge"
import { Forge } from "@/kilocode/forge/service"
import { InstanceHttpApi } from "@/server/routes/instance/httpapi/api"
import { ForgeError, ForgeInput } from "../groups/forge"
import { enhancePrompt } from "@/kilocode/enhance-prompt"
import { usage, type EnhancementFrame } from "@kilocode/forge/schema"
import { EffectBridge } from "@/effect/bridge"
import * as Session from "@/session/session"
import { SessionID } from "@/session/schema"
import { InstanceState } from "@/effect/instance-state"
import { realpath } from "node:fs/promises"
import { EnhancementError } from "@kilocode/forge/enhancement"
import { InvestigationInput, type InvestigationFrame } from "@kilocode/forge/investigation"

export const forgeHandlers = HttpApiBuilder.group(InstanceHttpApi, "forge", (handlers) => Effect.gen(function* () {
  const forge = yield* Forge.Service
  const sessions = yield* Session.Service
  const run = <A>(fn: (engine: Engine, signal: AbortSignal) => Promise<A>, session?: string) => Effect.gen(function* () {
    if (session) {
      const info = yield* sessions.get(SessionID.make(session)).pipe(Effect.mapError(() => new ForgeError({ message: "Session is unavailable" })))
      const ctx = yield* InstanceState.context
      const paths = yield* Effect.tryPromise({ try: () => Promise.all([realpath(info.directory), realpath(ctx.directory)]), catch: () => new ForgeError({ message: "Session directory is unavailable" }) })
      if (paths.at(0) !== paths.at(1)) return yield* Effect.fail(new ForgeError({ message: "Session belongs to a different workspace" }))
    }
    const engine = yield* forge.get()
    return yield* Effect.tryPromise({ try: (signal) => fn(engine, signal), catch: (err) => new ForgeError({ message: err instanceof Error ? err.message : String(err), ...(err instanceof EnhancementError ? { failure: err.failure } : {}) }) })
  })
  return handlers
    .handle("status", ({ query }) => run((engine) => engine.status(query.session), query.session))
    .handle("knowledge", ({ query }) => run(async (engine) => ({ ...await engine.registry({ session: query.session, query: query.query, limit: query.limit ? Number(query.limit) : undefined, offset: query.offset ? Number(query.offset) : undefined, generation: query.generation }), ...await engine.destination().catch((err) => ({ provider: "", warning: err instanceof Error ? err.message : String(err) })) }), query.session))
    .handle("imports", ({ params, query }) => run((engine) => engine.imports(params.id, { session: query.session, run: query.run, offset: query.offset ? Number(query.offset) : undefined, limit: query.limit ? Number(query.limit) : undefined }), query.session))
    .handle("embeddingReview", ({ params, query }) => run((engine, signal) => {
      if (!engine.embeddings) throw new Error("Collection embeddings are unavailable in this host")
      return engine.embeddings.review(params.id, query.session, signal)
    }, query.session))
    .handle("embeddingCoverage", ({ params, query }) => run((engine, signal) => {
      if (!engine.embeddings) throw new Error("Collection embeddings are unavailable in this host")
      return engine.embeddings.coverage(params.id, query.session, signal)
    }, query.session))
    .handle("embeddingApprove", ({ params, payload }) => run(async (engine, signal) => {
      if (!engine.embeddings) throw new Error("Collection embeddings are unavailable in this host")
      await engine.embeddings.approve(params.id, payload.revision, payload.session, signal)
      return { approved: true as const }
    }, payload.session))
    .handle("embeddingRevoke", ({ params, payload }) => run(async (engine, signal) => {
      if (!engine.embeddings) throw new Error("Collection embeddings are unavailable in this host")
      await engine.embeddings.revoke(params.id, payload.session, signal)
      return { revoked: true as const }
    }, payload.session))
    .handle("embeddingIndex", ({ params, payload }) => run((engine, signal) => {
      if (!engine.embeddings) throw new Error("Collection embeddings are unavailable in this host")
      return engine.embeddings.index(params.id, payload.session, signal)
    }, payload.session))
    .handle("embeddingJobs", ({ params, query }) => run((engine, signal) => {
      if (!engine.embeddings) throw new Error("Collection embeddings are unavailable in this host")
      return engine.embeddings.jobs.list(params.id, query.session, signal)
    }, query.session))
    .handle("embeddingUsage", ({ query }) => run((engine, signal) => {
      if (!engine.embeddings) throw new Error("Collection embeddings are unavailable in this host")
      return engine.embeddings.usage({ session: query.session, after: query.after, limit: query.limit == null ? undefined : Number(query.limit) }, signal)
    }, query.session))
    .handle("embeddingRetention", ({ payload }) => run((engine, signal) => {
      if (!engine.embeddings) throw new Error("Collection embeddings are unavailable in this host")
      return engine.embeddings.retention(payload, signal)
    }, payload.session))
    .handle("embeddingPrune", ({ payload }) => run((engine, signal) => {
      if (!engine.embeddings) throw new Error("Collection embeddings are unavailable in this host")
      return engine.embeddings.prune(payload, signal)
    }, payload.session))
    .handle("embeddingStart", ({ params, payload }) => run((engine, signal) => {
      if (!engine.embeddings) throw new Error("Collection embeddings are unavailable in this host")
      return engine.embeddings.jobs.start(params.id, payload.session, signal)
    }, payload.session))
    .handle("embeddingCancel", ({ params, payload }) => run(async (engine, signal) => {
      if (!engine.embeddings) throw new Error("Collection embeddings are unavailable in this host")
      await engine.embeddings.jobs.cancel(params.id, params.job, payload.session, signal)
      return { requested: true as const }
    }, payload.session))
    .handle("register", ({ payload }) => run((engine) => engine.register(payload), payload.session))
    .handle("preview", ({ payload }) => run((engine, signal) => engine.preview(payload, signal), payload.session))
    .handle("collection", ({ params, payload }) => run(async (engine) => {
      if (payload.action === "approve") return { collection: await engine.approve(params.id, payload.session, [...payload.providers ?? []], payload.grants) }
      if (payload.action === "index") return { collection: await engine.index(params.id, payload.session) }
      if (payload.action === "pause" || payload.action === "remove") return { collection: await engine.stop(params.id, payload.session, payload.action === "remove") }
      if (payload.confirmation !== "PURGE") throw new Error("Purge requires explicit PURGE confirmation. It also clears workspace request captures and derived caches; chat transcripts and already-sent content are separate.")
      await engine.purge(params.id, payload.session)
      return {}
    }, payload.session))
    .handle("policy", ({ query }) => run((engine) => engine.policy(query.session), query.session))
    .handle("configure", ({ payload }) => run((engine) => engine.configure(payload), payload.session))
    .handle("index", () => run(async (engine) => engine.start()))
    .handle("cancel", () => run(async (engine) => engine.cancel()))
    .handle("view", ({ query }) => run((engine, signal) => engine.view({ session: query.session, category: query.category, focus: query.focus, document: query.document, query: query.query, limit: query.limit ? Number(query.limit) : undefined, offset: query.offset ? Number(query.offset) : undefined, generation: query.generation, signal }), query.session))
    .handle("baseline", ({ payload }) => Effect.gen(function* () {
      yield* forge.get()
      return yield* EffectBridge.fromPromise(async () => {
        let measured = usage()
        const text = await enhancePrompt(payload.text, (value) => { measured = value })
        return { text, usage: measured }
      }).pipe(Effect.catchDefect((err) => err instanceof Error
        ? Effect.fail(new ForgeError({ message: err.message }))
        : Effect.die(err)))
    }))
    .handle("refresh", () => run(async (engine, signal) => { await engine.refresh(true, signal); return engine.graph() }))
    .handle("graph", ({ query }) => run((engine) => engine.graph({ focus: query.focus, query: query.query, limit: query.limit ? Number(query.limit) : undefined })))
    .handle("source", ({ params, query }) => run((engine, signal) => engine.symbol(params.id, query.session, undefined, signal), query.session))
    .handle("overview", () => run((engine, signal) => engine.overview(signal)))
    .handle("ideas", ({ payload }) => run((engine, signal) => engine.ideas(payload.goal, signal)))
    .handle("opportunities", () => run((engine) => engine.opportunities()))
    .handle("decide", ({ params, payload }) => run((engine) => engine.decide(params.id, payload.status)))
    .handle("enhance", ({ payload }) => run((engine, signal) => engine.enhance({ ...payload, signal }), payload.session))
    .handle("investigationStatus", ({ query }) => run((engine) => engine.investigationStatus(), query.session))
    .handle("investigate", ({ payload }) => run((engine, signal) => engine.investigate({ ...payload, signal }), payload.session))
    .handle("investigation", ({ params, query }) => run((engine, signal) => engine.investigation(params.id, query.session, signal), query.session))
    .handle("chooseDirection", ({ payload }) => run((engine, signal) => engine.chooseDirection(payload, signal), payload.session))
    .handle("writePrompt", ({ payload }) => run((engine, signal) => engine.writePrompt(payload, signal), payload.session))
    .handle("editPrompt", ({ payload }) => run((engine, signal) => engine.editPrompt(payload, signal), payload.session))
    .handle("preparedPrompt", ({ params, query }) => run((engine, signal) => engine.preparedPrompt(params.id, query.session, signal), query.session))
    .handle("bindPrompt", ({ payload }) => run((engine, signal) => engine.bindPrompt(payload, signal), payload.session))
    .handleRaw("investigateStream", ({ request }) => Effect.gen(function* () {
      const payload = yield* request.json.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(InvestigationInput)),
        Effect.mapError(() => new ForgeError({ message: "Invalid investigation input" })),
      )
      const engine = yield* run(async (engine) => engine, payload.session)
      const output = Stream.unwrap(Effect.gen(function* () {
        const queue = yield* Queue.sliding<InvestigationFrame>(16)
        yield* Effect.tryPromise({
          try: (signal) => engine.investigate({ ...payload, signal, update: (value) => { Queue.offerUnsafe(queue, value) } }),
          catch: (err) => err,
        }).pipe(
          Effect.match({
            onFailure: (err) => Queue.offerUnsafe(queue, {
              type: "error",
              message: err instanceof EnhancementError ? err.message
                : "Investigation could not complete. Your input is preserved; inspect permissions, model support and source freshness before retrying.",
              ...(err instanceof EnhancementError ? { failure: err.failure } : {}),
            }),
            onSuccess: (investigation) => Queue.offerUnsafe(queue, { type: "result", investigation }),
          }),
          Effect.forkScoped,
        )
        return Stream.fromQueue(queue).pipe(Stream.takeUntil((frame) => frame.type !== "progress"))
      }))
      return HttpServerResponse.stream(output.pipe(
        Stream.map((frame): Sse.Event => ({ _tag: "Event", event: "message", id: undefined, data: JSON.stringify(frame) })),
        Stream.pipeThroughChannel(Sse.encode()),
        Stream.encodeText,
      ), {
        contentType: "text/event-stream",
        headers: { "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no", "X-Content-Type-Options": "nosniff" },
      })
    }))
    .handleRaw("enhanceStream", ({ request }) => Effect.gen(function* () {
      const payload = yield* request.json.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(ForgeInput)),
        Effect.mapError(() => new ForgeError({ message: "Invalid enhancement input" })),
      )
      // Authorize the exact session before opening a content-bearing response.
      const engine = yield* run(async (engine) => engine, payload.session)
      const output = Stream.unwrap(Effect.gen(function* () {
        const queue = yield* Queue.sliding<EnhancementFrame>(16)
        yield* Effect.tryPromise({
          try: (signal) => engine.enhance({ ...payload, signal, update: (value) => { Queue.offerUnsafe(queue, value) } }),
          catch: (err) => err,
        }).pipe(
          Effect.match({
            onFailure: (err) => Queue.offerUnsafe(queue, { type: "error", message: err instanceof Error ? err.message : String(err), ...(err instanceof EnhancementError ? { failure: err.failure } : {}) }),
            onSuccess: (proposal) => Queue.offerUnsafe(queue, { type: "result", proposal }),
          }),
          Effect.forkScoped,
        )
        return Stream.fromQueue(queue).pipe(Stream.takeUntil((frame) => frame.type !== "progress"))
      }))
      return HttpServerResponse.stream(output.pipe(
        Stream.map((frame): Sse.Event => ({ _tag: "Event", event: "message", id: undefined, data: JSON.stringify(frame) })),
        Stream.pipeThroughChannel(Sse.encode()),
        Stream.encodeText,
      ), {
        contentType: "text/event-stream",
        headers: { "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no", "X-Content-Type-Options": "nosniff" },
      })
    }))
    .handle("validate", ({ payload }) => run(async (engine, signal) => ({ valid: await engine.validate(payload, signal) }), payload.session))
    .handle("search", ({ query }) => run((engine, signal) => engine.retrieve(query.q, { signal, session: query.session }), query.session))
    .handle("requests", ({ query }) => run((engine) => engine.manifests({ session: query.session ?? "", purpose: query.purpose, limit: query.limit ? Number(query.limit) : undefined, offset: query.offset ? Number(query.offset) : undefined }), query.session))
    .handle("request", ({ params, query }) => run(async (engine) => ({ request: await engine.request(params.id, query.session) ?? null }), query.session))
    .handle("requestObservation", () => run((engine) => engine.requestObservation()))
    .handle("database", () => run((engine, signal) => engine.database(signal)))
}))
