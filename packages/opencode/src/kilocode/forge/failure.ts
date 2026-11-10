import { APICallError } from "ai"
import { EnhancementError, failure } from "@kilocode/forge/enhancement"
import type { EnhancementFailure } from "@kilocode/forge/schema"

export function transport(err: unknown, signal?: AbortSignal) {
  if (err instanceof EnhancementError) return err
  if (signal?.aborted) {
    if (signal.reason instanceof EnhancementError) return signal.reason
    return new EnhancementError("Enhancement was cancelled. Your prompt and answers were kept.", failure("cancelled"))
  }
  const api = APICallError.isInstance(err) ? err : undefined
  const status = api?.statusCode != null && Number.isInteger(api.statusCode) && api.statusCode >= 100 && api.statusCode <= 599
    ? api.statusCode : undefined
  // Provider messages may echo private input. Use them only to recognize known
  // failure classes; neither their text nor response bodies enter diagnostics.
  const text = api?.message.slice(0, 4096) ?? ""
  const message = err instanceof Error ? err.message.slice(0, 4096) : ""
  const code = err != null && typeof err === "object" ? Reflect.get(err, "code") : undefined
  const network = typeof code === "string" && ["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "ConnectionRefused", "ConnectionClosed"].includes(code)
    || /^(?:fetch failed|failed to fetch|network request failed|unable to connect)(?:[.:]|$)/i.test(message)
  const reason: NonNullable<EnhancementFailure["reason"]> =
    (status === 400 || status === 422) && /(?:does not|doesn't) support structured output|structured output (?:is |are )?(?:not supported|unsupported)/i.test(text) ? "unsupported-format"
      : (status === 400 || status === 422) && /invalid schema for response[_ ]format|response[_ ]format.*(?:not supported|unsupported)/i.test(text) ? "request-schema"
      : status === 401 ? "authentication"
      : status === 402 ? "credits"
      : status === 403 ? "permission"
      : status === 429 ? "rate-limit"
      : status === 413 || (status === 400 || status === 422) && /context[_ ](?:length|window)|maximum context|too many tokens/i.test(text) ? "context-limit"
      : status != null && status >= 500 ? "unavailable"
      : status != null && status >= 400 ? "invalid-request"
      : network ? "network" : "unknown"
  const details = {
    "request-schema": "The provider rejected Forge's response schema. This is a Forge/provider compatibility error, not a problem with your prompt or indexing. Repeating the unchanged request will not fix it.",
    "unsupported-format": "The selected model does not support structured output. This is a model capability mismatch, not bad input or indexing. Choose a compatible model explicitly; repeating the unchanged request will not fix it.",
    authentication: "The provider rejected authentication. Check the provider login or API key before retrying.",
    permission: "The provider denied this request. Check account access and provider policy before retrying.",
    credits: "The provider requires credits or billing access. Check the account or choose an available model explicitly.",
    "rate-limit": "The provider rate-limited this request. Wait before retrying or choose another model explicitly.",
    "context-limit": "The request exceeds the provider's context limit. Shorten the prompt or selected context, or choose a larger-context model.",
    unavailable: "The provider is temporarily unavailable. Retry explicitly later.",
    "invalid-request": "The provider rejected the request parameters. No usable task was returned; the exact rejection is not included because provider text may contain private input.",
    network: "The provider connection failed or was interrupted. Check connectivity before retrying explicitly.",
    unknown: "The model request failed before a valid task was returned. The cause was not recognized; retry explicitly.",
  }
  const detail = (status === 400 || status === 404) && /\bmodel\b.{0,200}\b(?:not supported|not available|does not exist)\b/i.test(text)
    ? "The selected model is not available through this provider or account. Choose another model explicitly; repeating the same request will not fix it."
    : details[reason]
  return new EnhancementError(
    `Enhancement provider failure${status ? ` (HTTP ${status})` : ""}: ${detail} Your prompt and answers were kept.`,
    { ...failure("transport"), reason, ...(status ? { status } : {}) },
  )
}
