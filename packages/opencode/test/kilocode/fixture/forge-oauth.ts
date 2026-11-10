import { $ } from "bun"
import { createKiloClient } from "@kilocode/sdk"
import type { Auth } from "@kilocode/sdk/v2"
import { CodexAuthPlugin } from "@/plugin/openai/codex"
import type { Fetch } from "@/kilocode/forge/routing"

function callable(value: unknown): value is Fetch {
  return typeof value === "function"
}

export async function oauth(endpoint: string, get = async (): Promise<Auth> => ({
  type: "oauth", access: "fixture-access", refresh: "fixture-refresh", expires: Date.now() + 60_000,
})) {
  const url = new URL(endpoint)
  const hooks = await CodexAuthPlugin({
    client: createKiloClient({ baseUrl: url.origin }),
    directory: "/forge-oauth", worktree: "/forge-oauth",
    project: { id: "forge-oauth", worktree: "/forge-oauth", time: { created: 1 } },
    experimental_workspace: { register() { throw new Error("Unexpected workspace registration") } },
    serverUrl: url,
    $,
  }, { codexApiEndpoint: endpoint })
  const options: Record<string, unknown> = await hooks.auth!.loader!(get, {
    id: "openai", name: "OpenAI", source: "custom", env: [], options: {}, models: {},
  })
  if (!callable(options.fetch)) throw new Error("Expected the real OAuth fetch adapter")
  return { options, fetch: Object.assign(options.fetch, { preconnect: fetch.preconnect }) }
}
