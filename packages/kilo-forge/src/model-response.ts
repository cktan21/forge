import type { ModelResponse, ModelUsage } from "./schema"

function object(value: unknown): Record<string, unknown> {
  const valid = (value: unknown): value is Record<string, unknown> =>
    value != null && typeof value === "object" && !Array.isArray(value)
  return valid(value) ? value : {}
}

function usage(text: string): ModelUsage | undefined {
  const parsed = (() => {
    try {
      return object(JSON.parse(text))
    } catch (err) {
      if (err instanceof SyntaxError) return {}
      throw err
    }
  })()
  const raw = parsed.type === "response.completed" ? object(parsed.response) : parsed
  const format =
    raw.object === "response"
      ? "openai-responses"
      : raw.object === "chat.completion" || raw.object === "chat.completion.chunk"
        ? "openai-chat"
        : undefined
  if (!format) return undefined
  const values = object(raw.usage)
  const input = format === "openai-chat" ? values.prompt_tokens : values.input_tokens
  const output = format === "openai-chat" ? values.completion_tokens : values.output_tokens
  const pairs = [
    ["input", input],
    ["output", output],
    ["total", values.total_tokens],
    [
      "cached",
      object(format === "openai-chat" ? values.prompt_tokens_details : values.input_tokens_details).cached_tokens,
    ],
    [
      "reasoning",
      object(format === "openai-chat" ? values.completion_tokens_details : values.output_tokens_details)
        .reasoning_tokens,
    ],
  ] as const
  const count = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0
  const valid = pairs.filter((pair): pair is readonly [(typeof pair)[0], number] => count(pair[1]))
  if (!pairs.some((pair) => pair[1] != null)) return undefined
  const counters = Object.fromEntries(valid)
  const invalid =
    pairs.some((pair) => pair[1] != null && !count(pair[1])) ||
    (counters.cached != null && counters.input != null && counters.cached > counters.input) ||
    (counters.reasoning != null && counters.output != null && counters.reasoning > counters.output) ||
    (counters.total != null &&
      counters.input != null &&
      counters.output != null &&
      counters.total !== counters.input + counters.output)
  return { format, ...counters, ...(invalid ? { invalid: true } : {}) }
}

/** Observe only bytes the caller consumes; never tee, buffer ahead or retain model text. */
export async function monitor(input: Response, save: (value: ModelResponse) => Promise<void>) {
  const type = input.headers.get("content-type")?.split(";").at(0)?.trim().toLowerCase()
  const sse = type === "text/event-stream"
  const json = type === "application/json" || type?.endsWith("+json") === true
  let value: ModelResponse = { state: json || sse ? "pending" : "unsupported", bytes: 0 }
  await save(value)
  if (!input.body) {
    await save({ ...value, state: json || sse ? "completed" : "unsupported" })
    return input
  }
  const decoder = new TextDecoder()
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let settled = false
  let text = ""
  let event = ""
  function parse() {
    if (event.trim() && event.trim() !== "[DONE]") {
      const report = usage(event)
      if (report) {
        const previous = value.usage
        const invalid =
          report.invalid ||
          previous?.invalid ||
          (previous != null &&
            JSON.stringify({ ...previous, invalid: undefined }) !== JSON.stringify({ ...report, invalid: undefined }))
        value = { ...value, usage: { ...report, ...(invalid ? { invalid: true } : {}) } }
      }
    }
    event = ""
  }
  function consume(chunk: string) {
    if (!input.ok || (!json && !sse) || value.state === "limited") return
    text += chunk
    if (!sse) return
    // Keep a trailing CR until the next chunk so split CRLF is one boundary.
    for (let boundary = text.match(/\r\n|\r(?!$)|\n/); boundary; boundary = text.match(/\r\n|\r(?!$)|\n/)) {
      const line = text.slice(0, boundary.index)
      text = text.slice(boundary.index! + boundary[0].length)
      if (line.length > 65536) {
        value = { ...value, state: "limited" }
        event = ""
        text = ""
        return
      }
      if (!line) {
        parse()
        continue
      }
      if (!line.startsWith("data:")) continue
      event += (event ? "\n" : "") + line.slice(5).replace(/^ /, "")
      if (event.length > 65536) {
        value = { ...value, state: "limited" }
        event = ""
        text = ""
        return
      }
    }
    if (text.length > 65536) {
      value = { ...value, state: "limited" }
      text = ""
      event = ""
    }
  }
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        reader ??= input.body!.getReader()
        try {
          const chunk = await reader.read()
          if (settled) return
          if (chunk.done) {
            consume(decoder.decode())
            if (value.state !== "limited") {
              if (sse) {
                consume("\n")
                parse()
              }
              if (json && input.ok) {
                const report = usage(text)
                if (report) value = { ...value, usage: report }
              }
              value = { ...value, state: json || sse ? "completed" : "unsupported" }
            }
            text = ""
            event = ""
            settled = true
            await save(value)
            reader.releaseLock()
            controller.close()
            return
          }
          value = { ...value, bytes: value.bytes + chunk.value.byteLength }
          if (value.bytes > 16 * 1024 * 1024) {
            value = { ...value, state: "limited" }
            text = ""
            event = ""
          }
          consume(decoder.decode(chunk.value, { stream: true }))
          controller.enqueue(chunk.value)
        } catch (err) {
          if (settled) return
          settled = true
          text = ""
          event = ""
          value = { ...value, state: "error" }
          await save(value)
          reader.releaseLock()
          controller.error(err)
        }
      },
      async cancel(reason) {
        settled = true
        text = ""
        event = ""
        value = { ...value, state: "cancelled" }
        try {
          await (reader ? reader.cancel(reason) : input.body!.cancel(reason))
        } finally {
          reader?.releaseLock()
          await save(value)
        }
      },
    },
    { highWaterMark: 0 },
  )
  const response = new Response(body, { status: input.status, statusText: input.statusText, headers: input.headers })
  for (const name of ["url", "redirected", "type"] as const)
    Object.defineProperty(response, name, { value: input[name] })
  return response
}
