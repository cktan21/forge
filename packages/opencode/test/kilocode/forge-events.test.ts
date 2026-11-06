import { afterEach, expect } from "bun:test"
import { Effect, Queue, Schema, Stream } from "effect"
import * as Sse from "effect/unstable/encoding/Sse"
import { Changed } from "@/kilocode/forge/events"
import { GlobalBus } from "@/bus/global"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "../server/httpapi-layer"
import { ImportHistory, Policy, View, type Registry } from "@kilocode/forge"
import { start } from "@/kilocode/forge/trace"
import { binding } from "@kilocode/forge/binding"

type Frame = { type?: string; properties?: { topic?: string; session?: string; revision?: string } }

const take = (reader: Queue.Dequeue<Frame>, match: (frame: Frame) => boolean) => Effect.gen(function* () {
  while (true) {
    const frame = yield* Queue.take(reader)
    if (match(frame)) return frame
  }
}).pipe(Effect.timeoutOrElse({ duration: "5 seconds", orElse: () => Effect.fail(new Error("Missing Forge stream event")) }))

afterEach(async () => { await disposeAllInstances(); await resetDatabase() })
const it = testEffect(httpApiLayer)

it.instance("request identity lookup reaches older captures and enforces exact HTTP session and directory scope", () => Effect.gen(function* () {
  const { directory } = yield* TestInstance
  const chat = (yield* (yield* requestInDirectory("/session", directory, { method: "POST" })).json) as { id: string }
  const other = (yield* (yield* requestInDirectory("/session", directory, { method: "POST" })).json) as { id: string }
  expect((yield* requestInDirectory("/forge/status", directory)).status).toBe(200)
  const input = { root: directory, session: chat.id, purpose: "enhance", model: "local", system: [], messages: [] }
  const parent = yield* Effect.promise(() => start(input))
  expect(parent).toBeDefined()
  for (let index = 0; index < 105; index++) yield* Effect.promise(() => start({ ...input, purpose: "coding" }))
  const list = yield* (yield* requestInDirectory(`/forge/requests?session=${chat.id}`, directory)).json
  expect(JSON.stringify(list)).not.toContain(parent!.id)
  const route = `/forge/requests/${parent!.id}`
  const found = yield* requestInDirectory(`${route}?session=${chat.id}`, directory)
  expect(found.status).toBe(200)
  expect((yield* found.json) as object).toMatchObject({ request: { id: parent!.id, session: chat.id, purpose: "enhance" } })
  for (const query of ["", `?session=${other.id}`]) {
    const response = yield* requestInDirectory(`${route}${query}`, directory)
    expect(response.status).toBe(200)
    expect(yield* response.json).toEqual({ request: null })
  }
  const shared = yield* Effect.promise(() => start({ ...input, session: "" }))
  const sharedRoute = `/forge/requests/${shared!.id}`
  expect((yield* (yield* requestInDirectory(`${sharedRoute}?session=${chat.id}`, directory)).json)).toEqual({ request: null })
  expect((yield* (yield* requestInDirectory(sharedRoute, directory)).json) as object).toMatchObject({ request: { session: "" } })
  expect(yield* (yield* requestInDirectory(`/forge/requests/missing?session=${chat.id}`, directory)).json).toEqual({ request: null })
  expect((yield* requestInDirectory(`${route}?session=ses_missing`, directory)).status).not.toBe(200)
  const foreign = yield* tmpdirScoped({ git: true })
  expect((yield* requestInDirectory(`${route}?session=${chat.id}`, foreign)).status).not.toBe(200)
  expect(yield* (yield* requestInDirectory(sharedRoute, foreign)).json).toEqual({ request: null })
}), { config: { formatter: false, lsp: false } })

it.instance("source pagination preserves HTTP scope and resets stale generations", () => Effect.gen(function* () {
  const { directory } = yield* TestInstance
  const session = yield* requestInDirectory("/session", directory, { method: "POST" })
  const chat = (yield* session.json) as { id: string }
  for (const scope of ["", chat.id]) {
    for (const label of ["First", "Second"]) {
      const response = yield* requestInDirectory("/forge/knowledge", directory, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "text", label: `${scope ? "private" : "shared"} ${label}`, location: "", content: `pagination ${scope} ${label}`, session: scope }),
      })
      expect(response.status).toBe(200)
      const item = (yield* response.json) as { id: string }
      for (const action of ["approve", "index"]) {
        const result = yield* requestInDirectory(`/forge/knowledge/${item.id}`, directory, {
          method: "PUT", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, session: scope, providers: [] }),
        })
        expect(result.status).toBe(200)
      }
    }
  }
  const registry = (yield* (yield* requestInDirectory("/forge/knowledge?limit=1", directory)).json) as Registry
  expect(registry.page).toEqual({ offset: 0, limit: 1, total: 2, next: 1 })
  const page = (yield* (yield* requestInDirectory(`/forge/knowledge?limit=1&offset=1&generation=${registry.generation}`, directory)).json) as Registry
  expect(page.page.next).toBeUndefined()
  expect(page.collections.at(0)?.id).not.toBe(registry.collections.at(0)?.id)
  expect(page.collections.every((item) => !item.session)).toBe(true)
  const personal = (yield* (yield* requestInDirectory(`/forge/knowledge?session=${chat.id}&query=private&limit=1`, directory)).json) as Registry
  expect(personal.page.total).toBe(2)
  expect(personal.collections.at(0)?.session).toBe(chat.id)
  const hidden = (yield* (yield* requestInDirectory("/forge/knowledge?query=private", directory)).json) as Registry
  expect(hidden.page.total).toBe(0)
  expect(hidden.collections).toEqual([])
  expect((yield* requestInDirectory("/forge/knowledge?offset=-1", directory)).status).not.toBe(200)
  expect((yield* requestInDirectory("/forge/knowledge?session=ses_missing", directory)).status).not.toBe(200)
  const full = (yield* (yield* requestInDirectory("/forge/view?query=pagination", directory)).json) as View
  expect(full.sources.length).toBeGreaterThan(1)
  expect(full.sources.every((item) => !item.detail.session)).toBe(true)
  const first = (yield* (yield* requestInDirectory("/forge/view?query=pagination&limit=1", directory)).json) as View
  expect(first.page).toEqual({ offset: 0, limit: 1, next: 1 })
  const next = (yield* (yield* requestInDirectory(`/forge/view?query=pagination&limit=1&offset=1&generation=${first.generation}`, directory)).json) as View
  expect(next.sources.at(0)?.id).toBe(full.sources.at(1)?.id)
  const reset = (yield* (yield* requestInDirectory("/forge/view?query=pagination&offset=1&generation=stale", directory)).json) as View
  expect(reset.page.offset).toBe(0)
  const scoped = (yield* (yield* requestInDirectory(`/forge/view?session=${chat.id}&query=pagination`, directory)).json) as View
  expect(scoped.sources.length).toBeGreaterThan(full.sources.length)
  const section = scoped.sources.find((source) => source.detail.session === chat.id && source.method === "collection-section")!
  const document = section.evidence.at(0)!
  const passages = yield* requestInDirectory(`/forge/view?document=${document}&session=${chat.id}&limit=1`, directory)
  expect(passages.status).toBe(200)
  const filtered = Schema.decodeUnknownSync(View)(yield* passages.json)
  expect(filtered.sources.map((source) => source.id)).toEqual([section.id])
  expect((yield* requestInDirectory(`/forge/view?document=${document}`, directory)).status).not.toBe(200)
  expect((yield* requestInDirectory(`/forge/view?document=${document}&session=ses_missing`, directory)).status).not.toBe(200)
  expect((yield* requestInDirectory(`/forge/view?document=missing&session=${chat.id}`, directory)).status).not.toBe(200)
  const policy = Schema.decodeUnknownSync(Policy)(yield* (yield* requestInDirectory(`/forge/policy?session=${chat.id}`, directory)).json)
  const pinned = yield* requestInDirectory("/forge/policy", directory, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...policy, pin: [document] }),
  })
  expect(pinned.status).not.toBe(200)
  expect(yield* pinned.text).toContain("Choose an original section or page")
  expect(Schema.decodeUnknownSync(Policy)(yield* (yield* requestInDirectory(`/forge/policy?session=${chat.id}`, directory)).json)).toEqual(policy)
  const stale = yield* requestInDirectory("/forge/policy", directory, {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...policy, pin: [section.id], versions: { [section.id]: "old-inspection" } }),
  })
  expect(stale.status).not.toBe(200)
  expect(yield* stale.text).toContain("Source changed since inspection")
  expect(Schema.decodeUnknownSync(Policy)(yield* (yield* requestInDirectory(`/forge/policy?session=${chat.id}`, directory)).json)).toEqual(policy)
  const saved = yield* requestInDirectory("/forge/policy", directory, {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...policy, pin: [section.id], versions: { [section.id]: binding(section) } }),
  })
  expect(saved.status).toBe(200)
  expect(Schema.decodeUnknownSync(Policy)(yield* saved.json).versions?.[section.id]).toBe(binding(section))
  expect((yield* requestInDirectory("/forge/view?offset=-1", directory)).status).not.toBe(200)
  expect((yield* requestInDirectory("/forge/view?session=ses_missing&offset=1", directory)).status).not.toBe(200)
  const item = personal.collections.at(0)!
  const route = `/forge/knowledge/${item.id}/imports`
  const imports = yield* requestInDirectory(`${route}?session=${chat.id}&limit=1`, directory)
  expect(imports.status).toBe(200)
  const history = Schema.decodeUnknownSync(ImportHistory)(yield* imports.json)
  expect(history.runs.length).toBeGreaterThan(0)
  expect(history.runs.every((run) => run.session === chat.id && run.collection === item.id)).toBe(true)
  expect(history.documents.length).toBeLessThanOrEqual(1)
  expect(JSON.stringify(history)).not.toContain(`pagination ${chat.id}`)
  expect((yield* requestInDirectory(route, directory)).status).not.toBe(200)
  expect((yield* requestInDirectory(`${route}?session=ses_missing`, directory)).status).not.toBe(200)
  expect((yield* requestInDirectory(`${route}?session=${chat.id}&offset=-1`, directory)).status).not.toBe(200)
  expect((yield* requestInDirectory(`${route}?session=${chat.id}&run=missing`, directory)).status).not.toBe(200)
  const foreign = yield* tmpdirScoped({ git: true })
  expect((yield* requestInDirectory(`${route}?session=${chat.id}`, foreign)).status).not.toBe(200)
}), { config: { formatter: false, lsp: false } })

it.instance("preview endpoint reads permitted samples without registration and enforces child denials", () => Effect.gen(function* () {
  const { directory } = yield* TestInstance
  yield* Effect.promise(() => Bun.write(`${directory}/allowed.md`, "# Guide\nPreview reference"))
  yield* Effect.promise(() => Bun.write(`${directory}/denied.md`, "Hidden preview canary"))
  const response = yield* requestInDirectory("/forge/knowledge/preview", directory, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "folder", label: "Folder preview", location: directory }),
  })
  expect(response.status).toBe(200)
  const preview = yield* response.json
  expect(JSON.stringify(preview)).toContain("Preview reference")
  expect(JSON.stringify(preview)).not.toContain("Hidden preview canary")
  expect(JSON.stringify(preview)).not.toContain("denied.md")
  const registry = yield* requestInDirectory("/forge/knowledge", directory)
  expect((yield* registry.json) as object).toMatchObject({ collections: [] })
  const denied = yield* requestInDirectory("/forge/knowledge/preview", directory, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "file", label: "Denied", location: `${directory}/denied.md` }),
  })
  expect(denied.status).not.toBe(200)
  expect(JSON.stringify(yield* denied.json)).not.toContain("Hidden preview canary")
  const session = yield* requestInDirectory("/forge/knowledge/preview", directory, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "text", label: "Unknown session", location: "", content: "text", session: "ses_missing" }),
  })
  expect(session.status).not.toBe(200)
}), { config: { formatter: false, lsp: false, permission: { read: { "*": "allow", "*denied.md": "deny" } } } })

it.instance("real Forge mutations publish content-free notices on the existing scoped stream", () => Effect.gen(function* () {
  const { directory } = yield* TestInstance
  const response = yield* requestInDirectory("/event", directory)
  expect(response.status).toBe(200)
  const reader = yield* Queue.unbounded<Frame>()
  yield* response.stream.pipe(
    Stream.decodeText(),
    Stream.pipeThroughChannel(Sse.decode()),
    Stream.runForEach((event) => Effect.sync(() => Queue.offerUnsafe(reader, JSON.parse(event.data) as Frame))),
    Effect.forkScoped,
  )
  yield* take(reader, (frame) => frame.type === "server.connected")
  const session = yield* requestInDirectory("/session", directory, { method: "POST" })
  const chat = (yield* session.json) as { id: string }

  GlobalBus.emit("event", { directory: `${directory}-foreign`, payload: { type: Changed.type, properties: { topic: "knowledge", session: "", revision: "foreign-directory" } } })
  GlobalBus.emit("event", { directory, workspace: "wrk_foreign", payload: { type: Changed.type, properties: { topic: "knowledge", session: "", revision: "foreign-workspace" } } })
  const registered = yield* requestInDirectory("/forge/knowledge", directory, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "text", label: "Private event canary", location: "", content: "Private event document passage", session: chat.id }),
  })
  expect(registered.status).toBe(200)
  const item = (yield* registered.json) as { id: string }
  const first = yield* take(reader, (frame) => frame.type === Changed.type)
  expect(first.properties?.session).toBe(chat.id)
  expect(first.properties?.topic).toBe("knowledge")
  expect(Object.keys(first.properties ?? {}).sort()).toEqual(["revision", "session", "topic"])
  expect(JSON.stringify(first)).not.toContain("canary")
  expect(JSON.stringify(first)).not.toContain(item.id)
  expect(first.properties?.revision).not.toMatch(/^foreign-/)
  const visible = yield* requestInDirectory("/forge/knowledge", directory)
  expect(JSON.stringify(yield* visible.json)).not.toContain("Private event canary")

  const approved = yield* requestInDirectory(`/forge/knowledge/${item.id}`, directory, {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "approve", session: chat.id, providers: [] }),
  })
  expect(approved.status).toBe(200)
  const next = yield* take(reader, (frame) => frame.type === Changed.type)
  expect(next.properties?.revision).not.toBe(first.properties?.revision)

  const indexing = yield* requestInDirectory("/forge/index", directory, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
  expect(indexing.status).toBe(200)
  const job = yield* take(reader, (frame) => frame.type === Changed.type && frame.properties?.topic === "job")
  expect(job.properties?.session).toBe("")
  while (true) {
    const response = yield* requestInDirectory("/forge/status", directory)
    const status = (yield* response.json) as { job: { state: string } }
    if (status.job.state !== "running") { expect(status.job.state).toBe("completed"); break }
    yield* take(reader, (frame) => frame.type === Changed.type && frame.properties?.topic === "job")
  }
}), { config: { formatter: false, lsp: false } })
