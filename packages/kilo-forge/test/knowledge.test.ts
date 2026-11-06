import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { store } from "../src/store"
import { knowledge } from "../src/knowledge"
import { engine, type Ports } from "../src/engine"
import { extract, chunks } from "../src/extract"
import { publicAddress, download } from "../src/download"
import { usage, type Collection } from "../src/schema"
import { config } from "../src/config"
import { source } from "../src/parse"
import { deadline } from "../src/deadline"

async function fixture(destination?: Ports["destination"], authorize?: Ports["authorize"], provider: Ports["provider"] = async () => "approved-provider") {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "forge-knowledge-")))
  const db = new Database(":memory:")
  const storage = store({
    all: async (query) => db.query<Record<string, unknown>, (string | number | null)[]>(query.text).all(...query.values ?? []),
    batch: async (queries) => { db.transaction(() => { for (const query of queries) db.query(query.text).run(...query.values ?? []) })() },
  })
  const library = knowledge(root, storage, { destination, authorize })
  const calls: string[] = []
  const api = engine({
    root, store: storage, destination, authorize, provider,
    complete: async (input) => {
      calls.push(input.prompt)
      return { text: JSON.stringify({ objective: "Use the documented queue policy", reuse: [], inspect: [], changes: [], constraints: [], hypotheses: [], questions: [], acceptance: [], verification: [], evidence: [] }), usage: usage("fixture") }
    },
  })
  return {
    root, storage, library, api, calls,
    async [Symbol.asyncDispose]() { await Promise.all([api.dispose(), library.dispose()]); db.close(); await rm(root, { recursive: true, force: true }) },
  }
}

test("ingestion preview is bounded, ignore-aware, and leaves no registrations or chunks", async () => {
  await using f = await fixture()
  await mkdir(path.join(f.root, "docs"))
  await Bun.write(path.join(f.root, "docs/.gitignore"), "ignored.md\n")
  await Bun.write(path.join(f.root, "docs/ignored.md"), "ignored canary")
  await Bun.write(path.join(f.root, "docs/.env"), "secret canary")
  await Bun.write(path.join(f.root, "docs/allowed.md"), "# Guide\nOwnership uses an epoch lease.")
  await symlink(path.join(f.root, "docs/allowed.md"), path.join(f.root, "docs/link.md"))
  const result = await f.api.preview({ kind: "folder", label: "Docs", location: "./docs", include: ["**/*.md"] })
  expect(result.files).toBe(1)
  expect(result.excluded).toBeGreaterThanOrEqual(3)
  expect(result.samples.at(0)?.text).toContain("epoch lease")
  expect(JSON.stringify(result)).not.toContain("canary")
  expect(await f.storage.collections(f.root)).toEqual([])
  expect(await f.storage.knowledge(f.root)).toEqual([])
  expect(f.calls).toEqual([])
  for (let index = 0; index < 8; index++) await Bun.write(path.join(f.root, `docs/extra-${index}.md`), "Sample")
  const bounded = await f.api.preview({ kind: "folder", label: "Docs", location: "./docs" })
  expect(bounded.files).toBe(9)
  expect(bounded.samples).toHaveLength(5)
  expect(bounded.partial).toBe(true)
  expect(bounded.samples.every((sample) => sample.text.length <= 1500)).toBe(true)
})

test("last import results distinguish parsed, reused, empty, and failed documents", async () => {
  await using f = await fixture()
  const dir = path.join(f.root, "docs")
  await mkdir(dir)
  await Bun.write(path.join(dir, "guide.md"), "# Guide\nLease ownership policy.")
  await Bun.write(path.join(dir, "empty.txt"), " \n ")
  await Bun.write(path.join(dir, "broken.pdf"), "not a PDF")
  const item = await f.library.register({ kind: "folder", label: "Outcomes", location: dir })
  await f.library.approve(item.id)
  const first = await f.library.index(item.id)
  expect(first.result).toMatchObject({ state: "published", files: 3, extracted: 2, reused: 0, empty: 1, failed: 1 })
  expect(first.warnings.join("\n")).toContain("empty.txt: no extractable text")
  expect(first.warnings.join("\n")).toContain("broken.pdf: File is not a PDF")
  expect(first.result!.finished).toBeGreaterThanOrEqual(first.result!.started)
  const second = await f.library.index(item.id)
  expect(second.result).toMatchObject({ state: "published", files: 3, extracted: 0, reused: 2, empty: 1, failed: 1 })
  expect(second.warnings.join("\n")).toContain("empty.txt: no extractable text")
  expect((await f.storage.collection(f.root, item.id))?.result).toEqual(second.result)
  await f.library.stop(item.id)
  expect((await f.library.get(item.id)).result).toEqual(second.result)
  await f.library.purge(item.id)
  expect(await f.storage.collection(f.root, item.id)).toBeUndefined()
})

test("failed single-document imports retain unsuccessful run summaries", async () => {
  await using f = await fixture()
  const item = await f.library.register({ kind: "upload", label: "Invalid PDF", location: "broken.pdf", content: Buffer.from("invalid").toString("base64") })
  await f.library.approve(item.id)
  await expect(f.library.index(item.id)).rejects.toThrow("File is not a PDF")
  expect((await f.library.get(item.id)).result).toMatchObject({ state: "failed", files: 1, extracted: 0, reused: 0, failed: 1 })
})

test("directory depth exhaustion preserves prior evidence and recovers after excluding the subtree", async () => {
  await using f = await fixture()
  const dir = path.join(f.root, "docs")
  await mkdir(dir)
  await Bun.write(path.join(dir, "guide.md"), "Published ownership evidence.")
  const item = await f.library.register({ kind: "folder", label: "Depth", location: dir })
  await f.library.approve(item.id)
  const first = await f.library.index(item.id)
  const prior = await f.storage.knowledge(f.root)
  const boundary = path.join(dir, ...Array.from({ length: 20 }, () => "nested"))
  await mkdir(boundary, { recursive: true })
  await Bun.write(path.join(boundary, "boundary.md"), "Allowed at depth twenty.")
  expect((await f.library.index(item.id)).files).toBe(2)
  const saved = await f.storage.knowledge(f.root)
  const overflow = path.join(boundary, "overflow")
  await mkdir(overflow)
  await Bun.write(path.join(overflow, "too-deep.md"), "Unpublished deep evidence.")
  await expect(f.library.index(item.id)).rejects.toThrow("20 level directory depth limit")
  const failed = await f.library.get(item.id)
  expect(failed.state).toBe("failed")
  expect(failed.progress).toBeUndefined()
  expect(failed.result?.state).toBe("failed")
  const retained = await f.storage.knowledge(f.root)
  expect(retained.map((source) => source.id).sort()).toEqual(saved.map((source) => source.id).sort())
  expect(retained.every((source) => source.status === "unavailable")).toBe(true)
  expect(retained.some((source) => source.text.includes("Unpublished"))).toBe(false)
  await Bun.write(path.join(dir, ".gitignore"), "nested/\n")
  const recovered = await f.library.index(item.id)
  expect(recovered.state).toBe("ready")
  expect(recovered.files).toBe(1)
  expect(recovered.generation).toBe(first.generation)
  expect((await f.storage.knowledge(f.root)).map((source) => source.id).sort()).toEqual(prior.map((source) => source.id).sort())
})

test("discovery counts unsupported entries and prunes ignored subtrees before opening them", async () => {
  await using f = await fixture()
  const dir = path.join(f.root, "noise")
  await mkdir(dir)
  for (let offset = 0; offset < 20_000; offset += 100) {
    await Promise.all(Array.from({ length: 100 }, (_, index) => Bun.write(path.join(dir, `entry-${offset + index}.bin`), "")))
  }
  const item = await f.library.register({ kind: "folder", label: "Wide", location: dir })
  await f.library.approve(item.id)
  expect((await f.library.index(item.id)).state).toBe("ready")
  await Bun.write(path.join(dir, "overflow.bin"), "")
  await expect(f.library.index(item.id)).rejects.toThrow("20000 entry limit")
  expect((await f.library.get(item.id)).result?.state).toBe("failed")
  const parent = await f.library.register({ kind: "folder", label: "Pruned", location: f.root, exclude: ["noise/"] })
  await f.library.approve(parent.id)
  expect((await f.library.index(parent.id)).state).toBe("ready")
  const preview = await f.library.preview({ kind: "folder", label: "Pruned", location: f.root, exclude: ["noise/"] })
  expect(preview.partial).toBe(false)
  expect(preview.excluded).toBe(1)
  expect(preview.files).toBe(0)
}, 60_000)

test("discovery permission waits emit progress without exposing withheld paths", async () => {
  const gate = Promise.withResolvers<void>()
  const beat = Promise.withResolvers<void>()
  await using f = await fixture(undefined, async (item) => {
    if (item.location.endsWith("/private-canary")) { await gate.promise; throw new Error("Denied") }
  })
  await mkdir(path.join(f.root, "docs/private-canary"), { recursive: true })
  await Bun.write(path.join(f.root, "docs/private-canary/secret.md"), "Do not expose")
  const item = await f.library.register({ kind: "folder", label: "Permissions", location: path.join(f.root, "docs") })
  await f.library.approve(item.id)
  const off = f.storage.subscribe(f.root, () => {
    void f.library.get(item.id).then((value) => {
      const progress = value.progress
      if (progress?.stage === "discover" && progress.updated - (progress.started ?? progress.updated) >= 900) beat.resolve()
    })
  })
  const pending = f.library.index(item.id).then(() => "published", () => "cancelled")
  const timer = setTimeout(() => beat.reject(new Error("No discovery progress")), 5000)
  try {
    await beat.promise
    const progress = (await f.library.get(item.id)).progress!
    expect(progress.document).toBe("1 entries visited")
    expect(JSON.stringify(progress)).not.toContain("private-canary")
    gate.resolve()
    expect(await pending).toBe("published")
    const complete = await f.library.get(item.id)
    expect(complete.state).toBe("ready")
    expect(complete.progress).toBeUndefined()
    expect(complete.warnings).toContain("Some entries were withheld by Kilo permissions.")
    expect(JSON.stringify(complete)).not.toContain("private-canary")
  } finally { clearTimeout(timer); gate.resolve(); await pending; off() }
})

test.each(["complete", "pause"] as const)("slow extraction publishes awaited progress updates and settles on %s", async (mode) => {
  await using f = await fixture()
  const gate = Promise.withResolvers<void>()
  const beat = Promise.withResolvers<void>()
  const library = knowledge(f.root, f.storage, {
    extract: async (name, bytes, signal) => {
      const abort = () => gate.resolve()
      signal.addEventListener("abort", abort, { once: true })
      try { await gate.promise; signal.throwIfAborted(); return await extract(name, bytes, signal) }
      finally { signal.removeEventListener("abort", abort) }
    },
  })
  const item = await library.register({ kind: "text", label: "Slow import", location: "", content: "Lease ownership evidence." })
  await library.approve(item.id)
  const observed: number[] = []
  const off = f.storage.subscribe(f.root, () => {
    void library.get(item.id).then((value) => {
      const progress = value.progress
      if (progress?.stage !== "extract") return
      observed.push(progress.updated)
      if (progress.updated - (progress.started ?? progress.updated) >= 900) beat.resolve()
    })
  })
  const pending = library.index(item.id)
  const settled = pending.then(() => "complete", () => "cancelled")
  const timer = setTimeout(() => beat.reject(new Error("Extraction heartbeat was not published")), 5000)
  try {
    await beat.promise
    const progress = (await library.get(item.id)).progress!
    expect(progress.document).toBe("note.md")
    expect(progress.deadline! - progress.started!).toBe(30_000)
    expect(observed.at(-1)! - observed.at(0)!).toBeGreaterThanOrEqual(900)
    if (mode === "pause") await library.stop(item.id)
    gate.resolve()
    expect(await settled).toBe(mode === "pause" ? "cancelled" : "complete")
    const finished = await library.get(item.id)
    expect(finished.progress).toBeUndefined()
    expect(finished.state).toBe(mode === "pause" ? "paused" : "ready")
    expect(finished.result?.state).toBe(mode === "pause" ? "failed" : "published")
  } finally {
    clearTimeout(timer)
    gate.resolve()
    await settled
    off()
    await library.dispose()
  }
})

test("collection pages filter scope and search before limits and reset changed membership", async () => {
  await using f = await fixture()
  const template = await f.library.register({ kind: "text", label: "Template", location: "", content: "Reference" })
  await f.storage.purge(f.root, template.id)
  for (let index = 0; index < 135; index++) {
    await f.storage.save(f.root, { ...template, id: `record-${String(index).padStart(3, "0")}`, label: `Guide ${index}`, location: `/docs/${index}`, session: index < 30 ? "private" : "", state: index % 2 ? "removed" : "registered" })
  }
  await f.storage.save(`${f.root}-foreign`, { ...template, id: "foreign", label: "Foreign canary" })
  const first = await f.api.registry({ limit: 10, session: "chat" })
  expect(first.page).toEqual({ offset: 0, limit: 10, total: 105, next: 10 })
  expect(first.collections.at(0)?.id).toBe("record-030")
  const ids: string[] = []
  let offset = 0
  while (true) {
    const page = await f.api.registry({ limit: 10, offset, session: "chat", generation: first.generation })
    ids.push(...page.collections.map((item) => item.id))
    if (page.page.next == null) break
    offset = page.page.next
  }
  expect(ids).toHaveLength(105)
  expect(new Set(ids).size).toBe(105)
  expect(ids.at(-1)).toBe("record-134")
  expect((await f.api.registry({ session: "private" })).page.total).toBe(135)
  expect((await f.api.registry({ limit: 9999 })).collections).toHaveLength(100)
  expect((await f.api.registry({ query: "GUIDE 134" })).collections.map((item) => item.id)).toEqual(["record-134"])
  expect((await f.api.registry({ query: "/docs/134" })).page.total).toBe(1)
  expect((await f.api.registry({ query: "missing", offset: 999 })).page).toEqual({ offset: 0, limit: 100, total: 0 })
  const next = await f.api.registry({ limit: 10, offset: 10, generation: first.generation, session: "chat" })
  const item = next.collections.at(0)!
  await f.storage.save(f.root, { ...item, state: "paused", observed: Date.now() })
  expect((await f.api.registry({ limit: 10, offset: 10, generation: first.generation, session: "chat" })).page.offset).toBe(10)
  await f.storage.purge(f.root, item.id)
  expect((await f.api.registry({ limit: 10, offset: 10, generation: first.generation, session: "chat" })).page.offset).toBe(0)
  expect((await f.api.registry({ limit: 10, offset: 999 })).page.offset).toBe(100)
  expect(f.calls).toEqual([])
})

test("missing configured folders remain visible and recover only through explicit approval", async () => {
  await using f = await fixture()
  await mkdir(path.join(f.root, ".kilo"))
  await Bun.write(path.join(f.root, ".kilo/forge.jsonc"), JSON.stringify({ knowledge: { collections: [{ id: "offline", path: "./offline" }] } }))
  const local = await f.library.register({ kind: "text", label: "Local", location: "", content: "Available reference" })
  const first = await f.api.registry()
  expect(first.collections.map((item) => item.id)).toContain(local.id)
  expect(first.collections.find((item) => item.id === "config:offline")).toMatchObject({ state: "failed", approved: false, providers: [] })
  await mkdir(path.join(f.root, "offline"))
  await Bun.write(path.join(f.root, "offline/guide.md"), "# Offline reference\nPersistent source")
  await f.api.registry()
  expect((await f.library.get("config:offline")).approved).toBe(false)
  await f.library.approve("config:offline")
  await f.library.index("config:offline")
  expect((await f.library.get("config:offline")).state).toBe("ready")
  await rm(path.join(f.root, "offline"), { recursive: true })
  const missing = await f.api.registry()
  expect(missing.collections.find((item) => item.id === "config:offline")).toMatchObject({ state: "failed", approved: false, providers: [] })
  expect((await f.storage.knowledge(f.root)).every((item) => item.status === "unavailable")).toBe(true)
  expect(f.calls).toEqual([])
})

test("preview excludes denied children and does not hide a denied ignore policy", async () => {
  await using f = await fixture(undefined, async (item) => {
    if (item.location.includes("denied") || item.location.endsWith(".kilocodeignore")) throw new Error("Denied")
  })
  await Bun.write(path.join(f.root, "allowed.md"), "Visible")
  await Bun.write(path.join(f.root, "denied.md"), "private canary")
  const input = { kind: "folder" as const, label: "Docs", location: f.root }
  const preview = await f.api.preview(input)
  expect(preview.files).toBe(1)
  expect(JSON.stringify(preview)).not.toContain("denied.md")
  expect(JSON.stringify(preview)).not.toContain("private canary")
  expect(preview.warnings).toContain("Some entries were withheld by Kilo permissions.")
  const item = await f.library.register(input)
  await f.library.approve(item.id)
  await f.library.index(item.id)
  expect((await f.storage.view(f.root)).sources.some((source) => source.text.includes("private canary"))).toBe(false)
  await Bun.write(path.join(f.root, ".kilocodeignore"), "allowed.md")
  await expect(f.api.preview(input)).rejects.toThrow("ignore policy is denied")
  await expect(f.api.preview({ kind: "file", label: "Denied", location: path.join(f.root, "denied.md") })).rejects.toThrow("Denied")
})

test("preview reports parser failures and oversized samples without persistence", async () => {
  await using f = await fixture()
  const bad = await f.api.preview({ kind: "upload", label: "Bad PDF", location: "bad.pdf", content: Buffer.from("not a pdf").toString("base64") })
  expect(bad.warnings.length).toBeGreaterThan(0)
  const large = await f.api.preview({ kind: "text", label: "Large", location: "", content: "a".repeat(2 * 1024 * 1024 + 1) })
  expect(large.files).toBe(1)
  expect(large.samples).toEqual([])
  expect(large.partial).toBe(true)
  const controller = new AbortController()
  controller.abort(new Error("cancelled preview"))
  await expect(f.api.preview({ kind: "text", label: "Cancel", location: "", content: "sample" }, controller.signal)).rejects.toThrow("cancelled preview")
  await expect(f.api.preview({ kind: "url", label: "Private URL", location: "http://127.0.0.1/private" })).rejects.toThrow()
  expect(await f.storage.collections(f.root)).toEqual([])
})

test("routing grants reject legacy approvals, stale confirmations, and endpoint changes", async () => {
  const route = { fingerprint: "first-endpoint", origins: ["https://first.example"] }
  await using f = await fixture(async () => ({ ...route }))
  const item = await f.library.register({ kind: "text", label: "Policy", location: "", content: "The gamma ownership lease is private knowledge." })
  await expect(f.api.approve(item.id, "", ["approved-provider"])).rejects.toThrow("destination changed")
  await f.api.approve(item.id, "", ["approved-provider"], { "approved-provider": route.fingerprint })
  await f.library.index(item.id)
  const proposal = await f.api.enhance({ text: "Explain gamma ownership leases" })
  expect(proposal.context.matches.length).toBeGreaterThan(0)
  expect(await f.api.validate(proposal)).toBe(true)
  route.fingerprint = "second-endpoint"
  expect((await f.api.retrieve("gamma ownership lease")).matches).toEqual([])
  expect(await f.api.validate(proposal)).toBe(false)
  await expect(f.api.approve(item.id, "", ["approved-provider"], { "approved-provider": "first-endpoint" })).rejects.toThrow("destination changed")
  await f.api.approve(item.id, "", ["approved-provider"], { "approved-provider": route.fingerprint })
  await f.library.index(item.id)
  expect((await f.api.retrieve("gamma ownership lease")).matches.length).toBeGreaterThan(0)
  expect(await f.api.validate(proposal)).toBe(false)
  const current = await f.library.get(item.id)
  await f.storage.save(f.root, { ...current, grants: undefined })
  expect((await f.api.retrieve("gamma ownership lease")).matches).toEqual([])
  expect((await f.api.view()).sources.some((item) => item.text.includes("gamma ownership"))).toBe(true)
})

test("local approval and sharing revocation do not resolve an unavailable provider", async () => {
  const calls: string[] = []
  await using f = await fixture(undefined, async (_item, _session, providers) => {
    calls.push(JSON.stringify(providers))
  }, async () => { throw new Error("No providers are available") })
  const item = await f.api.register({ kind: "text", label: "Offline policy", location: "", content: "# Recovery\nOffline recovery requires the original journal." })
  const unapproved = await f.api.index(item.id).catch((error: unknown) => error)
  expect(String(unapproved)).toContain("Approve")
  const approved = await f.api.approve(item.id)
  expect(approved.approved).toBe(true)
  expect(approved.providers).toEqual([])
  await f.library.index(item.id)
  const view = await f.api.view({ query: "original journal" })
  expect(view.sources.some((source) => source.text.includes("original journal"))).toBe(true)
  expect(calls.length).toBeGreaterThan(0)
  expect(calls.every((value) => value === "[]")).toBe(true)
  expect(f.calls).toEqual([])
  // Existing grants can be revoked even after their provider is disabled.
  await f.storage.save(f.root, { ...await f.library.get(item.id), providers: ["old"], grants: { old: "old-route" } })
  expect(await f.api.approve(item.id)).toMatchObject({ approved: true, providers: [], grants: {} })
  const before = await f.library.get(item.id)
  const unavailable = await f.api.approve(item.id, "", ["old"], { old: "old-route" }).catch((error: unknown) => error)
  expect(String(unavailable)).toContain("No providers")
  expect(await f.library.get(item.id)).toEqual(before)
})

test("provider-free local approval still enforces local authorization", async () => {
  await using f = await fixture(undefined, async () => { throw new Error("Local access denied") }, async () => {
    throw new Error("Provider lookup must not run")
  })
  const item = await f.library.register({ kind: "text", label: "Denied", location: "", content: "Private original journal." })
  const denied = await f.api.approve(item.id).catch((error: unknown) => error)
  expect(String(denied)).toContain("Local access denied")
  expect((await f.library.get(item.id)).approved).toBe(false)
})

test("sharing cannot approve a provider other than the configured destination", async () => {
  await using f = await fixture()
  const item = await f.api.register({ kind: "text", label: "Policy", location: "", content: "Original journal." })
  const denied = await f.api.approve(item.id, "", ["other"]).catch((error: unknown) => error)
  expect(String(denied)).toContain("currently configured")
  expect((await f.library.get(item.id)).approved).toBe(false)
})

test("local indexing requires approval and provider sharing is enforced before retrieval", async () => {
  await using f = await fixture()
  const item = await f.library.register({ kind: "text", label: "Queue policy", location: "", content: "# Routing\nQueue assignments use a persistent ownership token." })
  expect(f.calls).toEqual([])
  await expect(f.library.index(item.id)).rejects.toThrow("Approve")
  await f.library.approve(item.id)
  await f.library.index(item.id)
  expect((await f.storage.knowledge(f.root)).length).toBeGreaterThan(0)
  const local = await f.api.view({ query: "persistent ownership token" })
  expect(local.sources.some((source) => source.text.includes("persistent ownership token"))).toBe(true)
  expect(local.sources.every((source) => source.text.length <= 500)).toBe(true)
  expect(f.calls).toEqual([])
  expect((await f.api.retrieve("persistent ownership token")).matches).toEqual([])
  await f.library.approve(item.id, "", ["approved-provider"])
  await f.library.index(item.id)
  const selected = await f.api.retrieve("persistent ownership token")
  expect(selected.matches.some((match) => match.source.detail.collection === item.id)).toBe(true)
  expect((await f.api.retrieve("persistent ownership token", { provider: "other-provider" })).matches).toEqual([])
  const proposal = await f.api.enhance({ text: "Apply the persistent ownership token policy" })
  expect(f.calls.at(0)).toContain("persistent ownership token")
  expect(await f.api.validate(proposal)).toBe(true)
  await f.library.stop(item.id)
  expect(await f.api.validate(proposal)).toBe(false)
})

test("session collections, persisted policies, and required pins share one enhancement pipeline", async () => {
  await using f = await fixture()
  const item = await f.library.register({ kind: "text", label: "Private policy", location: "", session: "chat", content: "The Zeta queue uses epoch leases to prevent stale writers." })
  await f.library.approve(item.id, "chat", ["approved-provider"])
  await f.library.index(item.id, "chat")
  expect((await f.api.retrieve("epoch leases", { session: "other" })).matches).toEqual([])
  const source = (await f.storage.knowledge(f.root, "chat")).find((item) => item.text)!
  const policy = await f.api.policy("chat")
  await f.api.configure({ ...policy, pin: [source.id] })
  await expect(f.api.configure({ ...policy, pin: [] })).rejects.toThrow("changed")
  const proposal = await f.api.enhance({ text: "Explain the code", session: "chat" })
  expect(proposal.context.matches.map((item) => item.source.id)).toContain(source.id)
  const captured = (await f.storage.request(f.root, "chat", proposal.id))!
  expect(captured.operation).toBe(proposal.id)
  expect(captured.selection).toEqual(proposal.context.audit)
  expect(captured.selection?.candidates.find((item) => item.source === source.id)).toMatchObject({ state: "selected", hash: source.hash })
  expect(JSON.stringify((await f.api.retrieve("epoch leases", { session: "other" })).audit)).not.toContain(source.id)
  expect(f.calls.at(0)).toContain("epoch leases")
  const current = await f.api.policy("chat")
  await f.api.configure({ ...current, pin: [], exclude: [source.id] })
  expect(await f.api.validate(proposal)).toBe(false)
  const excluded = await f.api.retrieve("epoch leases", { session: "chat" })
  expect(excluded.matches).toEqual([])
  expect(excluded.audit?.candidates.find((item) => item.source === source.id)).toMatchObject({ state: "omitted", reason: "Excluded by developer" })
  expect(await f.storage.request(f.root, "chat", proposal.id)).toEqual(captured)
})

test("selection history withholds child-denied source IDs instead of recording permission failures as omissions", async () => {
  await using f = await fixture(undefined, async (item, _session, providers) => {
    if (providers.length && item.kind === "file" && item.location.endsWith("blocked.md")) throw new Error("Denied file")
  })
  await mkdir(path.join(f.root, "docs"))
  await Bun.write(path.join(f.root, "docs/blocked.md"), "Restricted orchid lease reference is withheld.")
  const item = await f.api.register({ kind: "folder", label: "Restricted docs", location: "./docs" })
  await f.library.approve(item.id, "", ["approved-provider"])
  await f.library.index(item.id)
  const records = await f.storage.knowledge(f.root)
  expect(records.length).toBeGreaterThan(0)
  const selection = await f.api.retrieve("orchid lease reference")
  expect(selection.audit?.channels?.find((item) => item.name === "keyword")?.candidates).toBe(0)
  for (const record of records) expect(JSON.stringify(selection)).not.toContain(record.id)
  expect(selection.matches).toEqual([])
})

test.each(["permission", "stale"] as const)("preflight prevents %s documents from consuming the keyword candidate limit", async (mode) => {
  await using f = await fixture(undefined, async (item, _session, providers) => {
    if (mode === "permission" && providers.length && item.kind === "file" && item.location.endsWith("blocked.md")) throw new Error("Denied")
  })
  await mkdir(path.join(f.root, ".kilo"))
  await Bun.write(path.join(f.root, ".kilo/forge.jsonc"), JSON.stringify({ candidates: 1, exclude: [".kilo/forge.jsonc"] }))
  await mkdir(path.join(f.root, "manuals"))
  const blocked = path.join(f.root, "manuals/blocked.md")
  await Bun.write(blocked, "# Orchid lease\nOrchid lease orchid lease orchid lease.")
  await Bun.write(path.join(f.root, "manuals/allowed.md"), "# Maintenance\nOrchid dispatch guidance. " + "Additional background information. ".repeat(20))
  const item = await f.api.register({ kind: "folder", label: "Reference", location: "./manuals" })
  await f.library.approve(item.id, "", ["approved-provider"])
  await f.library.index(item.id)
  const raw = await f.storage.search(f.root, "orchid lease", 1, { provider: "approved-provider" })
  expect(raw.at(0)?.source.detail.document).toBe("blocked.md")
  if (mode === "stale") await Bun.write(blocked, "Replaced content.")
  const selected = await f.api.retrieve("orchid lease")
  expect(selected.matches).toHaveLength(1)
  expect(selected.matches.at(0)?.source.detail.document).toBe("allowed.md")
  expect(JSON.stringify(selected)).not.toContain(raw.at(0)!.source.id)
  const allowed = (await f.storage.knowledge(f.root)).filter((source) => source.detail.document === "allowed.md").map((source) => source.id)
  expect((await f.storage.search(f.root, "orchid lease", 1, { provider: "approved-provider", knowledge: allowed })).at(0)?.source.detail.document).toBe("allowed.md")
  expect(await f.storage.search(f.root, "orchid lease", 1, { provider: "approved-provider", knowledge: [] })).toEqual([])
})

test("preflight checks each document once per retrieval and cancellation starts no channels", async () => {
  const entered = Promise.withResolvers<void>()
  const gate = Promise.withResolvers<void>()
  const saved = Promise.withResolvers<void>()
  let waiting = false
  let checks = 0
  await using f = await fixture(undefined, async (item, _session, providers) => {
    if (!providers.length || item.kind !== "file") return
    checks++
    if (!waiting) return
    entered.resolve()
    await gate.promise
  })
  await mkdir(path.join(f.root, "manuals"))
  await Bun.write(path.join(f.root, "manuals/guide.md"), Array.from({ length: 20 }, (_, index) => `# Part ${index}\nLease ownership requires epoch validation.`).join("\n"))
  const item = await f.api.register({ kind: "folder", label: "Reference", location: "./manuals" })
  await f.library.approve(item.id, "", ["approved-provider"])
  await f.library.index(item.id)
  expect((await f.api.retrieve("zzqzx")).matches).toEqual([])
  expect(checks).toBe(1)
  expect((await f.api.retrieve("zzqzx")).matches).toEqual([])
  expect(checks).toBe(2)
  waiting = true
  const off = f.storage.subscribe(f.root, (event) => {
    if (event.topic !== "request") return
    void f.storage.manifests(f.root, { session: "chat" }).then((items) => {
      if (items.at(0)?.state === "failed") saved.resolve()
    })
  })
  const controller = new AbortController()
  const pending = f.api.lookup({ tool: "forge_search_docs", query: "epoch validation", session: "chat", signal: controller.signal }).then(() => undefined, (err) => err)
  const timeout = setTimeout(() => entered.reject(new Error("Preflight did not start")), 5000)
  try {
    await entered.promise
    const running = (await f.storage.manifests(f.root, { session: "chat" })).at(0)!
    expect(running.retrieval?.phase).toBe("setup")
    expect(running.retrieval?.channels.every((item) => item.state === "pending")).toBe(true)
    controller.abort(new Error("Cancel document preflight"))
    expect(await deadline(() => pending, undefined, 250)).toBeInstanceOf(Error)
    await deadline(() => saved.promise, undefined, 2000)
    const finished = (await f.storage.manifests(f.root, { session: "chat" })).at(0)!
    expect(finished.retrieval?.state).toBe("cancelled")
    expect(finished.retrieval?.channels.every((item) => item.state === "pending")).toBe(true)
    expect(finished.entries).toEqual([])
  } finally { clearTimeout(timeout); gate.resolve(); await pending; off() }
})

test.each(["permission", "stale", "pause"] as const)("selected documents are revalidated after %s changes during lookup", async (mode) => {
  let denied = false
  await using f = await fixture(undefined, async (item, _session, providers) => {
    if (denied && providers.length && item.kind === "file") throw new Error("Denied")
  })
  await mkdir(path.join(f.root, "manuals"))
  const file = path.join(f.root, "manuals/guide.md")
  await Bun.write(file, "# Lease ownership\nValidate the epoch before dispatch.")
  const item = await f.api.register({ kind: "folder", label: "Reference", location: "./manuals" })
  await f.library.approve(item.id, "", ["approved-provider"])
  await f.library.index(item.id)
  const entered = Promise.withResolvers<void>()
  const gate = Promise.withResolvers<void>()
  const search = f.storage.search.bind(f.storage)
  f.storage.search = async (...args) => {
    const result = await search(...args)
    entered.resolve()
    await gate.promise
    return result
  }
  const pending = f.api.retrieve("lease ownership")
  const timeout = setTimeout(() => entered.reject(new Error("Keyword lookup did not start")), 5000)
  try {
    await entered.promise
    if (mode === "permission") denied = true
    if (mode === "stale") await Bun.write(file, "Changed reference")
    if (mode === "pause") await f.library.stop(item.id)
    gate.resolve()
    expect((await pending).matches).toEqual([])
  } finally { clearTimeout(timeout); gate.resolve(); await pending }
})

test("document routing respects sharing, session scope, exclusions, and freshness", async () => {
  let denied = false
  await using f = await fixture(undefined, async (item, _session, providers) => {
    if (denied && providers.length && item.kind === "file") throw new Error("Denied")
  })
  await mkdir(path.join(f.root, ".kilo"))
  await Bun.write(path.join(f.root, ".kilo/forge.jsonc"), JSON.stringify({ routing: "domains" }))
  await mkdir(path.join(f.root, "manuals"))
  const file = path.join(f.root, "manuals/reference.md")
  await Bun.write(file, "# Lease ownership\nEpoch validation prevents stale writers.\n# Lease renewal\nRenew ownership before its deadline.")
  const item = await f.api.register({ kind: "folder", label: "Reference", location: "./manuals", session: "chat" })
  await f.library.approve(item.id, "chat")
  await f.library.index(item.id, "chat")
  expect((await f.api.retrieve("lease ownership", { session: "chat" })).matches).toEqual([])
  await f.library.approve(item.id, "chat", ["approved-provider"])
  await f.library.index(item.id, "chat")
  const selected = await f.api.retrieve("lease ownership", { session: "chat" })
  const routed = selected.audit!.candidates.filter((item) => item.channels?.some((channel) => channel.name === "domains"))
  expect(routed.length).toBeGreaterThan(0)
  const stored = await f.storage.knowledge(f.root, "chat")
  expect(routed.every((item) => stored.some((source) => source.id === item.source && source.method === "collection-section"))).toBe(true)
  expect(selected.matches.some((item) => item.source.text.includes("Epoch validation"))).toBe(true)
  expect((await f.api.retrieve("lease ownership", { session: "other" })).matches).toEqual([])
  expect((await f.api.retrieve("lease ownership", { session: "chat", provider: "other" })).matches).toEqual([])
  const excluded = await f.api.retrieve("lease ownership", { session: "chat", exclude: stored.map((item) => item.id) })
  expect(excluded.matches).toEqual([])
  expect(excluded.audit?.channels?.find((item) => item.name === "domains")?.candidates).toBe(0)
  denied = true
  const withheld = await f.api.retrieve("lease ownership", { session: "chat" })
  expect(withheld.matches).toEqual([])
  expect(withheld.audit?.channels?.find((item) => item.name === "domains")?.candidates).toBe(0)
  for (const source of stored) expect(JSON.stringify(withheld)).not.toContain(source.id)
  denied = false
  await Bun.write(file, "Replacement reference without the former requirements.")
  expect((await f.api.retrieve("lease ownership", { session: "chat" })).matches).toEqual([])
  await f.library.index(item.id, "chat")
  expect((await f.api.retrieve("lease ownership", { session: "chat" })).matches).toEqual([])
  await f.library.stop(item.id, "chat")
  expect((await f.api.retrieve("lease ownership", { session: "chat" })).matches).toEqual([])
  expect(f.calls).toEqual([])
})

test("section exclusions invalidate persisted routing briefs before domain scoring", async () => {
  await using f = await fixture()
  await mkdir(path.join(f.root, ".kilo"))
  await Bun.write(path.join(f.root, ".kilo/forge.jsonc"), JSON.stringify({ routing: "domains" }))
  const item = await f.library.register({ kind: "text", label: "Reference", location: "", content: "# Lease ownership\nEpoch rules.\n# Metrics\nCounter aggregation." })
  await f.library.approve(item.id, "", ["approved-provider"])
  await f.library.index(item.id)
  const sources = await f.storage.knowledge(f.root)
  const section = sources.find((source) => source.text.includes("Epoch rules"))!
  const parent = sources.find((source) => source.method === "collection-document")!
  expect(parent.detail.brief).toContain("Epoch rules")
  const before = await f.api.retrieve("lease ownership metrics")
  expect(before.audit?.channels?.find((channel) => channel.name === "domains")?.candidates).toBeGreaterThan(0)
  expect(before.audit?.candidates.some((candidate) => candidate.retrieval.includes("persisted brief"))).toBe(true)
  const after = await f.api.retrieve("lease ownership metrics", { exclude: [section.id] })
  expect(after.audit?.channels?.find((channel) => channel.name === "domains")?.candidates).toBe(0)
  expect(after.matches.some((match) => match.source.id === section.id || match.source.id === parent.id)).toBe(false)
  expect(after.text).not.toContain("Epoch rules")
  expect(f.calls).toEqual([])
})

test("registered repository documents cannot bypass collection sharing or session scope", async () => {
  await using f = await fixture()
  await mkdir(path.join(f.root, "docs"))
  await Bun.write(path.join(f.root, "docs/policy.md"), "Confidential gamma leases require rotating ownership.")
  expect((await f.api.retrieve("Confidential gamma leases")).matches.some((item) => item.source.text.includes("Confidential gamma"))).toBe(true)
  const item = await f.api.register({ kind: "folder", label: "Private docs", location: "./docs", session: "chat" })
  await f.library.approve(item.id, "chat")
  await f.library.index(item.id, "chat")
  expect((await f.api.retrieve("Confidential gamma leases", { session: "chat" })).matches.some((item) => item.source.text.includes("Confidential gamma"))).toBe(false)
  expect(JSON.stringify(await f.api.view({ session: "other" }))).not.toContain("Confidential gamma")
  await f.library.approve(item.id, "chat", ["approved-provider"])
  await f.library.index(item.id, "chat")
  expect((await f.api.retrieve("Confidential gamma leases", { session: "chat" })).matches.some((match) => match.source.detail.collection === item.id)).toBe(true)
  expect((await f.api.retrieve("Confidential gamma leases", { session: "other" })).matches.some((item) => item.source.text.includes("Confidential gamma"))).toBe(false)
})

test("folder indexing is incremental, independent of repository replacement, and rejects symlink escapes", async () => {
  await using f = await fixture()
  await mkdir(path.join(f.root, "docs"))
  await Bun.write(path.join(f.root, "docs/queue.md"), "# Queue\nQueue documents explain ownership leases.")
  await Bun.write(path.join(f.root, "secret.md"), "Secret outside registered folder")
  await symlink(path.join(f.root, "secret.md"), path.join(f.root, "docs/escape.md"))
  const item = await f.library.register({ kind: "folder", label: "Design", location: "./docs" })
  await f.library.approve(item.id, "", ["approved-provider"])
  await f.library.index(item.id)
  const prior = await f.storage.knowledge(f.root)
  expect(prior.some((source) => source.text.includes("Secret outside"))).toBe(false)
  await f.library.index(item.id)
  expect(await f.storage.knowledge(f.root)).toEqual(prior)
  await f.api.refresh(true)
  expect(await f.storage.knowledge(f.root)).toEqual(prior)
  const source = prior.find((source) => source.text)!
  await Bun.write(path.join(f.root, "docs/queue.md"), "Ownership leases were replaced.")
  expect(await f.library.fresh(source)).toBe(false)
  await f.library.index(item.id)
  expect((await f.storage.knowledge(f.root)).some((source) => source.text.includes("were replaced"))).toBe(true)
  await rm(path.join(f.root, "docs/queue.md"))
  await f.library.index(item.id)
  expect(await f.storage.knowledge(f.root)).toEqual([])
})

test("registered knowledge is not truncated at the external cache's 500 record limit", async () => {
  await using f = await fixture()
  const text = Array.from({ length: 550 }, (_, index) => `# Section ${index}\nEvidence ${index}: ownership leases require review.`).join("\n")
  const item = await f.library.register({ kind: "text", label: "Reference", location: "", content: text })
  await f.library.approve(item.id)
  await f.library.index(item.id)
  const sources = await f.storage.knowledge(f.root)
  expect(sources.length).toBeGreaterThan(500)
  expect(sources.some((source) => source.text.includes("Evidence 549"))).toBe(true)
  expect((await f.api.status()).inventory.counts.document).toBe(sources.length)
})

test("configuration cannot self-approve external paths or retain approval after policy edits", async () => {
  await using f = await fixture()
  await mkdir(path.join(f.root, ".kilo"))
  await mkdir(path.join(f.root, "docs"))
  await Bun.write(path.join(f.root, "docs/policy.md"), "Policy evidence")
  await Bun.write(path.join(f.root, ".kilo/forge.jsonc"), JSON.stringify({ knowledge: { collections: [{ id: "docs", path: "./docs", watch: false }] } }))
  await f.library.sync(await config(f.root))
  expect((await f.library.get("config:docs")).approved).toBe(false)
  await f.library.approve("config:docs", "", ["approved-provider"])
  await f.library.index("config:docs")
  await Bun.write(path.join(f.root, ".kilo/forge.jsonc"), JSON.stringify({ knowledge: { collections: [{ id: "docs", path: "./docs", exclude: ["policy.md"] }] } }))
  await f.library.sync(await config(f.root))
  expect((await f.library.get("config:docs")).approved).toBe(false)
  expect((await f.storage.knowledge(f.root)).every((source) => source.status === "unavailable")).toBe(true)
})

test("network policy rejects local and reserved destinations before connecting", async () => {
  for (const address of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "::1", "::ffff:127.0.0.1", "fc00::1", "2001:db8::1", "100.64.0.1", "224.0.0.1"]) expect(publicAddress(address)).toBe(false)
  expect(publicAddress("8.8.8.8")).toBe(true)
  expect(publicAddress("2606:4700:4700::1111")).toBe(true)
  await expect(download("http://127.0.0.1/file", AbortSignal.timeout(1000))).rejects.toThrow("private")
  await expect(download("https://user:password@example.com/file", AbortSignal.timeout(1000))).rejects.toThrow("credentials")
})

test("UI and configuration reuse one canonical folder registration without granting approval", async () => {
  await using f = await fixture()
  await mkdir(path.join(f.root, "docs"))
  await mkdir(path.join(f.root, ".kilo"))
  const item = await f.library.register({ kind: "folder", label: "Design", location: "./docs", exclude: ["private/**"] })
  await Bun.write(path.join(f.root, ".kilo/forge.jsonc"), JSON.stringify({ knowledge: { collections: [{ id: "docs", path: "./docs", exclude: [] }] } }))
  await f.library.sync(await config(f.root))
  const items = await f.storage.collections(f.root)
  expect(items).toHaveLength(1)
  expect(items.at(0)?.id).toBe(item.id)
  expect(items.at(0)?.approved).toBe(false)
  expect(items.at(0)?.exclude).toEqual(["private/**"])
  expect(items.at(0)?.warnings.join(" ")).toContain("original scope")
})

test("purge clears copied summaries and captures without resurrecting them on repository refresh", async () => {
  await using f = await fixture()
  const item = await f.library.register({ kind: "text", label: "Purge", location: "", content: "Purge canary ownership policy." })
  await f.library.approve(item.id, "", ["approved-provider"])
  await f.library.index(item.id)
  const passage = (await f.storage.knowledge(f.root)).find((item) => item.text)!
  await f.storage.external(f.root, source("summary:copied", "Purge canary ownership policy.", "summary"))
  await f.api.refresh()
  await f.api.enhance({ text: "ownership policy" })
  expect((await f.storage.manifests(f.root)).length).toBeGreaterThan(0)
  await f.api.purge(item.id)
  expect(await f.storage.manifests(f.root)).toEqual([])
  expect(await f.storage.contents(f.root, item.id)).toBeUndefined()
  expect(await f.storage.source(f.root, passage.id)).toBeUndefined()
  expect(await f.storage.retired(f.root, passage.id)).toBe(true)
  expect((await f.api.refresh()).sources.some((item) => item.text.includes("Purge canary"))).toBe(false)
})

test("PDF extraction preserves pages and chunk IDs remain unique for very long lines", async () => {
  const text = "BT /F1 12 Tf 72 720 Td (Queue ownership policy) Tj ET"
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${text.length} >>\nstream\n${text}\nendstream`]
  let pdf = "%PDF-1.4\n"
  const offsets = [0]
  for (const [index, object] of objects.entries()) { offsets.push(pdf.length); pdf += `${index + 1} 0 obj\n${object}\nendobj\n` }
  const xref = pdf.length
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
  const pages = await extract("policy.pdf", new TextEncoder().encode(pdf), AbortSignal.timeout(10_000))
  expect(pages.at(0)?.text).toContain("Queue ownership policy")
  expect(pages.at(0)?.page).toBe(1)
  const collection: Collection = { id: "test", label: "Policy", kind: "text", location: "", session: "", origin: "interface", include: [], exclude: [], watch: false, approved: true, providers: [], state: "ready", observed: 0, generation: "", files: 1, chunks: 0, warnings: [] }
  const sources = chunks(collection, "policy.md", new Uint8Array(), [{ text: "abc ".repeat(5000) }])
  expect(new Set(sources.map((source) => source.id)).size).toBe(sources.length)
  await expect(extract("invalid.pdf", new TextEncoder().encode("not a PDF"), AbortSignal.timeout(1000))).rejects.toThrow("not a PDF")
})
