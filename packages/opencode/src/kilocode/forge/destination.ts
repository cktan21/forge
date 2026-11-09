import { createHash } from "node:crypto"
import { Effect } from "effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Provider } from "@/provider/provider"
import * as Config from "@/config/config"
import { Env } from "@/env"
import { EnhancementError, failure } from "@kilocode/forge/enhancement"
import { route } from "./routing"

const credential = /authorization|cookie|api[-_]?key|token|password|secret|credential|private[-_]?key/i

// Bind configuration, not credentials. Reviewed origins constrain hooked HTTP
// sends; full sanitized routes, SDKs, options, and headers bind the approval.
export function describe(value: unknown, env: Record<string, string | undefined> = {}) {
  const origins = new Set<string>()
  function normalize(value: unknown, field = ""): unknown {
    if (typeof value === "string") {
      const text = value.replace(/\$\{([^}]+)\}/g, (match, key: string) => env[key] ?? match)
      if (!/^https?:\/\//i.test(text)) return text
      const url = new URL(text)
      url.username = ""
      url.password = ""
      const keys = [...url.searchParams.keys()].filter((key) => credential.test(key))
      for (const key of keys) url.searchParams.delete(key)
      if (/(?:url|endpoint)$/i.test(field)) origins.add(url.origin)
      return url.href
    }
    if (Array.isArray(value)) return value.map((item) => normalize(item, field))
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).filter(([key]) => !credential.test(key))
        .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, normalize(item, key)]))
    }
    if (typeof value === "function") {
      const known = route(value)
      if (known) return normalize(known, field)
      throw new EnhancementError("Custom provider routing functions cannot receive Forge approval. Use a supported built-in provider transport. No model request was made.", failure("transport"))
    }
    return value
  }
  const normalized = normalize(value)
  return {
    fingerprint: createHash("sha256").update(JSON.stringify(["forge-routing-v2", normalized])).digest("hex"),
    origins: [...origins].sort(),
  }
}

export function destination(key: string) {
  return Effect.gen(function* () {
    const providers = yield* Provider.Service
    const config = yield* Config.Service
    const env = yield* Env.Service
    const provider = yield* providers.getProvider(ProviderV2.ID.make(key))
    if (!provider) throw new Error("Sharing provider is unavailable")
    const cfg = yield* config.get()
    return describe({
      id: provider.id,
      options: provider.options,
      configured: cfg.provider?.[key],
      models: Object.fromEntries(Object.entries(provider.models).map(([id, model]) => [id, {
        api: model.api, options: model.options, headers: model.headers,
      }])),
    }, yield* env.all())
  })
}
