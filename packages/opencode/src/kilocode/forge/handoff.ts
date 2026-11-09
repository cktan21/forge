import { Effect, Option } from "effect"
import { metadata, reference, tagged } from "@kilocode/forge/handoff"
import type { EnhancementModel } from "@kilocode/forge/schema"
import { Forge } from "./service"

type Part = { type: string; text?: string; metadata?: Record<string, unknown> }

export const admit = Effect.fn("Forge.handoff.admit")(function* (input: {
  session: string
  model: EnhancementModel
  expected: readonly unknown[]
  parts: Part[]
}) {
  const expected = reference(input.expected)
  const actual = reference(input.parts)
  if (!expected && !actual) return
  if (!expected || !actual || expected.id !== actual.id || expected.revision !== actual.revision || expected.hash !== actual.hash || expected.session !== actual.session) throw new Error("Preparation metadata changed before message admission")
  const part = input.parts.find(tagged)
  if (!part || typeof part.text !== "string") throw new Error("Prepared prompt text is unavailable")
  const forge = yield* Effect.serviceOption(Forge.Service)
  if (Option.isNone(forge)) throw new Error("This backend cannot validate the prepared prompt")
  const engine = yield* forge.value.get()
  const record = yield* Effect.tryPromise((signal) => engine.bindPrompt({
    binding: actual, text: part.text!, session: input.session, model: input.model,
  }, signal))
  part.metadata = { ...part.metadata, ...metadata({ id: record.id, revision: record.revision, hash: record.hash, session: record.session }) }
})

export const context = Effect.fn("Forge.handoff.context")(function* (session: string, model: EnhancementModel) {
  const available = yield* Effect.serviceOption(Forge.Service)
  if (Option.isNone(available)) return {}
  const engine = yield* available.value.get()
  const dependencies = yield* Effect.tryPromise((signal) => engine.codingContext(session, model, signal))
  return {
    dependencies,
    check: async () => { await engine.codingContext(session, model) },
  }
})
