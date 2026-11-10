import type { Model } from "@kilocode/sdk/v2"

export const tools = ["forge_search_code", "forge_search_docs", "forge_get_symbol", "forge_relationships"] as const
export const arms = ["normal", "forge"] as const
export const plugins = ["@kilocode/kilo-indexing", "@kilocode/plugin-atomic-chat"]

export function order(index: number, trial: number) {
  return (index + trial - 1) % 2 === 0 ? arms : [...arms].reverse()
}

/** Fail closed on paid, unknown-price, or automatically routed model configurations. */
export function free(model: Pick<Model, "id" | "isFree" | "autoRouting" | "cost"> | undefined) {
  if (!model || model.isFree !== true || model.autoRouting || /(?:^|\/)(?:auto|kilo-auto|openrouter)\//.test(model.id))
    throw new Error("Tools-only evaluation requires an explicitly free, non-routing model")
  zero(model.cost)
}

export function subscription(model: Pick<Model, "id" | "autoRouting" | "cost"> | undefined, provider: string) {
  if (!model || provider !== "openai" || !/^gpt-\d/.test(model.id) || model.autoRouting)
    throw new Error("Subscription evaluation requires a named GPT model on the direct OpenAI provider")
  zero(model.cost)
}

function zero(cost: Model["cost"]) {
  const rates = [cost, ...(cost.tiers ?? []), ...(cost.experimentalOver200K ? [cost.experimentalOver200K] : [])]
  if (rates.some((rate) => [rate.input, rate.output, rate.cache?.read, rate.cache?.write].some((value) => value !== 0)))
    throw new Error("Tools-only evaluation refuses paid or unknown model pricing")
}

if (import.meta.main) {
  process.env.FORGE_EVAL_MODEL ??= "kilo/cohere/north-mini-code:free"
  const { evaluate } = await import("./evaluate")
  console.log(`Completed: ${await evaluate({ tools: true })}`)
}
