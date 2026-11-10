import { generateText, streamText } from "ai"
import { EnhancementError, failure } from "@kilocode/forge/enhancement"
import { tokens } from "@kilocode/forge/util"
import { route } from "./routing"

export function protocol(options?: { fetch?: unknown }) {
  return {
    adapter:
      typeof options?.fetch === "function" && route(options.fetch)?.adapter === "openai-codex-v1"
        ? ("openai-codex-v1" as const)
        : ("standard" as const),
  }
}

export async function complete(
  input: Parameters<typeof generateText>[0],
  opts: ReturnType<typeof protocol> & {
    stream?: boolean
    chars?: number
    update?: (value: { type: "text"; text: string } | { type: "reasoning" }) => void | Promise<void>
  },
) {
  const codex = opts.adapter === "openai-codex-v1"
  if (!codex && !opts.stream) return generateText(input)
  const limit = input.maxOutputTokens
  if (!limit || typeof input.system !== "string")
    throw new Error("Streaming completion requires bounded output and explicit instructions")
  const controller = new AbortController()
  const cutoff = () =>
    new EnhancementError(
      "The model response reached its output limit before completing a usable response. Your request was kept; retry explicitly or choose another model.",
      failure("cutoff"),
    )
  const result = streamText({
    model: input.model,
    ...(input.messages ? { messages: input.messages } : { prompt: input.prompt }),
    system: codex ? undefined : input.system,
    temperature: codex ? undefined : input.temperature,
    maxOutputTokens: codex ? undefined : limit,
    headers: input.headers,
    tools:
      codex && input.tools
        ? Object.fromEntries(Object.entries(input.tools).map(([name, tool]) => [name, { ...tool, strict: false }]))
        : input.tools,
    toolChoice: input.toolChoice,
    activeTools: input.activeTools,
    output: input.output,
    // Codex rejects the API cap. Its local byte allowance remains conservative,
    // distinct from final provider-reported output tokens.
    providerOptions: codex
      ? {
          ...input.providerOptions,
          openai: { ...input.providerOptions?.openai, instructions: input.system, store: false },
        }
      : input.providerOptions,
    maxRetries: codex ? 0 : input.maxRetries,
    abortSignal: AbortSignal.any([controller.signal, ...(input.abortSignal ? [input.abortSignal] : [])]),
    // The full stream below propagates errors to the privacy-safe classifier.
    onError: () => undefined,
  })
  let bytes = 0
  let text = ""
  let updated = 0
  try {
    for await (const part of result.fullStream) {
      input.abortSignal?.throwIfAborted()
      if (part.type === "error") throw part.error
      const delta =
        part.type === "tool-input-delta"
          ? part.delta
          : part.type === "text-delta" || part.type === "reasoning-delta"
            ? part.text
            : ""
      bytes += tokens(delta)
      if (codex && bytes > limit) throw cutoff()
      if (part.type === "reasoning-start") await opts.update?.({ type: "reasoning" })
      if (part.type !== "text-delta") continue
      text += part.text
      if (opts.chars != null && text.length > opts.chars) throw cutoff()
      if (!opts.update || Date.now() - updated < 80) continue
      updated = Date.now()
      await opts.update({ type: "text", text })
    }
    const usage = await result.totalUsage
    if (codex && (usage.outputTokens ?? 0) > limit) throw cutoff()
    return {
      text: await result.text,
      toolCalls: await result.toolCalls,
      totalUsage: usage,
      finishReason: await result.finishReason,
    }
  } finally {
    controller.abort()
  }
}
