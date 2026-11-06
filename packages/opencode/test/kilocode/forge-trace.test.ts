import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { store } from "@kilocode/forge/store"
import { source } from "@kilocode/forge/parse"
import { register, start, compact, compactor } from "../../src/kilocode/forge/trace"
import { knowledge } from "@kilocode/forge/knowledge"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

test("registered evidence cannot lose its send guard when capture storage fails", async () => {
  const db = new Database(":memory:")
  const storage = store({
    all: async (query) => db.query<Record<string, unknown>, (string | number | null)[]>(query.text).all(...query.values ?? []),
    batch: async (queries) => { db.transaction(() => { for (const query of queries) db.query(query.text).run(...query.values ?? []) })() },
  })
  const root = "/forge-capture-failure"
  const library = knowledge(root, storage)
  const unregister = register(root, storage)
  try {
    const collection = await library.register({ kind: "text", label: "Private", location: "", content: "Registered document must retain send protection." })
    await library.approve(collection.id, "", ["approved"])
    await library.index(collection.id)
    const item = (await storage.knowledge(root)).find((item) => item.method === "collection-section")!
    db.exec("CREATE TRIGGER fail_capture BEFORE INSERT ON forge_records WHEN NEW.kind = 'request' BEGIN SELECT RAISE(FAIL, 'Capture unavailable'); END")
    await expect(start({ root, model: "approved/model", purpose: "coding", system: [], messages: [`[${item.id}]\n${item.text}`] })).rejects.toThrow("required knowledge transport guard")
    expect(await start({ root, model: "approved/model", purpose: "coding", system: [], messages: ["Ordinary request without registered evidence"] })).toBeUndefined()
    expect(await storage.manifests(root)).toEqual([])
    db.exec("DROP TRIGGER fail_capture")
    expect(await start({ root, model: "approved/model", purpose: "coding", system: [], messages: [`[${item.id}]\n${item.text}`] })).toBeDefined()
  } finally { unregister(); await library.dispose(); db.close() }
})

test.each(["", "one", "two"])("send applies persisted source exclusions from scope '%s'", async (scope) => {
  const db = new Database(":memory:")
  const storage = store({
    all: async (query) => db.query<Record<string, unknown>, (string | number | null)[]>(query.text).all(...query.values ?? []),
    batch: async (queries) => { db.transaction(() => { for (const query of queries) db.query(query.text).run(...query.values ?? []) })() },
  })
  const root = `/forge-exclusion-${scope}`
  let received = 0
  const server = Bun.serve({ port: 0, fetch: () => { received++; return Response.json({ ok: true }) } })
  const destination = async () => ({ fingerprint: "exclusion-fixture", origins: [server.url.origin] })
  const library = knowledge(root, storage, { destination })
  const unregister = register(root, storage, undefined, destination)
  try {
    const collection = await library.register({ kind: "text", label: "Policy", location: "", content: "Private policy documents remain subject to exclusion.", session: "one" })
    await library.approve(collection.id, "one", ["approved"], { approved: "exclusion-fixture" })
    await library.index(collection.id, "one")
    const item = (await storage.knowledge(root, "one")).find((item) => item.method === "collection-section")!
    const input = { root, session: "one", model: "approved/model", purpose: "coding", system: [], messages: [`[${item.id}]\n${item.text}`] }
    const trace = (await start(input))!
    await storage.policySave(root, { session: scope, version: "excluded", pin: [], exclude: [item.id] })
    if (scope === "two") {
      await trace.fetch(fetch)(server.url, { method: "POST", body: JSON.stringify(input.messages) })
      expect(await start(input)).toBeDefined()
      expect(received).toBe(1)
      return
    }
    await expect(start(input)).rejects.toThrow("excluded")
    await expect(trace.fetch(fetch)(server.url, { method: "POST", body: JSON.stringify(input.messages) })).rejects.toThrow("excluded")
    expect(received).toBe(0)
  } finally { unregister(); await library.dispose(); await server.stop(true); db.close() }
})

test.each(["evidence", "ordinary"] as const)("capture handles concurrent revocation for an %s request", async (mode) => {
  const db = new Database(":memory:")
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let held = false
  const storage = store({
    all: async (query) => db.query<Record<string, unknown>, (string | number | null)[]>(query.text).all(...query.values ?? []),
    batch: async (queries) => {
      if (held && queries.some((query) => query.values?.at(1) === "request")) { entered.resolve(); await release.promise }
      db.transaction(() => { for (const query of queries) db.query(query.text).run(...query.values ?? []) })()
    },
  })
  const root = "/forge-capture-revoke"
  const library = knowledge(root, storage)
  const unregister = register(root, storage)
  try {
    const collection = await library.register({ kind: "text", label: "Private", location: "", content: "Private queue leases require active sharing approval." })
    await library.approve(collection.id, "", ["approved"])
    await library.index(collection.id)
    const item = (await storage.knowledge(root)).find((item) => item.method === "collection-section")!
    held = true
    const pending = start({ root, model: "approved/model", purpose: "coding", system: [], messages: mode === "evidence" ? [`[${item.id}]\n${item.text}`] : ["Ordinary request with no Forge evidence"] })
      .then((handle) => ({ handle }), (error: unknown) => ({ error }))
    await entered.promise
    await library.stop(collection.id)
    release.resolve()
    const result = await pending
    if (mode === "ordinary") {
      expect("handle" in result && result.handle != null).toBe(true)
      return
    }
    expect("error" in result && String(result.error)).toContain("changed during authorization")
  } finally { release.resolve(); unregister(); await library.dispose(); db.close() }
})

test.each(["pause", "revoke", "reapprove", "exclude", "routing", "unrelated"] as const)("send authorization observes concurrent %s changes", async (action) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "forge-send-race-")))
  const db = new Database(":memory:")
  const storage = store({
    all: async (query) => db.query<Record<string, unknown>, (string | number | null)[]>(query.text).all(...query.values ?? []),
    batch: async (queries) => { db.transaction(() => { for (const query of queries) db.query(query.text).run(...query.values ?? []) })() },
  })
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let armed = false
  const access = async (item: { kind: string }) => {
    if (armed && item.kind === "file") { entered.resolve(); await release.promise }
  }
  const route = { fingerprint: "approved-route", origins: ["https://approved.example"] }
  const destination = async () => ({ ...route })
  const library = knowledge(root, storage, { authorize: access, destination })
  const unregister = register(root, storage, access, destination)
  let received = 0
  const server = Bun.serve({ port: 0, fetch: () => { received++; return Response.json({ ok: true }) } })
  route.origins = [server.url.origin]
  try {
    await Bun.write(path.join(root, "policy.md"), "Private document policy requires reviewed queue leases.")
    const collection = await library.register({ kind: "folder", label: "Docs", location: root, session: "one" })
    await library.approve(collection.id, "one", ["approved"], { approved: route.fingerprint })
    await library.index(collection.id, "one")
    const item = (await storage.knowledge(root, "one")).find((item) => item.method === "collection-section")!
    const input = { root, session: "one", model: "approved/model", purpose: "coding", system: [], messages: [`[${item.id}]\n${item.text}`] }
    const trace = (await start(input))!
    armed = true
    const sending = trace.fetch(fetch)(server.url, { method: "POST", body: JSON.stringify(input.messages) })
      .then((response) => ({ response }), (error: unknown) => ({ error }))
    await entered.promise
    if (action === "pause") await library.stop(collection.id, "one")
    if (action === "revoke") await library.approve(collection.id, "one")
    if (action === "reapprove") {
      await library.approve(collection.id, "one", ["approved"], { approved: route.fingerprint })
      armed = false
      await library.index(collection.id, "one")
    }
    if (action === "exclude") await storage.policySave(root, { session: "one", version: "excluded", pin: [], exclude: [item.id] })
    if (action === "routing") route.fingerprint = "changed-during-permission"
    if (action === "unrelated") await library.register({ kind: "text", label: "Other session", location: "", content: "Unrelated private document", session: "two" })
    release.resolve()
    const result = await sending
    if (action === "unrelated") {
      expect("response" in result && result.response.ok).toBe(true)
      expect(received).toBe(1)
      return
    }
    expect("error" in result && String(result.error)).toMatch(/changed|approved|excluded/)
    expect(received).toBe(0)
  } finally { release.resolve(); unregister(); await library.dispose(); await server.stop(true); db.close(); await rm(root, { recursive: true, force: true }) }
})

test("purge during HTTP response prevents late capture and compaction publication", async () => {
  const db = new Database(":memory:")
  const storage = store({
    all: async (query) => db.query<Record<string, unknown>, (string | number | null)[]>(query.text).all(...query.values ?? []),
    batch: async (queries) => { db.transaction(() => { for (const query of queries) db.query(query.text).run(...query.values ?? []) })() },
  })
  const root = "/forge-inflight-purge"
  const library = knowledge(root, storage)
  const unregister = register(root, storage)
  const received = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let calls = 0
  const server = Bun.serve({ port: 0, fetch: async (request) => {
    await request.text()
    calls++
    received.resolve()
    await release.promise
    return Response.json({ ok: true })
  } })
  try {
    const item = await library.register({ kind: "text", label: "Purge", location: "", content: "purged response canary" })
    const messages = [{ role: "user", content: "Copied passage without source identifiers: purged response canary" }]
    const handle = (await start({ root, model: "fixture", purpose: "coding", system: [], messages }))!
    const summary = await compactor(root, "chat")
    const pending = handle.fetch(fetch)(server.url, { method: "POST", body: JSON.stringify(messages) })
    await received.promise
    await library.purge(item.id)
    release.resolve()
    expect((await pending).ok).toBe(true)
    await expect(handle.finish({ input: 12, output: 4 })).rejects.toThrow("purged")
    await summary("Compacted purged response canary")
    expect(await storage.manifests(root)).toEqual([])
    expect(await storage.externals(root)).toEqual([])
    await expect(handle.fetch(fetch)(server.url, { method: "POST", body: JSON.stringify(messages) })).rejects.toThrow("purged")
    expect(calls).toBe(1)
    const fresh = await start({ root, model: "fixture", purpose: "coding", system: [], messages: ["A new request"] })
    await fresh!.finish({})
    expect((await storage.manifests(root)).map((item) => item.id)).toEqual([fresh!.id])
  } finally { release.resolve(); unregister(); await library.dispose(); await server.stop(true); db.close() }
})

test("revoking a folder child's read permission blocks an already assembled request", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "forge-child-permission-")))
  const db = new Database(":memory:")
  const storage = store({
    all: async (query) => db.query<Record<string, unknown>, (string | number | null)[]>(query.text).all(...query.values ?? []),
    batch: async (queries) => { db.transaction(() => { for (const query of queries) db.query(query.text).run(...query.values ?? []) })() },
  })
  let denied = false
  const access = async (item: { location: string }) => { if (denied && item.location.endsWith("private.md")) throw new Error("Child denied") }
  let received = 0
  const server = Bun.serve({ port: 0, fetch: () => { received++; return Response.json({ ok: true }) } })
  const destination = async () => ({ fingerprint: "permission-fixture", origins: [server.url.origin] })
  const library = knowledge(root, storage, { authorize: access, destination })
  const unregister = register(root, storage, access, destination)
  try {
    await Bun.write(path.join(root, "private.md"), "Private document is subject to per-file permissions.")
    const collection = await library.register({ kind: "folder", label: "Docs", location: root })
    await library.approve(collection.id, "", ["approved"], { approved: "permission-fixture" })
    await library.index(collection.id)
    const item = (await storage.knowledge(root, "", "approved")).find((item) => item.method === "collection-section")!
    const input = { root, model: "approved/model", purpose: "coding", system: [], messages: [`[${item.id}]\n${item.text}`] }
    const handle = await start(input)
    expect(handle).toBeDefined()
    denied = true
    await expect(handle!.fetch(fetch)(server.url, { method: "POST", body: JSON.stringify(input.messages) })).rejects.toThrow("not approved")
    expect(received).toBe(0)
  } finally { unregister(); library.dispose(); await server.stop(true); db.close(); await rm(root, { recursive: true, force: true }) }
})

test("registered evidence is checked before capture and every transport attempt", async () => {
  const db = new Database(":memory:")
  const storage = store({
    all: async (query) => db.query<Record<string, unknown>, (string | number | null)[]>(query.text).all(...query.values ?? []),
    batch: async (queries) => { db.transaction(() => { for (const query of queries) db.query(query.text).run(...query.values ?? []) })() },
  })
  const root = "/forge-sharing-fixture"
  const route = { fingerprint: "first-endpoint", origins: ["https://first.example"] }
  const destination = async () => ({ ...route })
  const library = knowledge(root, storage, { destination })
  const unregister = register(root, storage, undefined, destination)
  const received: string[] = []
  const server = Bun.serve({ port: 0, fetch: async (request) => { received.push(await request.text()); return Response.json({ ok: true }) } })
  route.origins = [server.url.origin]
  try {
    const collection = await library.register({ kind: "text", label: "Private", location: "", content: "Private queue ownership policy requires epoch leases.", session: "one" })
    await library.approve(collection.id, "one", ["approved"], { approved: route.fingerprint })
    await library.index(collection.id, "one")
    const item = (await storage.knowledge(root, "one")).find((item) => item.text)!
    const input = { root, session: "one", purpose: "coding", model: "approved/model", system: [], messages: [{ role: "user", content: `[${item.id}]\n${item.text}` }] }
    await expect(start({ ...input, model: "other/model" })).rejects.toThrow("not approved")
    await expect(start({ ...input, session: "two" })).rejects.toThrow("not available")
    await expect(start({ ...input, messages: `[${item.id}]\nOlder document version` })).rejects.toThrow("stale")
    const trace = await start(input)
    expect(trace).toBeDefined()
    await trace!.fetch(fetch)(server.url, { method: "POST", body: JSON.stringify(input.messages) })
    expect(received).toHaveLength(1)
    route.fingerprint = "second-endpoint"
    await expect(trace!.fetch(fetch)(server.url, { method: "POST", body: JSON.stringify(input.messages) })).rejects.toThrow("routing changed")
    await expect(start(input)).rejects.toThrow("not approved")
    await library.approve(collection.id, "one", ["approved"], { approved: route.fingerprint })
    await library.index(collection.id, "one")
    await expect(trace!.fetch(fetch)(server.url, { method: "POST", body: JSON.stringify(input.messages) })).rejects.toThrow("routing changed")
    expect(received).toHaveLength(1)
    route.fingerprint = "first-endpoint"
    await library.approve(collection.id, "one", ["approved"], { approved: route.fingerprint })
    await library.index(collection.id, "one")
    await library.stop(collection.id, "one")
    await expect(trace!.fetch(fetch)(server.url, { method: "POST", body: JSON.stringify(input.messages) })).rejects.toThrow("not approved")
    expect(received).toHaveLength(1)
    await library.purge(collection.id, "one")
    await expect(start(input)).rejects.toThrow("removed or replaced")
    expect(await storage.manifests(root)).toEqual([])
  } finally {
    unregister()
    library.dispose()
    await server.stop(true)
    db.close()
  }
})

test("observes actual HTTP payloads, preserves historical snapshots, and records summary lineage", async () => {
  const db = new Database(":memory:")
  const storage = store({
    all: async (query) => db.query<Record<string, unknown>, (string | number | null)[]>(query.text).all(...query.values ?? []),
    batch: async (queries) => { db.transaction(() => { for (const query of queries) db.query(query.text).run(...query.values ?? []) })() },
  })
  const root = "/forge-trace-fixture"
  const code = source("queue.ts", "export function assignPatient() { return 'waiting' }", "code")
  await storage.replace({ root, revision: "fixture", generation: "first", sources: [code], relations: [], files: 1, observed: 0, warnings: [], partial: false })
  const unregister = register(root, storage)
  const received: unknown[] = []
  const server = Bun.serve({ port: 0, fetch: async (request) => { received.push(await request.json()); return Response.json({ ok: true }) } })
  try {
    const trace = await start({ root, session: "one", purpose: "coding", model: "fixture", system: ["Only inspect repository sources."], messages: [{ role: "user", content: code.text }] })
    expect(trace).toBeDefined()
    await trace!.fetch(fetch)(server.url, { method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: code.text }] }), headers: { "Content-Type": "application/json", Authorization: "secret-canary" } })
    await trace!.finish({ input: 10, output: 5, measured: true })
    const before = (await storage.manifests(root)).find((item) => item.id === trace!.id)!
    expect(received).toHaveLength(1)
    expect(before.entries.find((item) => item.source === code.id)?.stage).toBe("sent")
    expect(before.entries.find((item) => item.kind === "instruction")?.stage).toBe("assembled")
    expect(JSON.stringify(before)).not.toContain("secret-canary")
    await compact(root, "one", "The queue assignment function returns waiting.")
    const after = (await storage.manifests(root)).find((item) => item.id === trace!.id)
    expect(after).toEqual(before)
    expect((await storage.manifests(root)).some((item) => item.purpose === "compaction-lineage")).toBe(true)
    expect((await storage.externals(root)).some((item) => item.kind === "summary" && item.evidence.includes(code.id))).toBe(true)
    expect(await storage.manifests("/different-workspace")).toEqual([])
  } finally { unregister(); await server.stop(true); db.close() }
})

test("redacts complete authorization values in persisted requests and compaction lineage", async () => {
  const db = new Database(":memory:")
  const storage = store({
    all: async (query) => db.query<Record<string, unknown>, (string | number | null)[]>(query.text).all(...query.values ?? []),
    batch: async (queries) => { db.transaction(() => { for (const query of queries) db.query(query.text).run(...query.values ?? []) })() },
  })
  const root = "/forge-privacy-fixture"
  const unregister = register(root, storage)
  const received: unknown[] = []
  const server = Bun.serve({ port: 0, fetch: async (request) => { received.push(await request.json()); return Response.json({ ok: true }) } })
  const bearer = "trace-bearer-canary.123"
  const basic = "dHJhY2UtYmFzaWMtY2FuYXJ5OnBhc3N3b3Jk"
  const text = `Authorization: Bearer ${bearer}\nAuthorization: Basic ${basic}`
  const redacted = "Authorization: [REDACTED]\nAuthorization: [REDACTED]"
  try {
    const messages = [{ role: "user", content: text }]
    const trace = await start({ root, session: "privacy", purpose: "coding", model: "fixture", system: [text], messages, tools: { description: text }, options: { instructions: text } })
    expect(trace).toBeDefined()
    const assembled = (await storage.manifests(root)).find((item) => item.id === trace!.id)!
    expect(assembled.entries).toHaveLength(5)
    for (const entry of assembled.entries.filter((entry) => entry.text !== "user")) {
      expect(entry.text).toContain("[REDACTED]")
      expect(entry.text).not.toContain(bearer)
      expect(entry.text).not.toContain(basic)
    }
    expect(db.serialize().toString("utf8")).not.toContain(bearer)
    expect(db.serialize().toString("utf8")).not.toContain(basic)
    await trace!.fetch(fetch)(server.url, { method: "POST", body: JSON.stringify({ messages }), headers: { "Content-Type": "application/json" } })
    await trace!.finish({ measured: false })
    expect(received).toEqual([{ messages }])
    const completed = (await storage.manifests(root)).find((item) => item.id === trace!.id)!
    expect(completed.entries.filter((entry) => entry.text === redacted)).toHaveLength(3)
    expect(completed.entries.filter((entry) => entry.text === redacted).every((entry) => entry.stage === "sent")).toBe(true)
    await compact(root, "privacy", text)
    const summaries = await storage.externals(root)
    expect(summaries.find((item) => item.kind === "summary")?.text).toBe(redacted)
    const manifests = await storage.manifests(root)
    expect(manifests.find((item) => item.purpose === "compaction-lineage")?.entries.some((entry) => entry.text === redacted)).toBe(true)
    expect(manifests.find((item) => item.id === trace!.id)).toEqual(completed)
    expect(db.serialize().toString("utf8")).not.toContain(bearer)
    expect(db.serialize().toString("utf8")).not.toContain(basic)
  } finally { unregister(); await server.stop(true); db.close() }
})

test("redacts structured and nested serialized capture and compaction before SQLite persistence", async () => {
  const db = new Database(":memory:")
  const storage = store({
    all: async (query) => db.query<Record<string, unknown>, (string | number | null)[]>(query.text).all(...query.values ?? []),
    batch: async (queries) => { db.transaction(() => { for (const query of queries) db.query(query.text).run(...query.values ?? []) })() },
  })
  const root = "/forge-nested-privacy-fixture"
  const unregister = register(root, storage)
  const received: unknown[] = []
  const server = Bun.serve({ port: 0, fetch: async (request) => { received.push(await request.json()); return Response.json({ ok: true }) } })
  const text = String.raw`Authorization:\tBearer escaped-trace-canary; preserve instructions`
  const nested = JSON.stringify({ headers: { Authorization: "Basic nested-basic-canary" }, safe: "keep nested context" })
  const description = `Tool example: ${JSON.stringify({ example: nested })}; keep tool explanation\nAuthorization:\tBearer\ttab-trace-canary; preserve tab instructions`
  const tools = {
    inspect: {
      description,
      headers: { Authorization: "Bearer structured-trace-canary" },
      parameters: { type: "object", properties: { query: { type: "string", description: "Useful query" } } },
      execute: () => "not serialized",
    },
  }
  const messages = [{ role: "user", content: `${text}\n${description}` }]
  const canaries = ["escaped-trace-canary", "nested-basic-canary", "structured-trace-canary", "compaction-basic-canary", "tab-trace-canary"]
  function clean() {
    const bytes = db.serialize()
    for (const canary of canaries) expect(bytes.includes(Buffer.from(canary))).toBe(false)
  }
  try {
    const trace = await start({ root, session: "nested", purpose: "coding", model: "fixture", system: [text], messages, tools, options: { instructions: description } })
    expect(trace).toBeDefined()
    clean()
    const assembled = (await storage.manifests(root)).find((item) => item.id === trace!.id)!
    const tool = assembled.entries.find((entry) => entry.label === "Tool definitions")!
    const parsed = JSON.parse(tool.text)
    expect(parsed.inspect.headers.Authorization).toBe("[REDACTED]")
    expect(parsed.inspect.parameters).toEqual(tools.inspect.parameters)
    expect(parsed.inspect.execute).toBeUndefined()
    expect(parsed.inspect.description).toContain("keep tool explanation")
    expect(parsed.inspect.description).toContain("keep nested context")
    expect(parsed.inspect.description).toContain("Authorization:\t[REDACTED]; preserve tab instructions")
    expect(assembled.entries.some((entry) => entry.text === String.raw`Authorization:\t[REDACTED]; preserve instructions`)).toBe(true)
    await trace!.fetch(fetch)(server.url, { method: "POST", body: JSON.stringify({ messages, tools }), headers: { "Content-Type": "application/json" } })
    await trace!.finish({ measured: false })
    expect(received).toEqual([JSON.parse(JSON.stringify({ messages, tools }))])
    clean()
    const completed = (await storage.manifests(root)).find((item) => item.id === trace!.id)!
    expect(completed.entries.find((entry) => entry.label === "Message content 2")?.stage).toBe("sent")
    const summary = `${text}\n${description}\n${JSON.stringify({ description: JSON.stringify({ Authorization: "Basic compaction-basic-canary", safe: "retain summary fact" }) })}`
    await compact(root, "nested", summary)
    clean()
    const manifests = await storage.manifests(root)
    expect(manifests.find((item) => item.id === trace!.id)).toEqual(completed)
    const lineage = manifests.find((item) => item.purpose === "compaction-lineage")!
    expect(lineage.entries.some((entry) => entry.stage === "summarized" && entry.source === tool.source)).toBe(true)
    expect(lineage.entries.at(-1)?.text).toContain("retain summary fact")
    const external = (await storage.externals(root)).find((item) => item.kind === "summary")!
    expect(external.text).toContain("retain summary fact")
    expect(external.text).toContain("keep nested context")
    expect(external.evidence).toContain(tool.source)
  } finally { unregister(); await server.stop(true); db.close() }
})

test.each(["Bearer", "Basic"])("redacts embedded escaped %s pairs in captured and compacted SQLite records", async (scheme) => {
  const db = new Database(":memory:")
  const storage = store({
    all: async (query) => db.query<Record<string, unknown>, (string | number | null)[]>(query.text).all(...query.values ?? []),
    batch: async (queries) => { db.transaction(() => { for (const query of queries) db.query(query.text).run(...query.values ?? []) })() },
  })
  const root = `/forge-embedded-privacy-${scheme}`
  const unregister = register(root, storage)
  const received: unknown[] = []
  const server = Bun.serve({ port: 0, fetch: async (request) => { received.push(await request.json()); return Response.json({ ok: true }) } })
  const text = `Example: {"\\u0041uthorization":"${scheme} embedded-canary","safe":"keep"}\n` +
    `Example: {"Authorization":"${scheme} prefix\\u002dunicode-tail","safe":"keep"}\n` +
    `Example: {"Authorization":"${scheme} prefix\\\\backslash-tail","safe":"keep"}\n` +
    `Example: {"Authoriz\\u0061tion":"${scheme} prefix\\"quote-tail","safe":"keep"}`
  const safe = String.raw`Example: {"\u0041uthorization":"[REDACTED]","safe":"keep"}` + "\n" +
    'Example: {"Authorization":"[REDACTED]","safe":"keep"}\n' +
    'Example: {"Authorization":"[REDACTED]","safe":"keep"}\n' +
    String.raw`Example: {"Authoriz\u0061tion":"[REDACTED]","safe":"keep"}`
  const description = `Nested example: ${JSON.stringify(JSON.stringify(text))}; retain tool explanation`
  const expected = `Nested example: ${JSON.stringify(JSON.stringify(safe))}; retain tool explanation`
  const messages = [{ role: "user", content: text }]
  const tools = { inspect: { description } }
  function clean() {
    const bytes = db.serialize()
    for (const canary of ["embedded-canary", "unicode-tail", "backslash-tail", "quote-tail"]) {
      expect(bytes.includes(Buffer.from(canary))).toBe(false)
    }
  }
  try {
    const trace = await start({ root, session: "embedded", purpose: "coding", model: "fixture", system: [text], messages, tools, options: { instructions: description } })
    expect(trace).toBeDefined()
    clean()
    const assembled = (await storage.manifests(root)).find((item) => item.id === trace!.id)!
    expect(assembled.entries.find((entry) => entry.label === "System instructions 1")?.text).toBe(safe)
    expect(assembled.entries.find((entry) => entry.label === "Message content 2")?.text).toBe(safe)
    expect(assembled.entries.find((entry) => entry.label === "Provider instructions and options")?.text).toBe(expected)
    expect(JSON.parse(assembled.entries.find((entry) => entry.label === "Tool definitions")!.text))
      .toEqual({ inspect: { description: expected } })
    await trace!.fetch(fetch)(server.url, { method: "POST", body: JSON.stringify({ messages, tools }), headers: { "Content-Type": "application/json" } })
    clean()
    await trace!.finish({ measured: false })
    expect(received).toEqual([{ messages, tools }])
    const completed = (await storage.manifests(root)).find((item) => item.id === trace!.id)!
    expect(completed.entries.find((entry) => entry.label === "Message content 2")?.stage).toBe("sent")
    await compact(root, "embedded", `${text}\n${description}`)
    clean()
    const manifests = await storage.manifests(root)
    expect(manifests.find((item) => item.id === trace!.id)).toEqual(completed)
    expect(manifests.find((item) => item.purpose === "compaction-lineage")?.entries.at(-1)?.text).toBe(`${safe}\n${expected}`)
    const summary = (await storage.externals(root)).find((item) => item.kind === "summary")!
    expect(summary.text).toBe(`${safe}\n${expected}`)
    expect(summary.evidence).toContain(assembled.entries.find((entry) => entry.label === "Tool definitions")!.source)
  } finally { unregister(); await server.stop(true); db.close() }
})
