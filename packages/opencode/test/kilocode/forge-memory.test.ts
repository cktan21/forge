import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Database } from "@opencode-ai/core/database/database"
import { MemoryService } from "@kilocode/kilo-memory/effect/service"
import { Session } from "../../src/session/session"
import { Permission } from "../../src/permission"
import { Agent } from "../../src/agent/agent"
import { Config } from "../../src/config/config"
import { InstanceState } from "../../src/effect/instance-state"
import { recall } from "../../src/kilocode/forge/memory"
import { authorize } from "../../src/kilocode/forge/access"
import type { Collection } from "@kilocode/forge/schema"
import { seedProject } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.merge(
  LayerNode.compile(LayerNode.group([Session.node, SessionProjector.node, Permission.node, Agent.node, Database.node, Config.node])),
  MemoryService.layer,
))

it.instance("Forge recalls only enabled, permission-approved typed memory through Kilo", () => Effect.gen(function* () {
  yield* seedProject
  const ctx = yield* InstanceState.context
  const sessions = yield* Session.Service
  const memory = yield* MemoryService.Service
  const session = yield* sessions.create({ title: "Forge memory test" })
  const root = yield* memory.prepare({ ctx: { directory: ctx.directory, worktree: ctx.worktree } })
  expect(yield* recall("epoch leases", session.id)).toEqual([])
  expect((yield* memory.state({ root })).enabled).toBe(false)
  yield* memory.enable({ root })
  yield* memory.remember({ root, sessionID: session.id, key: "queue-ownership", text: "Use epoch leases for queue ownership." })
  yield* memory.recordSession({ root, sessionID: "other-session", summary: "epoch leases foreign session canary" })
  yield* sessions.setPermission({ sessionID: session.id, permission: [{ permission: "kilo_memory_recall", pattern: "*", action: "allow" }] })
  const items = yield* recall("epoch leases", session.id)
  expect(items).toHaveLength(1)
  expect(items.at(0)?.text).toContain("epoch leases")
  expect(items.at(0)?.text).not.toContain("foreign session canary")
  expect(items.at(0)?.detail.session).toBe(session.id)
  expect((yield* memory.state({ root })).stats.lastRecallSessionID).toBe(session.id)
  yield* sessions.setPermission({ sessionID: session.id, permission: [{ permission: "kilo_memory_recall", pattern: "*", action: "deny" }] })
  const denied = yield* recall("epoch leases", session.id).pipe(Effect.exit)
  expect(denied._tag).toBe("Failure")
  yield* memory.disable({ root })
  expect(yield* recall("epoch leases", session.id)).toEqual([])
  yield* memory.purge({ root })
}))

it.instance("direct registry approval cannot override Kilo read or provider denials", () => Effect.gen(function* () {
  yield* seedProject
  const ctx = yield* InstanceState.context
  const sessions = yield* Session.Service
  const session = yield* sessions.create({ title: "Forge collection permissions" })
  const item: Collection = {
    id: "policy", label: "Policy", kind: "file", location: `${ctx.directory}/policy.md`,
    session: "", origin: "interface", include: [], exclude: [], watch: false,
    approved: false, providers: [], state: "registered", observed: 0, generation: "", files: 0, chunks: 0, warnings: [],
  }
  yield* authorize(item, session.id, [])
  for (const permission of ["read", "forge_share"]) {
    yield* sessions.setPermission({ sessionID: session.id, permission: [{ permission, pattern: "*", action: "deny" }] })
    const result = yield* authorize(item, session.id, ["provider"]).pipe(Effect.exit)
    expect(result._tag).toBe("Failure")
  }
}))
