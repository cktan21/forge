import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"
import { binding } from "../src/binding"
import { engine } from "../src/engine"
import { knowledge } from "../src/knowledge"
import { store } from "../src/store"
import { source } from "../src/parse"

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "forge-pins-")))
  const filename = path.join(root, "state.sqlite")
  let calls = 0
  function open() {
    const db = new Database(filename)
    const storage = store({
      all: async (query) => db.query<Record<string, unknown>, (string | number | null)[]>(query.text).all(...query.values ?? []),
      batch: async (queries) => { db.transaction(() => { for (const query of queries) db.query(query.text).run(...query.values ?? []) })() },
    })
    const library = knowledge(root, storage)
    const api = engine({ root, store: storage, provider: async () => "local", complete: async () => { calls++; throw new Error("Unexpected model call") } })
    return { db, storage, library, api, async close() { await api.dispose(); await library.dispose(); db.close() } }
  }
  let state = open()
  const file = path.join(root, "reference.md")
  await Bun.write(file, "# Lease\nOriginal reviewed passage.")
  const item = await state.library.register({ kind: "file", label: "Reference", location: file })
  await state.library.approve(item.id, "", ["local"])
  await state.library.index(item.id)
  return {
    root, file, item, get calls() { return calls }, get api() { return state.api }, get library() { return state.library }, get storage() { return state.storage },
    async passage() { return (await state.storage.knowledge(root)).find((item) => item.method === "collection-section")! },
    async restart() { await state.close(); state = open(); await state.library.ready(); await state.library.index(item.id) },
    async [Symbol.asyncDispose]() { await state.close(); await rm(root, { recursive: true, force: true }) },
  }
}

test("pin bindings cover excerpt identity and document version without retaining body text", () => {
  const item = source("reference.pdf", "PRIVATE_BODY_CANARY", "document", { start: 2, end: 4, method: "collection-section", detail: { page: "2", fileHash: "file" } })
  const value = binding(item)
  expect(value).not.toContain(item.text)
  for (const changed of [
    { ...item, hash: "different" }, { ...item, uri: "renamed.pdf" }, { ...item, start: 1 },
    { ...item, detail: { ...item.detail, page: "3" } }, { ...item, detail: { ...item.detail, fileHash: "updated" } },
  ]) expect(binding(changed)).not.toBe(value)
  expect(binding({ ...item, observed: 1234, detail: { ...item.detail, providers: '["other"]' } })).toBe(value)
})

test("saved pins survive reopening but block changed versions until explicit confirmation", async () => {
  await using f = await fixture()
  const original = await f.passage()
  const saved = await f.api.configure({ ...await f.api.policy(), pin: [original.id], versions: { [original.id]: binding(original), ignored: "UNUSED_CANARY" } })
  expect(saved.versions).toEqual({ [original.id]: binding(original) })
  expect(JSON.stringify(saved)).not.toContain("Original reviewed passage")
  expect((await f.api.retrieve("Lease")).matches.some((match) => match.source.id === original.id)).toBe(true)
  await f.restart()
  expect((await f.api.policy()).versions).toEqual(saved.versions)
  await Bun.write(f.file, "# Lease\nChanged passage requiring review.")
  await f.library.index(f.item.id)
  const changed = await f.passage()
  expect(changed.id).toBe(original.id)
  expect(changed.hash).not.toBe(original.hash)
  const failure = await f.api.enhance({ text: "Explain leases" }).then(() => undefined, (err: unknown) => err)
  expect(String(failure)).toContain("Pinned excerpt changed")
  expect(f.calls).toBe(0)
  const unrelated = await f.api.configure({ ...await f.api.policy(), exclude: [] })
  expect(unrelated.versions?.[original.id]).toBe(binding(original))
  const still = await f.api.retrieve("Lease").then(() => undefined, (err: unknown) => err)
  expect(String(still)).toContain("Pinned excerpt changed")
  const confirmed = await f.api.configure({ ...unrelated, versions: { [changed.id]: binding(changed) } })
  expect(confirmed.versions?.[changed.id]).toBe(binding(changed))
  expect((await f.api.retrieve("Lease")).text).toContain("Changed passage requiring review")
  const empty = await f.api.configure({ ...confirmed, pin: [] })
  const stale = await f.api.configure({ ...empty, pin: [original.id], versions: { [original.id]: binding(original) } }).then(() => undefined, (err: unknown) => err)
  expect(String(stale)).toContain("Source changed since inspection")
  expect(await f.api.policy()).toEqual(empty)
})

test("legacy pins remain unverified until an explicit current-version confirmation", async () => {
  await using f = await fixture()
  const item = await f.passage()
  await f.storage.policySave(f.root, { version: "legacy", session: "chat", pin: [item.id], exclude: [] })
  await f.restart()
  const policy = await f.api.policy("chat")
  expect(policy.versions).toEqual({})
  const failed = await f.api.retrieve("Lease", { session: "chat" }).then(() => undefined, (err: unknown) => err)
  expect(String(failed)).toContain("no verified version")
  const unchanged = await f.api.configure(policy)
  expect(unchanged.versions).toEqual({})
  await f.api.configure({ ...unchanged, versions: { [item.id]: binding(item) } })
  expect((await f.api.retrieve("Lease", { session: "chat" })).matches.some((match) => match.source.id === item.id)).toBe(true)
  expect((await f.api.policy("other")).pin).toEqual([])
})

test("sessions cannot replace workspace pin versions", async () => {
  await using f = await fixture()
  const original = await f.passage()
  await f.api.configure({ ...await f.api.policy(), pin: [original.id] })
  await Bun.write(f.file, "# Lease\nUpdated workspace requirements.")
  await f.library.index(f.item.id)
  const changed = await f.passage()
  const inherited = await f.api.policy("chat")
  expect(inherited.versions?.[original.id]).toBe(binding(original))
  const rejected = await f.api.configure({ ...inherited, versions: { [original.id]: binding(changed) } }).then(() => undefined, (err: unknown) => err)
  expect(String(rejected)).toContain("Workspace policy scope")
  expect(await f.api.policy("chat")).toEqual(inherited)
  await f.api.configure({ ...await f.api.policy(), versions: { [original.id]: binding(changed) } })
  expect((await f.api.policy("chat")).versions?.[original.id]).toBe(binding(changed))
  expect((await f.api.retrieve("Lease", { session: "chat" })).text).toContain("Updated workspace requirements")
})

test("purge drops missing-source version metadata without deleting unrelated pin bindings", async () => {
  await using f = await fixture()
  const original = await f.passage()
  const collection = await f.library.register({ kind: "text", label: "Other", location: "", content: "# Other\nIndependent reference." })
  await f.library.approve(collection.id)
  await f.library.index(collection.id)
  const other = (await f.storage.knowledge(f.root)).find((source) => source.method === "collection-section" && source.detail.collection === collection.id)!
  const policy = await f.api.configure({ ...await f.api.policy(), pin: [original.id, other.id] })
  expect(policy.versions?.[original.id]).toBe(binding(original))
  await f.library.purge(f.item.id)
  const current = await f.api.policy()
  expect(current.pin).toEqual(policy.pin)
  expect(current.version).not.toBe(policy.version)
  expect(current.versions).toEqual({ [other.id]: binding(other) })
  expect(JSON.stringify(await f.storage.policy(f.root))).not.toContain(original.uri)
})
