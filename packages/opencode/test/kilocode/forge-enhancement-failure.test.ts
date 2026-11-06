import { expect, test } from "bun:test"
import { APICallError } from "ai"
import { diagnostic, EnhancementError, failure } from "@kilocode/forge/enhancement"
import { transport } from "@/kilocode/forge/failure"
import { format } from "@/kilocode/forge/format"

test.each([
  { status: 400, message: "This model does not support structured output. Remove it and retry.", reason: "unsupported-format", visible: "model does not support structured output" },
  { status: 400, message: "Invalid schema for response_format 'forge_enhancement': 'allOf' is not permitted.", reason: "request-schema", visible: "Forge/provider compatibility error" },
  { status: 400, message: "Invalid schema for response_format 'forge_enhancement': 'minLength' together with 'pattern' is not supported yet.", reason: "request-schema", visible: "Repeating the unchanged request will not fix it" },
  { status: 401, message: "Invalid API key", reason: "authentication", visible: "login or API key" },
  { status: 402, message: "Insufficient credits", reason: "credits", visible: "billing access" },
  { status: 403, message: "Denied", reason: "permission", visible: "denied" },
  { status: 429, message: "Too many requests", reason: "rate-limit", visible: "rate-limited" },
  { status: 400, message: "Maximum context length exceeded", reason: "context-limit", visible: "context limit" },
  { status: 413, message: "Too large", reason: "context-limit", visible: "context limit" },
  { status: 503, message: "Unavailable", reason: "unavailable", visible: "temporarily unavailable" },
  { status: 400, message: "Unrecognized problem", reason: "invalid-request", visible: "rejected the request parameters" },
])("provider HTTP $status maps to safe $reason diagnostics", (item) => {
  const err = new APICallError({
    message: `${item.message} PRIVATE_PROMPT_CANARY`,
    statusCode: item.status,
    url: "https://provider.invalid/PRIVATE_URL_CANARY",
    requestBodyValues: { secret: "PRIVATE_KEY_CANARY" },
    responseBody: "PRIVATE_RESPONSE_CANARY",
  })
  const result = transport(err)
  expect(result.message).toContain(item.visible)
  expect(result.message).toContain(`HTTP ${item.status}`)
  expect(result.message).toContain("Your prompt and answers were kept")
  expect(result.failure).toMatchObject({ code: "transport", reason: item.reason, status: item.status })
  expect(diagnostic(result.failure)).toEqual(result.failure)
  expect(result.message + JSON.stringify(result)).not.toContain("PRIVATE_")
})

test("auto-routed gateway models use prompt JSON without changing ordinary provider formats", () => {
  const model = { providerID: "kilo", id: "kilo-auto/free", api: { npm: "@kilocode/kilo-gateway" } }
  expect(format(model)).toBe("prompt")
  expect(format({ ...model, id: "kilo-auto/small" })).toBe("prompt")
  expect(format({ ...model, id: "router", autoRouting: { models: ["first", "second"] } })).toBe("prompt")
  expect(format({ ...model, providerID: "gateway-alias" })).toBe("prompt")
  expect(format({ ...model, id: "fixed-model" })).toBe("schema")
  expect(format({ ...model, providerID: "other", api: { npm: "@ai-sdk/openai-compatible" } })).toBe("schema")
})

test("cancellation and existing typed failures are not relabeled as provider rejection", () => {
  const err = new EnhancementError("Deadline expired", failure("timeout"))
  expect(transport(err)).toBe(err)
  expect(transport(new TypeError("fetch failed")).failure.reason).toBe("network")
  expect(transport(Object.assign(new Error("PRIVATE_NETWORK_CANARY"), { code: "ECONNRESET" })).failure.reason).toBe("network")
  expect(transport(new TypeError("PRIVATE_APPLICATION_ERROR")).failure.reason).toBe("unknown")
  expect(transport(new Error("PRIVATE_UNKNOWN_CANARY")).failure.reason).toBe("unknown")
  const controller = new AbortController()
  controller.abort(err)
  expect(transport(new Error("Interrupted"), controller.signal)).toBe(err)
  expect(transport(new Error("Interrupted"), AbortSignal.abort()).failure.code).toBe("cancelled")
  expect(diagnostic({ ...failure("transport"), status: 999 })).toBeUndefined()
  expect(diagnostic({ ...failure("transport"), reason: "PRIVATE_UNKNOWN_REASON" })).toBeUndefined()
})
