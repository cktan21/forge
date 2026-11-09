import { Effect } from "effect"
import type { Collection } from "@kilocode/forge/schema"
import { containsPath } from "@/project/instance-context"
import * as Config from "@/config/config"
import * as Permission from "@/permission"
import * as Session from "@/session/session"
import * as Agent from "@/agent/agent"
import { SessionID } from "@/session/schema"
import { InstanceState } from "@/effect/instance-state"

// Registry approvals are direct user actions. They cannot override a configured Kilo denial.
export function authorize(item: Collection, session: string, providers: readonly string[], endpoint?: string) {
  return Effect.gen(function* () {
    const config = yield* Config.Service
    const ctx = yield* InstanceState.context
    const cfg = yield* config.get()
    const rules = Permission.fromConfig(cfg.permission ?? {})
    if (session) {
      const sessions = yield* Session.Service
      const agents = yield* Agent.Service
      const key = SessionID.make(session)
      const info = yield* sessions.get(key)
      const messages = yield* sessions.messages({ sessionID: key, limit: 20 })
      const user = messages.findLast((item) => item.info.role === "user")?.info
      const agent = yield* agents.get(user?.role === "user" ? user.agent : yield* agents.defaultAgent())
      rules.push(...agent.permission, ...info.permission ?? [])
    }
    const checks: Array<[string, string]> = [["forge_knowledge", item.location || item.id]]
    if (item.kind === "file" || item.kind === "folder") {
      checks.push(["read", item.location])
      if (!containsPath(item.location, ctx)) checks.push(["external_directory", item.location])
    }
    if (item.kind === "url") checks.push(["webfetch", item.location])
    for (const provider of providers) checks.push(["forge_share", provider])
    if (endpoint) checks.push(["forge_embed", endpoint], ["webfetch", endpoint])
    for (const [permission, pattern] of checks) {
      // A later allow must never erase an earlier explicit denial at this boundary.
      if (rules.some((rule) => rule.action === "deny" && Permission.evaluate(permission, pattern, [rule]).action === "deny")) {
        throw new Error(`Kilo permission denies ${permission} for this knowledge source`)
      }
    }
  })
}

export function permit(input: { tool: string; pattern: string; session: string; signal?: AbortSignal }) {
  return Effect.gen(function* () {
    input.signal?.throwIfAborted()
    const config = yield* Config.Service
    const cfg = yield* config.get()
    const agents = yield* Agent.Service
    const sessions = yield* Session.Service
    const key = input.session ? SessionID.make(input.session) : undefined
    const info = key ? yield* sessions.get(key) : undefined
    const messages = key ? yield* sessions.messages({ sessionID: key, limit: 20 }) : []
    const user = messages.findLast((item) => item.info.role === "user")?.info
    const agent = yield* agents.get(user?.role === "user" ? user.agent : yield* agents.defaultAgent())
    if (!agent) throw new Error("An available agent is required for investigation permissions")
    const rules = Permission.merge(agent.permission, Permission.fromConfig(cfg.permission ?? {}), info?.permission ?? [])
    if (rules.some((rule) => rule.action === "deny" && Permission.evaluate(input.tool, input.pattern, [rule]).action === "deny")) {
      throw new Error(`Kilo permission denies ${input.tool} during investigation`)
    }
    if (!key) {
      if (Permission.evaluate(input.tool, input.pattern, rules).action !== "allow") throw new Error("Open a chat to approve this investigation capability")
      return
    }
    const permissions = yield* Permission.Service
    yield* permissions.ask({
      sessionID: key, permission: input.tool, patterns: [input.pattern], always: [],
      metadata: { purpose: "read-only investigation" }, ruleset: rules, hardRuleset: rules,
    }).pipe(Effect.asVoid, Effect.orDie)
  }).pipe(
    Effect.raceFirst(Effect.callback<never>((resume) => {
      const abort = () => resume(Effect.interrupt)
      if (input.signal?.aborted) abort()
      input.signal?.addEventListener("abort", abort, { once: true })
      return Effect.sync(() => input.signal?.removeEventListener("abort", abort))
    })),
  )
}
