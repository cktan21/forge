import { Effect } from "effect"
import { MemoryService } from "@kilocode/kilo-memory/effect/service"
import { MemoryTool } from "@kilocode/kilo-memory/tool"
import { source } from "@kilocode/forge/parse"
import { id } from "@kilocode/forge/util"
import { InstanceState } from "@/effect/instance-state"
import * as Session from "@/session/session"
import { SessionID } from "@/session/schema"
import * as Permission from "@/permission"
import * as Agent from "@/agent/agent"

export function recall(query: string, session: string, signal?: AbortSignal) {
  return Effect.gen(function* () {
    const memory = yield* MemoryService.Service
    const permissions = yield* Permission.Service
    const sessions = yield* Session.Service
    const agents = yield* Agent.Service
    const ctx = yield* InstanceState.context
    const key = SessionID.make(session)
    const info = yield* sessions.get(key)
    const messages = yield* sessions.messages({ sessionID: key, limit: 20 })
    const user = messages.findLast((item) => item.info.role === "user")?.info
    const agent = yield* agents.get(user?.role === "user" ? user.agent : yield* agents.defaultAgent())
    if (!agent) throw new Error("Memory recall requires an available session agent")
    const result = yield* MemoryTool.recall({
      memory, sessionID: session, ctx: { directory: ctx.directory, worktree: ctx.worktree },
      params: { mode: "typed", query, limit: 5 },
      ask: (input) => permissions.ask({
        ...input, sessionID: key,
        ruleset: Permission.merge(agent.permission, info.permission ?? []),
        hardRuleset: agent.permission,
      }).pipe(Effect.asVoid, Effect.orDie),
    })
    if (!result.metadata.count) return []
    return [source(`memory:${id(session, query)}`, result.output, "summary", {
      label: "Permitted Kilo typed memory", method: "kilo-memory-recall", inferred: true,
      detail: { session, query, sources: JSON.stringify(result.metadata.sources), lineage: "Read from Kilo memory; not copied into the persistent Forge knowledge catalog" },
    })]
  }).pipe(
    Effect.raceFirst(Effect.callback<never>((resume) => {
      const abort = () => resume(Effect.interrupt)
      if (signal?.aborted) abort()
      signal?.addEventListener("abort", abort, { once: true })
      return Effect.sync(() => signal?.removeEventListener("abort", abort))
    })),
    Effect.timeout("2 minutes"),
  )
}
