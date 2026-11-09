import { PreparationBinding } from "./writing"
import { decode } from "./schema"

function object(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value)
}

export function tagged(part: unknown) {
  return object(part) && part.type === "text" && object(part.metadata) && Object.hasOwn(part.metadata, "forgePreparation")
}

export function binding(part: unknown): PreparationBinding | undefined {
  if (!tagged(part) || !object(part) || !object(part.metadata)) return undefined
  return decode(PreparationBinding, part.metadata.forgePreparation)
}

export function metadata(value: PreparationBinding) {
  return { forgePreparation: decode(PreparationBinding, value) }
}

export function reference(parts: readonly unknown[]) {
  const values = parts.filter(tagged)
  if (values.length > 1) throw new Error("A prompt cannot contain multiple preparation bindings")
  return binding(values.at(0))
}
