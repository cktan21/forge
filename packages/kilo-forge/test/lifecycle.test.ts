import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtemp, mkdir, realpath, rename, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { store } from "../src/store"
import { knowledge } from "../src/knowledge"
import { extract, type Extractor } from "../src/extract"
import { engine } from "../src/engine"
import { usage } from "../src/schema"
import { source } from "../src/parse"
import { brief } from "../src/briefs"

function connect(db: Database) {
  return store({
    all: async (query) => db.query<Record<string, unknown>, (string | number | null)[]>(query.text).all(...query.values ?? []),
    batch: async (queries) => { db.transaction(() => { for (const query of queries) db.query(query.text).run(...query.values ?? []) })() },
  })
}

test("document briefs survive reopening and reparse only altered extraction units", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "forge-brief-reopen-")))
  const filename = path.join(root, "knowledge.sqlite")
  const dir = path.join(root, "docs")
  const calls: string[] = []
  const parser: Extractor = async (...args) => { calls.push(args[0]); return extract(...args) }
  try {
    await mkdir(dir)
    await Bun.write(path.join(dir, "first.md"), "# Lease ownership\nOriginal epoch policy.")
    await Bun.write(path.join(dir, "second.md"), "# Metrics\nUnchanged monitoring policy.")
    const original = await (async () => {
      const db = new Database(filename)
      const storage = connect(db)
      const library = knowledge(root, storage, { extract: parser })
      try {
        const item = await library.register({ kind: "folder", label: "Manuals", location: dir, session: "private" })
        await library.approve(item.id, "private", ["local"])
        const collection = await library.index(item.id, "private")
        const sources = await storage.knowledge(root, "private")
        expect(calls.toSorted()).toEqual(["first.md", "second.md"])
        // Persist a pre-brief parent beside a current parent, retaining extracted chunks.
        await storage.publish(root, collection, sources.map((source) =>
          source.method !== "collection-document" || source.detail.document !== "first.md" ? source : {
            ...source, hash: source.detail.fileHash!, evidence: [],
            detail: Object.fromEntries(Object.entries(source.detail).filter(([key]) => !key.startsWith("brief"))),
          },
        ))
        return { key: item.id, sources, generation: collection.generation }
      } finally { await library.dispose(); db.close() }
    })()
    calls.length = 0
    const db = new Database(filename)
    const storage = connect(db)
    const library = knowledge(root, storage, { extract: parser })
    try {
      await library.ready()
      expect(await storage.knowledge(root, "other")).toEqual([])
      expect((await storage.knowledge(root, "private")).every((source) => source.status === "unavailable")).toBe(true)
      const reconciled = await library.index(original.key, "private")
      expect(reconciled.generation).toBe(original.generation)
      expect(calls).toEqual(["first.md"])
      expect(reconciled.result).toMatchObject({ extracted: 1, reused: 1 })
      const current = await storage.knowledge(root, "private")
      expect(current.map((source) => ({ ...source, observed: 0 }))).toEqual(original.sources.map((source) => ({ ...source, observed: 0 })))
      for (const parent of current.filter((source) => source.method === "collection-document")) {
        expect(brief(parent, current).cached).toBe(true)
        if (parent.detail.document === "second.md") expect(parent).toEqual(original.sources.find((source) => source.id === parent.id)!)
      }
      calls.length = 0
      await Bun.write(path.join(dir, "first.md"), "# Lease ownership\nRevised epoch policy.")
      await library.index(original.key, "private")
      expect(calls).toEqual(["first.md"])
      const changed = await storage.knowledge(root, "private")
      const first = changed.find((source) => source.method === "collection-document" && source.detail.document === "first.md")!
      expect(first.detail.brief).toContain("Revised epoch policy")
      expect(first.hash).not.toBe(original.sources.find((source) => source.id === first.id)?.hash)
      const second = changed.find((source) => source.method === "collection-document" && source.detail.document === "second.md")!
      expect(second).toEqual(current.find((source) => source.id === second.id)!)
      await rename(path.join(dir, "first.md"), path.join(dir, "renamed.md"))
      await library.index(original.key, "private")
      expect((await storage.knowledge(root, "private")).some((source) => source.detail.document === "first.md")).toBe(false)
      await rm(path.join(dir, "renamed.md"))
      await library.index(original.key, "private")
      expect((await storage.knowledge(root, "private")).every((source) => source.detail.document === "second.md")).toBe(true)
      await library.stop(original.key, "private")
      expect((await storage.knowledge(root, "private")).every((source) => source.status === "unavailable")).toBe(true)
      await library.purge(original.key, "private")
      expect(await storage.knowledge(root, "private")).toEqual([])
    } finally { await library.dispose(); db.close() }
  } finally { await rm(root, { recursive: true, force: true }) }
})

async function published(storage: ReturnType<typeof store>, root: string, key: string, state = "ready") {
  const done = Promise.withResolvers<void>()
  const check = () => {
    void storage.collection(root, key).then((item) => {
      if (item?.state === state) done.resolve()
    }).catch(done.reject)
  }
  const off = storage.subscribe(root, check)
  const timeout = setTimeout(() => done.reject(new Error(`Collection did not reach ${state}`)), 10_000)
  try { check(); await done.promise } finally { off(); clearTimeout(timeout) }
}

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "forge-lifecycle-")))
  const db = new Database(path.join(root, "knowledge.sqlite"))
  const storage = connect(db)
  const handles: ReturnType<typeof knowledge>[] = []
  const library = (parser?: Extractor) => {
    const value = knowledge(root, storage, { extract: parser })
    handles.push(value)
    return value
  }
  return { root, db, storage, library, async [Symbol.asyncDispose]() {
    await Promise.all(handles.map((value) => value.dispose()))
    db.close()
    await rm(root, { recursive: true, force: true })
  } }
}

function gate() {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const aborted = Promise.withResolvers<void>()
  const calls: string[] = []
  const parser: Extractor = async (name, bytes, signal) => {
    calls.push(name)
    signal.addEventListener("abort", () => aborted.resolve(), { once: true })
    entered.resolve()
    await release.promise
    // Deliberately let extraction finish after cancellation to exercise publication fencing.
    return extract(name, bytes, new AbortController().signal)
  }
  return { entered, release, aborted, calls, parser }
}

for (const action of ["stop", "purge", "approve"] as const) {
  test(`${action} from another handle cancels extraction and prevents late publication`, async () => {
    await using f = await fixture()
    const barrier = gate()
    const worker = f.library(barrier.parser)
    const controls = f.library()
    const item = await worker.register({ kind: "text", label: "Document", location: "", content: "cancelled extraction canary" })
    await worker.approve(item.id, "", ["old-provider"])
    const indexing = worker.index(item.id).then(() => undefined, (err: unknown) => err)
    await barrier.entered.promise
    const changing = action === "approve" ? controls.approve(item.id, "", ["new-provider"]) : controls[action](item.id)
    try {
      await barrier.aborted.promise
      barrier.release.resolve()
      expect(await indexing).toBeInstanceOf(Error)
      await changing
      const current = await f.storage.collection(f.root, item.id)
      if (action === "purge") {
        expect(current).toBeUndefined()
        expect(await f.storage.contents(f.root, item.id)).toBeUndefined()
        expect(await f.storage.knowledge(f.root)).toEqual([])
        return
      }
      expect(current?.state).toBe(action === "stop" ? "paused" : "registered")
      expect(current?.providers).toEqual(action === "stop" ? [] : ["new-provider"])
      expect(current?.progress).toBeUndefined()
      expect((await f.storage.knowledge(f.root)).every((source) => source.status !== "current")).toBe(true)
      if (action === "approve") expect((await controls.index(item.id)).state).toBe("ready")
    } finally { barrier.release.resolve(); await Promise.allSettled([indexing, changing]) }
  })
}

test("concurrent indexing shares one job, and foreign sessions cannot cancel it", async () => {
  await using f = await fixture()
  const barrier = gate()
  const worker = f.library(barrier.parser)
  const controls = f.library(barrier.parser)
  const item = await worker.register({ kind: "text", label: "Private", location: "", session: "chat", content: "private extraction" })
  await worker.approve(item.id, "chat")
  const first = worker.index(item.id, "chat")
  await barrier.entered.promise
  const second = controls.index(item.id, "chat")
  try {
    await expect(controls.stop(item.id, "other")).rejects.toThrow("not available")
    await expect(controls.index(item.id, "other")).rejects.toThrow("not available")
    // Disposing an unrelated read handle must not cancel another owner's extraction.
    await controls.dispose()
    barrier.release.resolve()
    expect((await first).state).toBe("ready")
    expect(await second).toEqual(await first)
    expect(barrier.calls).toHaveLength(1)
  } finally { barrier.release.resolve(); await Promise.allSettled([first, second]) }
})

test("a queued collection revoked behind another extraction never reaches its parser", async () => {
  await using f = await fixture()
  const barrier = gate()
  const worker = f.library(barrier.parser)
  const controls = f.library()
  const first = await worker.register({ kind: "text", label: "First", location: "", content: "first" })
  const second = await worker.register({ kind: "text", label: "Second", location: "", content: "second" })
  await worker.approve(first.id)
  await worker.approve(second.id)
  const active = worker.index(first.id)
  await barrier.entered.promise
  const queued = worker.index(second.id).then(() => undefined, (err: unknown) => err)
  const pause = controls.stop(second.id)
  try {
    barrier.release.resolve()
    await active
    expect(await queued).toBeInstanceOf(Error)
    await pause
    expect(barrier.calls).toHaveLength(1)
    expect((await controls.get(second.id)).state).toBe("paused")
  } finally { barrier.release.resolve(); await Promise.allSettled([active, queued, pause]) }
})

test("purge and reapproval serialize without resurrecting a deleted registration", async () => {
  await using f = await fixture()
  const worker = f.library()
  const controls = f.library()
  const item = await worker.register({ kind: "text", label: "Race", location: "", content: "purge canary" })
  await worker.approve(item.id)
  await worker.index(item.id)
  const results = await Promise.allSettled([worker.purge(item.id), controls.approve(item.id)])
  expect(results.at(0)?.status).toBe("fulfilled")
  expect(results.at(1)?.status).toBe("rejected")
  expect(await f.storage.collection(f.root, item.id)).toBeUndefined()
  expect(await f.storage.knowledge(f.root)).toEqual([])
})

test.each(["enhance", "overview"] as const)("purge rejects late %s completion without recreating captures or caches", async (method) => {
  await using f = await fixture()
  const controls = f.library()
  const item = await controls.register({ kind: "text", label: "Canary", location: "", content: "copied purge canary" })
  await controls.approve(item.id, "", ["provider"])
  await controls.index(item.id)
  await Bun.write(path.join(f.root, "queue.ts"), "export const queue = []")
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const api = engine({ root: f.root, store: f.storage, provider: async () => "provider", complete: async () => {
    entered.resolve()
    await release.promise
    return { text: JSON.stringify({ summary: "copied purge canary", evidence: [] }), usage: usage("fixture") }
  } })
  const pending = (method === "enhance" ? api.enhance({ text: "copied purge canary" }) : api.overview()).then(() => undefined, (err: unknown) => err)
  try {
    await entered.promise
    await controls.purge(item.id)
    release.resolve()
    expect(String(await pending)).toContain("purged")
    expect(await f.storage.manifests(f.root)).toEqual([])
    expect((await f.storage.externals(f.root)).some((item) => item.kind === "summary")).toBe(false)
    expect(f.db.query("SELECT count(*) AS count FROM forge_records WHERE kind = 'cache'").get()).toEqual({ count: 0 })
    expect((await api.refresh()).sources.some((item) => item.text.includes("copied purge canary"))).toBe(false)
  } finally { release.resolve(); await pending; await api.dispose() }
})

test("a purge on a second SQLite connection rolls back a stale write inside its transaction", async () => {
  await using f = await fixture()
  const controls = f.library()
  const item = await controls.register({ kind: "text", label: "Canary", location: "", content: "purge target" })
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const db = new Database(path.join(f.root, "knowledge.sqlite"))
  let held = true
  const delayed = store({
    all: async (query) => db.query<Record<string, unknown>, (string | number | null)[]>(query.text).all(...query.values ?? []),
    batch: async (queries) => {
      if (held && queries.some((query) => query.values?.includes("cache"))) {
        held = false
        entered.resolve()
        await release.promise
      }
      db.transaction(() => { for (const query of queries) db.query(query.text).run(...query.values ?? []) })()
    },
  })
  const pending = delayed.fenced(f.root, () => delayed.cache(f.root, "stale", "copied purge canary")).then(() => undefined, (err: unknown) => err)
  try {
    await entered.promise
    await controls.purge(item.id)
    release.resolve()
    expect(String(await pending)).toContain("purged")
    expect(await f.storage.cached(f.root, "stale")).toBeUndefined()
    await delayed.fenced(f.root, () => delayed.cache(f.root, "fresh", "new operation"))
    expect(await f.storage.cached(f.root, "fresh")).toBe("new operation")
  } finally { release.resolve(); await pending; db.close() }
})

test("purge guards fence summaries and snapshots, preserve nesting, and isolate workspaces", async () => {
  await using f = await fixture()
  const controls = f.library()
  const item = await controls.register({ kind: "text", label: "Canary", location: "", content: "purge target" })
  const old = await f.storage.guard(f.root)
  const other = await f.storage.guard(`${f.root}-other`)
  const nested = await old.run(() => f.storage.guard(f.root))
  await controls.purge(item.id)
  const summary = source("summary:copied", "copied purge canary", "summary")
  await expect(nested.run(() => f.storage.external(f.root, summary))).rejects.toThrow("purged")
  await expect(old.run(() => f.storage.replace({ root: f.root, generation: "stale", revision: "", files: 0, sources: [summary], relations: [], warnings: [], observed: 0, partial: false }))).rejects.toThrow("purged")
  expect(await f.storage.snapshot(f.root)).toBeUndefined()
  expect(await f.storage.externals(f.root)).toEqual([])
  await other.run(() => f.storage.cache(`${f.root}-other`, "unaffected", "other workspace"))
  expect(await f.storage.cached(`${f.root}-other`, "unaffected")).toBe("other workspace")
})

test("file watchers start fresh operations after an unrelated collection purge", async () => {
  await using f = await fixture()
  const controls = f.library()
  await Bun.write(path.join(f.root, "watched.md"), "before purge")
  const watched = await controls.register({ kind: "file", label: "Watched", location: path.join(f.root, "watched.md"), watch: true })
  const removed = await controls.register({ kind: "text", label: "Removed", location: "", content: "purge target" })
  await controls.approve(watched.id)
  await f.storage.fenced(f.root, () => controls.index(watched.id))
  await controls.purge(removed.id)
  const done = Promise.withResolvers<void>()
  const timer = setTimeout(() => done.reject(new Error("Watcher retained an obsolete purge revision")), 10_000)
  const unsubscribe = f.storage.subscribe(f.root, () => {
    void f.storage.knowledge(f.root).then((sources) => {
      if (sources.some((source) => source.detail.collection === watched.id && source.text === "after unrelated purge" && source.status === "current")) done.resolve()
    }).catch(done.reject)
  })
  try {
    await Bun.write(path.join(f.root, "watched.md"), "after unrelated purge")
    await done.promise
  } finally { clearTimeout(timer); unsubscribe() }
}, 15_000)

test("owner shutdown waits for cancellation cleanup and does not close other owners", async () => {
  await using f = await fixture()
  const barrier = gate()
  const worker = f.library(barrier.parser)
  const controls = f.library()
  const item = await worker.register({ kind: "text", label: "Closing", location: "", content: "shutdown canary" })
  await worker.approve(item.id)
  const indexing = worker.index(item.id).then(() => undefined, (err: unknown) => err)
  await barrier.entered.promise
  let settled = false
  const closing = worker.dispose().then(() => { settled = true })
  try {
    await barrier.aborted.promise
    expect(settled).toBe(false)
    barrier.release.resolve()
    expect(await indexing).toBeInstanceOf(Error)
    await closing
    expect((await controls.get(item.id)).state).toBe("failed")
    await controls.approve(item.id)
    expect((await controls.index(item.id)).state).toBe("ready")
  } finally { barrier.release.resolve(); await Promise.allSettled([indexing, closing]) }
})

test("explicit restart refresh reconciles offline edits without blocking status or reparsing unchanged files", async () => {
  await using f = await fixture()
  const initial = f.library()
  for (const name of ["changed", "stable", "renamed", "deleted"]) await Bun.write(path.join(f.root, "docs", `${name}.md`), `original ${name}`)
  const item = await initial.register({ kind: "folder", label: "Private docs", location: path.join(f.root, "docs"), session: "private" })
  await initial.approve(item.id, "private", ["provider"])
  await initial.index(item.id, "private")
  const before = await f.storage.knowledge(f.root, "private")
  await initial.dispose()
  await Bun.write(path.join(f.root, "docs/changed.md"), "new offline content")
  await rename(path.join(f.root, "docs/renamed.md"), path.join(f.root, "docs/moved.md"))
  await rm(path.join(f.root, "docs/deleted.md"))
  const db = new Database(path.join(f.root, "knowledge.sqlite"))
  const storage = connect(db)
  const barrier = gate()
  const api = engine({ root: f.root, store: storage, extract: barrier.parser, complete: async () => { throw new Error("No inference") } })
  try {
    expect((await api.view()).sources).toEqual([])
    expect((await storage.collection(f.root, item.id))?.state).toBe("registered")
    expect(await storage.search(f.root, "original", 50, { session: "private", provider: "provider" })).toEqual([])
    expect(barrier.calls).toEqual([])
    const visible = await api.view({ session: "private" })
    expect(visible.sources.every((source) => source.status === "unavailable")).toBe(true)
    await api.registry({ session: "private" })
    expect(barrier.calls).toEqual([])
    expect((await storage.collection(f.root, item.id))?.state).toBe("registered")
    await api.index(item.id, "private")
    await barrier.entered.promise
    expect((await api.status("private")).job.state).toBe("idle")
    expect((await storage.collection(f.root, item.id))?.state).toBe("indexing")
    expect((await api.status("private")).inventory.warnings.join(" ")).toContain("indexing in the background")
    expect((await api.status()).inventory.warnings.join(" ")).not.toContain("document collection")
    await storage.replace({ root: f.root, generation: "fixture", revision: "", files: 0, sources: [], relations: [], warnings: [], observed: 0, partial: false })
    expect((await api.status("private")).inventory.warnings.join(" ")).toContain("indexing in the background")
    expect((await api.status()).inventory.warnings).toEqual([])
    barrier.release.resolve()
    await published(storage, f.root, item.id)
    const after = (await storage.knowledge(f.root, "private")).filter((source) => source.method === "collection-section")
    expect(after.map((source) => source.detail.document).sort()).toEqual(["changed.md", "moved.md", "stable.md"])
    expect(after.find((source) => source.detail.document === "changed.md")?.text).toBe("new offline content")
    expect(after.find((source) => source.detail.document === "stable.md")?.id).toBe(before.find((source) => source.detail.document === "stable.md" && source.method === "collection-section")?.id)
    expect(barrier.calls.sort()).toEqual(["changed.md", "moved.md"])
    expect((await storage.collection(f.root, item.id))?.providers).toEqual(["provider"])
    expect((await api.view()).sources).toEqual([])
  } finally { barrier.release.resolve(); await api.dispose(); db.close() }
})

test.each(["complete", "cancel"] as const)("task retrieval reconciles its private scope without opening a view: %s", async (mode) => {
  await using f = await fixture()
  const initial = f.library()
  const location = path.join(f.root, "policy.md")
  await Bun.write(location, "old epoch policy")
  const item = await initial.register({ kind: "file", label: "Policy", location, session: "private" })
  await initial.approve(item.id, "private", ["provider"])
  await initial.index(item.id, "private")
  await initial.dispose()
  await Bun.write(location, "offline epoch policy requires rotating leases")
  const db = new Database(path.join(f.root, "knowledge.sqlite"))
  const storage = connect(db)
  const barrier = gate()
  const abort = new AbortController()
  const api = engine({ root: f.root, store: storage, extract: barrier.parser, complete: async () => { throw new Error("No inference") } })
  let settled = false
  const pending = api.retrieve("offline epoch policy", { session: "private", provider: "provider", signal: abort.signal })
    .then((selection) => { settled = true; return { selection } }, (error: unknown) => { settled = true; return { error } })
  try {
    await barrier.entered.promise
    expect(settled).toBe(false)
    if (mode === "cancel") {
      abort.abort(new Error("Cancelled task"))
      const result = await pending
      expect("error" in result && String(result.error)).toContain("Cancelled task")
      expect((await storage.collection(f.root, item.id))?.state).toBe("indexing")
    }
    barrier.release.resolve()
    await published(storage, f.root, item.id)
    const result = mode === "complete" ? await pending : { selection: await api.retrieve("offline epoch policy", { session: "private", provider: "provider" }) }
    if ("error" in result) throw result.error
    expect(result.selection.matches.some((match) => match.source.text.includes("rotating leases"))).toBe(true)
    expect(barrier.calls).toEqual(["policy.md"])
  } finally { barrier.release.resolve(); await pending; await api.dispose(); db.close() }
})

test.each(["missing", "denied", "symlink"] as const)("restart keeps a %s interface root unavailable until explicit recovery", async (mode) => {
  await using f = await fixture()
  const initial = f.library()
  const location = path.join(f.root, "docs")
  await Bun.write(path.join(location, "notes.md"), "retained original document")
  const item = await initial.register({ kind: "folder", label: "Docs", location, watch: true })
  await initial.approve(item.id, "", ["provider"])
  await initial.index(item.id)
  await initial.dispose()
  if (mode !== "denied") await rename(location, `${location}-offline`)
  if (mode === "symlink") {
    await Bun.write(path.join(f.root, "replacement/notes.md"), "unapproved replacement document")
    await symlink(path.join(f.root, "replacement"), location)
  }
  const db = new Database(path.join(f.root, "knowledge.sqlite"))
  const storage = connect(db)
  let denied = mode === "denied"
  const api = engine({ root: f.root, store: storage, authorize: async () => { if (denied) throw new Error("Read permission denied") }, complete: async () => { throw new Error("No inference") } })
  const controls = knowledge(f.root, storage, { authorize: async () => { if (denied) throw new Error("Read permission denied") } })
  try {
    await api.status()
    expect((await storage.collection(f.root, item.id))?.state).toBe("registered")
    expect(await controls.index(item.id).then(() => undefined, (err: unknown) => err)).toBeInstanceOf(Error)
    await published(storage, f.root, item.id, "failed")
    expect(await storage.collection(f.root, item.id)).toMatchObject({ approved: false, providers: [], grants: {}, state: "failed" })
    expect((await api.status()).inventory.warnings.join(" ")).toContain("unavailable after a failed job")
    const saved = await storage.knowledge(f.root)
    expect(saved).toHaveLength(2)
    expect(saved.every((source) => source.status === "unavailable")).toBe(true)
    expect(saved.find((source) => source.method === "collection-section")?.text).toBe("retained original document")
    expect(await storage.search(f.root, "retained", 50, { provider: "provider" })).toEqual([])
    denied = false
    if (mode === "symlink") await rm(location)
    if (mode !== "denied") await rename(`${location}-offline`, location)
    await api.registry()
    expect((await controls.get(item.id)).approved).toBe(false)
    await controls.approve(item.id)
    await controls.index(item.id)
    expect((await controls.get(item.id)).state).toBe("ready")
    expect((await controls.get(item.id)).providers).toEqual([])
  } finally { await controls.dispose(); await api.dispose(); db.close() }
})

for (const action of ["stop", "purge"] as const) {
  test(`${action} cancels explicit restart reconciliation without republishing excerpts`, async () => {
    await using f = await fixture()
    const initial = f.library()
    const location = path.join(f.root, "document.md")
    await Bun.write(location, "before shutdown")
    const item = await initial.register({ kind: "file", label: "Document", location })
    await initial.approve(item.id)
    await initial.index(item.id)
    await initial.dispose()
    await Bun.write(location, "offline replacement")
    const db = new Database(path.join(f.root, "knowledge.sqlite"))
    const storage = connect(db)
    const barrier = gate()
    const api = engine({ root: f.root, store: storage, extract: barrier.parser, complete: async () => { throw new Error("No inference") } })
    const controls = knowledge(f.root, storage)
    try {
      await api.status()
      await api.index(item.id)
      await barrier.entered.promise
      const changing = controls[action](item.id)
      await barrier.aborted.promise
      barrier.release.resolve()
      await changing
      expect((await storage.knowledge(f.root)).every((source) => source.status === "unavailable")).toBe(true)
      expect((await storage.collection(f.root, item.id))?.state).toBe(action === "stop" ? "paused" : undefined)
    } finally { barrier.release.resolve(); await api.dispose(); await controls.dispose(); db.close() }
  })
}

test("read-only configuration discovery revokes changed approval without restart reconciliation", async () => {
  await using f = await fixture()
  const initial = f.library()
  const location = path.join(f.root, "docs")
  await Bun.write(path.join(location, "notes.md"), "excluded after restart")
  const item = await initial.register({ kind: "folder", label: "Docs", location }, "config", "config:docs")
  await initial.approve(item.id, "", ["provider"])
  await initial.index(item.id)
  await initial.dispose()
  await Bun.write(path.join(f.root, ".kilo/forge.jsonc"), JSON.stringify({ knowledge: { collections: [{ id: "docs", path: "./docs", exclude: ["notes.md"] }] } }))
  const db = new Database(path.join(f.root, "knowledge.sqlite"))
  const storage = connect(db)
  const calls: string[] = []
  const api = engine({ root: f.root, store: storage, extract: async (name) => { calls.push(name); throw new Error("Unapproved extraction") }, complete: async () => { throw new Error("No inference") } })
  try {
    await api.status()
    await api.registry()
    expect(await storage.collection(f.root, item.id)).toMatchObject({ state: "registered", approved: false, providers: [], exclude: ["notes.md"] })
    expect(calls).toEqual([])
    expect((await storage.knowledge(f.root)).every((source) => source.status === "unavailable")).toBe(true)
  } finally { await api.dispose(); db.close() }
})

test("backend restart recovers interrupted persisted indexing without extracting or sharing", async () => {
  await using f = await fixture()
  await f.storage.ready
  const script = `
    import { Database } from "bun:sqlite";
    import { store } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/store.ts"))};
    import { knowledge } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/knowledge.ts"))};
    const root = process.argv[1];
    const db = new Database(root + "/knowledge.sqlite");
    const storage = store({
      all: async q => db.query(q.text).all(...q.values ?? []),
      batch: async queries => db.transaction(() => { for (const q of queries) db.query(q.text).run(...q.values ?? []) })(),
    });
    const initial = knowledge(root, storage);
    await Bun.write(root + "/watched.md", "original watched content");
    const watched = await initial.register({ kind: "file", label: "Watched", location: root + "/watched.md", session: "private", watch: true });
    await initial.approve(watched.id, "private");
    await initial.index(watched.id, "private");
    const item = await initial.register({ kind: "text", label: "Interrupted", location: "", session: "private", content: "persisted interruption canary" });
    await initial.approve(item.id, "private", ["provider"]);
    await initial.index(item.id, "private");
    await storage.content(root, item.id, "new content forces extraction");
    const worker = knowledge(root, storage, { extract: async () => {
      console.log(item.id);
      setInterval(() => {}, 1000);
      await Promise.withResolvers().promise;
      return [];
    } });
    await worker.index(item.id, "private");
  `
  const child = Bun.spawn([process.execPath, "--eval", script, f.root], { stdout: "pipe", stderr: "pipe" })
  const deadline = setTimeout(() => child.kill("SIGKILL"), 15_000)
  const reader = child.stdout.getReader()
  try {
    const output = await reader.read()
    const key = new TextDecoder().decode(output.value).trim()
    expect(key).toMatch(/^[a-f0-9]{24}$/)
    expect((await f.storage.collection(f.root, key))?.state).toBe("indexing")
    child.kill("SIGKILL")
    await child.exited
    const api = engine({ root: f.root, store: f.storage, complete: async () => { throw new Error("No inference during recovery") } })
    try {
      const visible = await api.view({ session: "private" })
      expect(visible.sources.length).toBeGreaterThan(0)
      expect(visible.sources.filter((source) => source.detail.collection === key).every((source) => source.status === "unavailable")).toBe(true)
      const item = await f.storage.collection(f.root, key)
      expect(item).toMatchObject({ state: "failed", approved: false, providers: [], grants: {} })
      expect(item?.progress).toBeUndefined()
      expect(item?.warnings.join(" ")).toContain("restart")
      expect((await api.view()).sources).toEqual([])
      expect(await f.storage.search(f.root, "interruption canary", 50, { session: "private", provider: "provider" })).toEqual([])
      const controls = f.library()
      await expect(controls.index(key, "private")).rejects.toThrow("Approve")
      await controls.approve(key, "private")
      expect((await controls.index(key, "private")).state).toBe("ready")
      const watching = (await f.storage.collections(f.root, "private")).find((item) => item.label === "Watched")!
      expect(watching.state).toBe("registered")
      await api.index(watching.id, "private")
      await published(f.storage, f.root, watching.id)
      const retained = (await api.collections("private")).find((item) => item.label === "Watched")!
      expect(retained).toMatchObject({ state: "ready", approved: true, watch: true, providers: [] })
      const refreshed = Promise.withResolvers<void>()
      const timer = setTimeout(() => refreshed.reject(new Error("Restored watcher did not refresh")), 10_000)
      const unsubscribe = f.storage.subscribe(f.root, () => {
        void f.storage.knowledge(f.root, "private").then((sources) => {
          if (sources.some((source) => source.detail.collection === retained.id && source.text.includes("updated after restart") && source.status === "current")) refreshed.resolve()
        }).catch(refreshed.reject)
      })
      try {
        await Bun.write(path.join(f.root, "watched.md"), "updated after restart")
        await refreshed.promise
      } finally { clearTimeout(timer); unsubscribe() }
    } finally { await api.dispose() }
  } finally {
    clearTimeout(deadline)
    child.kill()
    await child.exited
    reader.releaseLock()
  }
}, 30_000)
