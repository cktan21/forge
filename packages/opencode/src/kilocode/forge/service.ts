import { Context, Effect, Exit, Layer } from "effect"
import { generateText, Output, parsePartialJson, streamText } from "ai"
import { realpath } from "node:fs/promises"
import path from "node:path"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import * as Log from "@opencode-ai/core/util/log"
import { engine, type Engine } from "@kilocode/forge"
import { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { Bus } from "@/bus"
import { Git } from "@/git"
import { EffectBridge } from "@/effect/bridge"
import { InstanceState } from "@/effect/instance-state"
import { documents, database } from "./sources"
import * as Trace from "./trace"
import { extract } from "./extract"
import { recall } from "./memory"
import { authorize } from "./access"
import { destination } from "./destination"
import { Env } from "@/env"
import { Changed } from "./events"
import { storage as persistence } from "./storage"
import { readiness } from "@kilocode/forge/semantic"
import { peek } from "../indexing-observation"
import { configuration } from "./embeddings"
import { references } from "@kilocode/forge/references"
import { contract } from "@kilocode/forge/preparation"
import { EnhancementError, failure } from "@kilocode/forge/enhancement"
import { wait } from "@kilocode/forge/wait"
import { transport } from "./failure"
import { format } from "./format"

const log = Log.create({ service: "forge" })

export class Service extends Context.Service<Service, { get: () => Effect.Effect<Engine> }>()("@kilocode/Forge") {}

export const layer = Layer.effect(Service, Effect.gen(function* () {
  const env = yield* Env.Service
  const bus = yield* Bus.Service
  const storage = yield* persistence
  const engines = new Map<string, Engine>()
  const cleanup: Array<() => void> = []
  yield* Effect.addFinalizer(() => Effect.promise(async () => {
    await Promise.allSettled([...engines.values()].map((value) => value.dispose()))
    for (const fn of cleanup) fn()
    engines.clear()
  }))

  return Service.of({
    get: Effect.fn("Forge.get")(function* () {
      const instance = yield* InstanceState.context
      const root = yield* Effect.promise(() => realpath(instance.directory))
      const cached = engines.get(root)
      if (cached) return cached
      const bridge = yield* EffectBridge.make()
      cleanup.push(storage.subscribe(root, (change) => {
        void bridge.promise(bus.publish(Changed, change)).catch((err) => log.warn("Forge event publication failed", { error: String(err) }))
      }))
      const access = (item: import("@kilocode/forge/schema").Collection, session: string, providers: readonly string[]) => bridge.promise(authorize(item, session, providers))
      const routing = (provider: string) => bridge.promise(destination(provider).pipe(Effect.provideService(Env.Service, env)))
      cleanup.push(Trace.register(root, storage, access, routing))
      const value = engine({
        root,
        references: references(instance.worktree === "/" ? root : instance.worktree),
        store: storage,
        warn: (text) => log.warn(text),
        extract,
        readiness: () => readiness(peek(instance.directory)),
        memory: (query, session, signal) => bridge.promise(recall(query, session, signal)),
        authorize: access,
        embeddings: {
          configuration: () => bridge.promise(env.all()).then(configuration),
          authorize: (item, session, endpoint) => bridge.promise(authorize(item, session, [], endpoint)),
        },
        destination: routing,
        provider: () => bridge.promise(Effect.gen(function* () {
          const provider = yield* Provider.Service
          const ref = yield* provider.defaultModel()
          return (yield* provider.getSmallModel(ref.providerID))?.providerID ?? ref.providerID
        })),
        resolve: (input) => bridge.promise(Effect.gen(function* () {
          const provider = yield* Provider.Service
          const ref = input ? Provider.parseModel(`${input.providerID}/${input.modelID}`) : yield* provider.defaultModel()
          const model = input ? yield* provider.getModel(ref.providerID, ref.modelID)
            : (yield* provider.getSmallModel(ref.providerID)) ?? (yield* provider.getModel(ref.providerID, ref.modelID))
          if (!model.capabilities.output.text || model.limit.output <= 0) throw new Error("The selected enhancement model cannot produce text. Choose another model explicitly.")
          return { providerID: model.providerID, modelID: model.id }
        })),
        revision: () => bridge.promise(Effect.gen(function* () {
          const git = yield* Git.Service
          const result = yield* git.run(["rev-parse", "HEAD"], { cwd: root })
          return result.stdout.toString().trim()
        })),
        history: () => bridge.promise(Effect.gen(function* () {
          const git = yield* Git.Service
          const result = yield* git.run(["log", "-30", "--format=FORGE_COMMIT:%H", "--name-only", "--no-renames"], { cwd: root, maxOutputBytes: 100_000 })
          return result.stdout.toString().split("FORGE_COMMIT:").filter(Boolean).map((block) => { const lines = block.trim().split("\n").filter(Boolean); return { commit: lines.at(0)!, files: lines.slice(1) } })
        })),
        complete: (input) => bridge.promise(Effect.gen(function* () {
          const provider = yield* Provider.Service
          const ref = input.model ? Provider.parseModel(`${input.model.providerID}/${input.model.modelID}`) : yield* provider.defaultModel()
          const model = input.model ? yield* provider.getModel(ref.providerID, ref.modelID)
            : (yield* provider.getSmallModel(ref.providerID)) ?? (yield* provider.getModel(ref.providerID, ref.modelID))
          if (input.provider && input.provider !== model.providerID) throw new Error("Preparation provider changed. Review source sharing before retrying.")
          const language = yield* provider.getLanguage(model)
          const mode = format(model)
          const schema = input.purpose === "enhance" ? contract(input.evidence) : undefined
          const system = schema && mode === "prompt"
            ? `${input.system}\n\nRequired JSON response schema (return only the complete JSON object; every field remains required):\n${JSON.stringify(schema["~standard"].jsonSchema.output({ target: "draft-07" }))}`
            : input.system
          const started = Date.now()
          const capture = yield* Effect.promise(() => Trace.start({ root, session: input.session, purpose: input.purpose, model: `${model.providerID}/${model.id}`, system: [system], messages: [{ role: "user", content: input.prompt }], options: schema ? { enhancementFormat: mode } : undefined, request: input.request }))
          if (!capture) throw new Error("Preparation accounting capture is unavailable. No model request was made.")
          const options = {
            model: language,
            system,
            prompt: input.prompt,
            temperature: model.capabilities.temperature ? 0.1 : undefined,
            providerOptions: ProviderTransform.providerOptions(model, model.options),
            abortSignal: input.signal,
            maxOutputTokens: Math.min(input.purpose === "enhance" ? 12_000 : 5000, model.limit.output),
            maxRetries: input.purpose === "enhance" ? 0 : 1,
          }
          const invoke = async () => {
            if (input.purpose !== "enhance") return generateText(options)
            if (mode === "prompt") input.update?.({ type: "progress", stage: "Using JSON text for the auto-routed model; the complete response will still be validated locally" })
            input.update?.({ type: "progress", stage: `Waiting for ${model.providerID}/${model.id}` })
            const result = streamText({
              ...options,
              ...(schema && mode === "schema" ? { output: Output.object({ schema, name: "forge_enhancement" }) } : {}),
              onError: ({ error }) => {
                const report = transport(error, input.signal).failure
                log.warn("Enhancement stream failed", { model: `${model.providerID}/${model.id}`, code: report.code, reason: report.reason, status: report.status })
              },
            })
            let text = ""
            let updated = 0
            for await (const chunk of result.fullStream) {
              input.signal?.throwIfAborted()
              if (chunk.type === "error") throw chunk.error
              if (chunk.type === "reasoning-start") {
                input.update?.({ type: "progress", stage: `${model.providerID}/${model.id} is preparing a response` })
              }
              // Only the public explanation and draft are displayed, not reasoning deltas.
              if (chunk.type !== "text-delta") continue
              text += chunk.text
              if (text.length > 100_000) throw new EnhancementError("The model response exceeded the enhancement size limit. Your prompt was kept.", failure("cutoff"))
              if (!input.update || Date.now() - updated < 80) continue
              updated = Date.now()
              const parsed = await parsePartialJson(text)
              const value = parsed.value
              if (!value || typeof value !== "object" || Array.isArray(value)) continue
              const preview = [
                typeof value.objective === "string" ? value.objective : "",
                ...(Array.isArray(value.changes) ? value.changes.filter((item): item is string => typeof item === "string").map((item) => `- ${item}`) : []),
              ].filter(Boolean).join("\n")
              input.update({
                type: "progress",
                stage: `${model.providerID}/${model.id} is writing the improved prompt`,
                summary: typeof value.summary === "string" ? value.summary.slice(0, 2000) : undefined,
                preview: preview.slice(0, 12_000),
              })
            }
            // Validate in the engine after usage is captured, including failed responses.
            return { text: await result.text, usage: await result.totalUsage, finishReason: await result.finishReason }
          }
          const result = yield* Effect.tryPromise({
            try: () => wait(() => capture.run(invoke), input.signal),
            catch: (err) => input.purpose === "enhance" ? transport(err, input.signal) : err,
          }).pipe(
            Effect.onExit((exit) => Exit.isFailure(exit)
              ? Effect.promise(() => capture?.finish({}, true).catch((err) => log.warn("failed preparation usage unavailable", { error: String(err) })) ?? Promise.resolve())
              : Effect.void),
          )
          yield* Effect.promise(() => capture?.finish({ input: result.usage.inputTokens ?? 0, output: result.usage.outputTokens ?? 0, cached: result.usage.inputTokenDetails?.cacheReadTokens ?? 0, measured: true }) ?? Promise.resolve())
          const measured = { input: result.usage.inputTokens ?? 0, output: result.usage.outputTokens ?? 0, cached: result.usage.inputTokenDetails?.cacheReadTokens ?? 0, milliseconds: Date.now() - started, model: `${model.providerID}/${model.id}`, measured: true }
          if (result.finishReason === "length") throw new EnhancementError("The model response was cut off at its output limit. Your prompt was kept. Retry with a shorter request or choose a model with a larger output limit.", { ...failure("cutoff"), finish: "length", usage: measured })
          return { text: result.text, usage: measured, finish: result.finishReason }
        })),
        semantic: (query, signal, scope) => bridge.promise(Effect.promise(async () => {
          signal?.throwIfAborted()
          const observed = peek(instance.directory)
          if (!observed?.initialized || observed.state === "Disabled") return []
          // Indexing imports AppRuntime; inspection must not load that graph.
          const { KiloIndexing } = await import("@/kilocode/indexing")
          signal?.throwIfAborted()
          if (!KiloIndexing.ready()) return []
          const mask = scope.flatMap((file) => {
            const uri = file.paths.at(0)
            if (!uri) return []
            const absolute = path.resolve(root, uri)
            const relative = path.relative(root, absolute)
            if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return []
            return [{ ...file, paths: [...new Set([relative, relative.split(path.sep).join("/"), absolute])] }]
          })
          const matches = await KiloIndexing.search(query, undefined, mask, signal)
          signal?.throwIfAborted()
          const { source } = await import("@kilocode/forge/parse")
          signal?.throwIfAborted()
          return matches.flatMap((match) => {
            const payload = match.payload
            if (!payload || typeof payload.codeChunk !== "string" || typeof payload.filePath !== "string") return []
            const relative = path.relative(root, path.resolve(root, payload.filePath))
            if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return []
            const item = source(relative.split(path.sep).join("/"), payload.codeChunk, "code", { start: Number(payload.startLine ?? 1), end: Number(payload.endLine ?? 1), method: "semantic-search" })
            return [{ source: item, score: match.score, reason: "Existing semantic index" }]
          })
        })),
        docs: (input) => bridge.promise(documents(input, storage, root)),
        database: (cfg, signal) => bridge.promise(database(cfg, signal)),
      })
      engines.set(root, value)
      return value
    }),
  })
}))

export const node = LayerNode.make({ service: Service, layer, deps: [Database.node, Env.node, Bus.node] })
export * as Forge from "./service"
