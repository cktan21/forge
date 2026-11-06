import { request as http, validateHeaderValue } from "node:http"
import { request as https } from "node:https"
import { Schema } from "effect"
import { decode } from "./schema"
import { Target } from "./embedding-consent"
import { hash } from "./util"
import { reported, type Observer } from "./embedding-usage"

type Options = {
  // An exact endpoint, not a base URL. No path guessing or redirect following.
  endpoint: string
  model: string
  dimensions: number
  key?: string
  authentication?: "bearer" | "api-key"
  organization?: string
  project?: string
  timeout?: number
}

const Response = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      index: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
      embedding: Schema.Array(Schema.Finite),
    }),
  ),
})

const maximum = 16 * 1024 * 1024

// Node's direct HTTP agents do not consume environment proxy settings. Do not
// replace this with a redirecting SDK/default fetch without preserving that
// destination boundary. DNS and the approved server's internal routing remain
// outside this transport's control.
export function embeddingHttp(opts: Options) {
  const url = (() => {
    try {
      return new URL(opts.endpoint)
    } catch {
      throw new Error("Invalid embedding endpoint")
    }
  })()
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash ||
    [...url.searchParams.keys()].some((key) => key !== "api-version") ||
    (url.protocol === "http:" && !["127.0.0.1", "[::1]"].includes(url.hostname))
  )
    throw new Error(
      "Embedding endpoint requires HTTPS or numeric loopback HTTP, without URL credentials or routing queries",
    )
  const endpoint = url.href
  const timeout = opts.timeout ?? 30_000
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 120_000)
    throw new Error("Embedding timeout must be 1-120000 ms")
  const authentication = opts.authentication ?? "bearer"
  if (!["bearer", "api-key"].includes(authentication)) throw new Error("Unsupported embedding authentication")
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" }
  if (opts.key)
    headers[authentication === "bearer" ? "authorization" : "api-key"] =
      authentication === "bearer" ? `Bearer ${opts.key}` : opts.key
  if (opts.organization) headers["openai-organization"] = opts.organization
  if (opts.project) headers["openai-project"] = opts.project
  try {
    for (const [key, value] of Object.entries(headers)) validateHeaderValue(key, value)
  } catch {
    throw new Error("Invalid embedding header value")
  }
  const target = Object.freeze(
    decode(Target, {
      fingerprint: hash(
        JSON.stringify([
          "forge-embedding-http-v1",
          endpoint,
          authentication,
          opts.organization ?? "",
          opts.project ?? "",
        ]),
      ),
      model: opts.model,
      dimensions: opts.dimensions,
    }),
  )

  return {
    target,
    // Review metadata intentionally excludes secrets. Keys are confined to the
    // closure and are never included in destination identity or error output.
    endpoint,
    async embed(texts: string[], signal?: AbortSignal, observe?: Observer): Promise<number[][]> {
      signal?.throwIfAborted()
      if (!texts.length) return []
      if (texts.length > 128 || texts.some((text) => typeof text !== "string" || !text.trim())) {
        throw new Error("Embedding input requires 1-128 nonempty texts")
      }
      const body = JSON.stringify({
        model: target.model,
        input: texts,
        dimensions: target.dimensions,
        encoding_format: "float",
      })
      if (Buffer.byteLength(body) > maximum) throw new Error("Embedding request exceeds 16 MiB")
      // Persist admission before opening a socket. Admission is not proof of
      // transmission; interruption may leave this attempt unresolved.
      await observe?.({ state: "attempt", inputs: texts.length, bytes: Buffer.byteLength(body) })
      signal?.throwIfAborted()
      const controller = new AbortController()
      const abort = () => controller.abort(signal?.reason)
      signal?.addEventListener("abort", abort, { once: true })
      const timer = setTimeout(() => controller.abort(new Error("Embedding request timed out")), timeout)
      const pending = Promise.withResolvers<Buffer>()
      // Both HTTP errors and response bodies are untrusted; never forward
      // server text, URL/header details, or raw network errors to request history.
      const request = (url.protocol === "https:" ? https : http)(
        endpoint,
        {
          method: "POST",
          headers: { ...headers, "content-length": String(Buffer.byteLength(body)) },
          agent: false,
          signal: controller.signal,
          ...(url.protocol === "https:" ? { rejectUnauthorized: true } : {}),
        },
        (response) => {
          const fail = (message: string) => {
            pending.reject(new Error(message))
            response.destroy()
            request.destroy()
          }
          const status = response.statusCode ?? 0
          if (status < 200 || status >= 300) {
            fail(
              status >= 300 && status < 400
                ? "Embedding endpoint redirects are not permitted"
                : `Embedding endpoint returned HTTP ${status}`,
            )
            return
          }
          const length = response.headers["content-length"]
          if (length && (!/^\d+$/.test(length) || Number(length) > maximum)) {
            fail("Embedding response exceeds 16 MiB")
            return
          }
          if (response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity") {
            fail("Compressed embedding responses are not supported")
            return
          }
          const chunks: Buffer[] = []
          let size = 0
          response.on("data", (chunk: Buffer) => {
            size += chunk.length
            if (size > maximum) {
              fail("Embedding response exceeds 16 MiB")
              return
            }
            chunks.push(chunk)
          })
          response.on("error", () => pending.reject(new Error("Embedding response was interrupted")))
          response.on("end", () => pending.resolve(Buffer.concat(chunks, size)))
        },
      )
      request.on("error", () => pending.reject(new Error("Embedding request failed")))
      let observed = false
      try {
        request.end(body)
        const bytes = await pending.promise
        controller.signal.throwIfAborted()
        const payload: unknown = (() => {
          try {
            return JSON.parse(bytes.toString("utf8"))
          } catch {
            throw new Error("Invalid embedding response")
          }
        })()
        // A provider may report usage even when its vectors are unusable.
        // Never include raw provider fields or diagnostics in the observation.
        observed = true
        await observe?.(reported(payload))
        controller.signal.throwIfAborted()
        const vectors = (() => {
          try {
            return decode(Response, payload).data
          } catch {
            throw new Error("Invalid embedding response")
          }
        })()
        if (
          vectors.length !== texts.length ||
          new Set(vectors.map((item) => item.index)).size !== texts.length ||
          vectors.some(
            (item) =>
              item.index >= texts.length ||
              item.embedding.length !== target.dimensions ||
              !item.embedding.some((value) => value !== 0),
          )
        ) {
          throw new Error("Embedding response does not match requested inputs or dimensions")
        }
        return [...vectors].sort((a, b) => a.index - b.index).map((item) => [...item.embedding])
      } catch (err) {
        if (!observed) await observe?.({ state: "failed" })
        signal?.throwIfAborted()
        controller.signal.throwIfAborted()
        throw err
      } finally {
        clearTimeout(timer)
        signal?.removeEventListener("abort", abort)
        request.destroy()
      }
    },
  }
}
