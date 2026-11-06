import type { EmbeddingHost } from "@kilocode/forge/embeddings"

// Host-owned variables only. Project documents cannot nominate an environment
// variable containing a credential or configure automatic collection uploads.
export function configuration(
  env: Record<string, string | undefined>,
): Awaited<ReturnType<EmbeddingHost["configuration"]>> {
  const endpoint = env.KILO_FORGE_EMBEDDING_ENDPOINT
  if (!endpoint) return undefined
  const model = env.KILO_FORGE_EMBEDDING_MODEL
  const dimensions = Number(env.KILO_FORGE_EMBEDDING_DIMENSIONS)
  if (!model || !Number.isInteger(dimensions) || dimensions < 1 || dimensions > 4096) {
    throw new Error("Configure KILO_FORGE_EMBEDDING_MODEL and KILO_FORGE_EMBEDDING_DIMENSIONS (1-4096)")
  }
  const authentication = env.KILO_FORGE_EMBEDDING_AUTHENTICATION ?? "bearer"
  if (authentication !== "bearer" && authentication !== "api-key")
    throw new Error("Invalid embedding authentication mode")
  return {
    endpoint,
    model,
    dimensions,
    authentication,
    key: env.KILO_FORGE_EMBEDDING_KEY,
    organization: env.KILO_FORGE_EMBEDDING_ORGANIZATION,
    project: env.KILO_FORGE_EMBEDDING_PROJECT,
  }
}
