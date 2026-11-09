import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { engine, type Ports } from "../src/engine"
import { select } from "../src/context"
import { source } from "../src/parse"
import { usage, decode, Proposal, type Source, type Semantic, type EnhancementProgress } from "../src/schema"
import { store } from "../src/store"
import { deadline } from "../src/deadline"
import { EnhancementError, failure } from "../src/enhancement"
import { setImmediate as immediate } from "node:timers/promises"

function proposal(item: Source): Proposal {
  return {
    id: "fixture",
    original: "Explain the queue",
    generation: "fixture",
    status: "ready",
    task: {
      objective: "Explain the queue",
      reuse: [],
      inspect: [],
      changes: [],
      constraints: [],
      hypotheses: [],
      questions: [],
      acceptance: [],
      verification: [],
      evidence: [item.id],
    },
    context: select([{ source: item, score: 1, reason: "fixture" }], 2400),
    prompt: "Explain the queue",
    usage: usage(),
    warnings: [],
  }
}

async function setup(complete?: Ports["complete"], opts: Partial<Ports> = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "forge-engine-test-")))
  const db = new Database(":memory:")
  const storage = store({
    all: async (query) =>
      db.query<Record<string, unknown>, (string | number | null)[]>(query.text).all(...(query.values ?? [])),
    batch: async (queries) => {
      db.transaction(() => {
        for (const query of queries) db.query(query.text).run(...(query.values ?? []))
      })()
    },
  })
  const api = engine({
    ...opts,
    root,
    store: storage,
    complete:
      complete ??
      (async () => {
        throw new Error("Validation must not call a model")
      }),
  })
  await writeFile(path.join(root, "queue.ts"), "export const queue = ['waiting']")
  return {
    root,
    db,
    storage,
    api,
    async close() {
      await api.dispose()
      db.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}

test("watcher events during the initial scan are reconciled before refresh completes", async () => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let calls = 0
  const fixture = await setup(undefined, { history: async () => {
    calls++
    if (calls === 1) { entered.resolve(); await release.promise }
    return []
  } })
  const changed = Promise.withResolvers<void>()
  let ready = false
  const unsubscribe = fixture.storage.subscribe(fixture.root, (event) => { if (ready && event.topic === "job") changed.resolve() })
  try {
    await mkdir(path.join(fixture.root, ".kilo"))
    await writeFile(path.join(fixture.root, ".kilo/forge.jsonc"), '{"history":true}')
    const pending = fixture.api.refresh()
    await entered.promise
    ready = true
    await writeFile(path.join(fixture.root, "queue.ts"), "export function reconciled() { return true }")
    await changed.promise
    release.resolve()
    const snapshot = await pending
    expect(calls).toBeGreaterThanOrEqual(2)
    expect(snapshot.sources.some((item) => item.label === "reconciled")).toBe(true)
    expect((await fixture.storage.search(fixture.root, "reconciled")).length).toBeGreaterThan(0)
  } finally { release.resolve(); unsubscribe(); await fixture.close() }
})

test("explicit enhancement models remain request-scoped during concurrent generations and acceptance", async () => {
  const calls: Array<Parameters<Ports["complete"]>[0]> = []
  const cfg = { provider: "default" }
  const fixture = await setup(async (input) => {
    calls.push(input)
    const model = input.model!
    return {
      text: JSON.stringify({ objective: "Improve queue", reuse: [], inspect: [], changes: [], constraints: [], hypotheses: [], questions: [], acceptance: [], verification: [], evidence: [] }),
      usage: { ...usage(`${model.providerID}/${model.modelID}`), measured: true }, finish: "stop",
    }
  }, {
    provider: async () => cfg.provider,
    resolve: async (model) => model ?? { providerID: cfg.provider, modelID: "small" },
    destination: async (provider) => ({ fingerprint: `route-${provider}`, origins: [] }),
  })
  try {
    const models = [{ providerID: "first", modelID: "large" }, { providerID: "second", modelID: "special" }]
    const proposals = await Promise.all(models.map((model) => fixture.api.enhance({ text: "Improve queue", session: model.providerID, model })))
    expect(calls).toHaveLength(2)
    for (const item of proposals) {
      expect(item.context.provider).toBe(item.model?.providerID)
      expect(item.context.destination).toBe(`route-${item.model?.providerID}`)
      expect(item.usage.model).toBe(`${item.model?.providerID}/${item.model?.modelID}`)
      expect(calls.find((call) => call.session === item.session)?.model).toEqual(item.model)
      expect(await fixture.api.validate(item)).toBe(true)
    }
    cfg.provider = "changed-default"
    for (const item of proposals) expect(await fixture.api.validate(item)).toBe(true)
    expect(calls).toHaveLength(2)
    const legacy = await fixture.api.enhance({ text: "Improve queue" })
    expect(legacy.model).toEqual({ providerID: "changed-default", modelID: "small" })
  } finally { await fixture.close() }
})

test("authoritative edits affect retrieval and the staged prompt while retry guidance stays format-only", async () => {
  const calls: Array<Parameters<Ports["complete"]>[0]> = []
  const queries: string[] = []
  const fixture = await setup(async (input) => {
    calls.push(input)
    return { text: JSON.stringify({ objective: "Improve queue", reuse: [], inspect: [], changes: [], constraints: [], hypotheses: [], questions: [], acceptance: [], verification: [], evidence: [] }), usage: usage(), finish: "stop" }
  }, { memory: async (query) => { queries.push(query); return [] } })
  try {
    const edits = [{ before: "Include screenshots", after: "No screenshots. Support offline usage." }]
    const result = await fixture.api.enhance({
      text: "Include screenshots. Preserve compatibility.", answers: "Use the existing public API.",
      feedback: "Make wording concise.", edits, revision: "AI proposal: add a hosted service",
      retry: [{ path: ["verification"], expected: "array", actual: "missing" }], session: "developer",
    })
    expect(queries.some((query) => query.includes("Support offline usage"))).toBe(true)
    expect(result.prompt).toContain("No screenshots. Support offline usage.")
    expect(result.prompt).toContain("Preserve compatibility.")
    expect(result.prompt).toContain("Use the existing public API.")
    expect(calls.at(0)?.prompt).toContain("Previous proposed prompt (non-authoritative)")
    expect(calls.at(0)?.system).toContain("Response-format correction for this explicit retry")
    expect(calls.at(0)?.system).toContain("verification: missing")
    expect(result.prompt).not.toContain("Response-format correction")
    expect(calls).toHaveLength(1)
  } finally { await fixture.close() }
})

test.each(["cancelled", "timeout"] as const)("%s non-cooperative generation finalizes failure and cannot accept its late result", async (code) => {
  const entered = Promise.withResolvers<AbortSignal>()
  const release = Promise.withResolvers<Awaited<ReturnType<Ports["complete"]>>>()
  const fixture = await setup((input) => {
    if (!input.signal) throw new Error("Expected generation cancellation signal")
    entered.resolve(input.signal)
    return release.promise
  })
  try {
    const controller = new AbortController()
    const result = fixture.api.enhance({ text: "Improve queue", signal: controller.signal })
    const signal = await entered.promise
    const error = code === "timeout" ? new EnhancementError("Generation deadline exceeded", failure(code)) : new Error("Developer cancelled")
    controller.abort(error)
    expect(await result.catch((err: unknown) => err)).toBe(error)
    expect(signal.aborted).toBe(true)
    await fixture.api.dispose()
    const history = await fixture.api.manifests()
    expect(history.at(0)?.state).toBe("failed")
    expect(history.at(0)?.failure?.code).toBe(code)
    expect(history.at(0)?.usage.measured).toBe(false)
    release.resolve({ text: "{}", usage: { ...usage("late"), measured: true }, finish: "stop" })
    await release.promise
    await immediate()
    expect((await fixture.api.manifests()).at(0)?.state).toBe("failed")
    expect((await fixture.api.manifests()).at(0)?.usage.measured).toBe(false)
  } finally {
    release.resolve({ text: "{}", usage: usage() })
    await fixture.close()
  }
})

test("validation deadline releases a non-cooperative model resolver and rejects its late result", async () => {
  const entered = Promise.withResolvers<void>()
  const gate = Promise.withResolvers<{ providerID: string; modelID: string }>()
  const model = { providerID: "local", modelID: "selected" }
  const state = { held: false }
  const fixture = await setup(async () => ({
    text: JSON.stringify({ objective: "Improve queue", reuse: [], inspect: [], changes: [], constraints: [], hypotheses: [], questions: [], acceptance: [], verification: [], evidence: [] }),
    usage: usage("local/selected"),
  }), {
    resolve: async () => {
      if (!state.held) return model
      entered.resolve()
      return gate.promise
    },
  })
  try {
    const proposal = await fixture.api.enhance({ text: "Improve queue", model })
    state.held = true
    const error = new EnhancementError("Validation deadline exceeded", failure("timeout"))
    const result = deadline((signal) => fixture.api.validate(proposal, signal), undefined, 100, error)
    await deadline(() => entered.promise, undefined, 1000)
    expect(await result.catch((err: unknown) => err)).toBe(error)
    gate.resolve(model)
    await gate.promise
    await immediate()
    expect(await result.catch((err: unknown) => err)).toBe(error)
    expect((await fixture.api.manifests()).at(0)?.state).toBe("completed")
  } finally {
    gate.resolve(model)
    await fixture.close()
  }
})

test("failed preparation preserves recorded transport attempts and usage", async () => {
  const fixture = await setup(async (input) => {
    const manifest = (await fixture.storage.request(fixture.root, "", input.request))!
    await fixture.storage.manifest({
      ...manifest, usage: { ...usage("local"), input: 42 },
      attempts: [{ id: "failed-attempt", sequence: 1, started: 1, finished: 2, state: "response", status: 503, membership: "matched", sent: [] }],
      coverage: ["Recorded transport failure"],
    })
    throw new Error("Provider unavailable")
  })
  try {
    await expect(fixture.api.enhance({ text: "Inspect queue" })).rejects.toThrow("Provider unavailable")
    const captured = (await fixture.api.manifests()).at(0)!
    expect(captured.state).toBe("failed")
    expect(captured.attempts?.at(0)?.status).toBe(503)
    expect(captured.usage.input).toBe(42)
    expect(captured.coverage).toContain("Recorded transport failure")
  } finally { await fixture.close() }
})

test.each(["retrieval", "response"] as const)("failed %s retains an operation without inventing missing selection stages", async (stage) => {
  const fixture = await setup(async () => ({ text: "Invalid structured task", usage: { ...usage("local"), input: 7 } }))
  try {
    await expect(fixture.api.enhance({ text: "Inspect queue", ...(stage === "retrieval" ? { pin: ["missing-pin"] } : {}) })).rejects.toThrow()
    const captured = (await fixture.api.manifests()).at(0)!
    expect(captured.operation).toBe(captured.id)
    expect(captured.state).toBe("failed")
    if (stage === "retrieval") {
      expect(captured.selection).toBeUndefined()
      expect(captured.entries).toEqual([])
      expect(captured.coverage.join(" ")).toContain("no candidate stages are inferred")
      return
    }
    expect(captured.selection?.candidates.length).toBeGreaterThan(0)
    expect(captured.entries.length).toBeGreaterThan(0)
    expect(captured.usage.input).toBe(7)
  } finally { await fixture.close() }
})

test.each(["enhance", "tool"] as const)("%s retains completed channel work after cancellation without accepting late results", async (kind) => {
  const fixture = await setup()
  const saved = Promise.withResolvers<void>()
  const finished = Promise.withResolvers<void>()
  const gate = Promise.withResolvers<Source[]>()
  const controller = new AbortController()
  const api = engine({
    root: fixture.root,
    store: {
      ...fixture.storage,
      async manifest(value) {
        await fixture.storage.manifest(value)
        if (value.state === "failed") finished.resolve()
        if (value.retrieval?.channels.some((item) => item.name === "keyword" && item.state === "completed")
          && value.retrieval.channels.some((item) => item.name === "semantic" && item.state === "running")) saved.resolve()
      },
    },
    complete: async () => { throw new Error("No provider request should run") },
    semantic: async () => (await gate.promise).map((source) => ({ source, score: 1, reason: "late" })),
    memory: async () => [],
    docs: async () => [],
  })
  try {
    await api.refresh()
    const pending = kind === "enhance" ? api.enhance({ text: "Inspect queue", session: "private", signal: controller.signal })
      : api.lookup({ tool: "forge_search_docs", query: "queue", call: "call", message: "message", session: "private", signal: controller.signal })
    const failed = pending.then(() => undefined, (err) => err)
    await saved.promise
    expect((await api.manifests({ session: "private" })).at(0)?.state).toBe("retrieving")
    controller.abort(new Error("Stop waiting"))
    expect(await failed).toBeInstanceOf(Error)
    await deadline(() => finished.promise, undefined, 2000)
    const manifest = (await api.manifests({ session: "private" })).at(0)!
    expect(manifest.state).toBe("failed")
    expect(manifest.retrieval).toMatchObject({ state: "cancelled", phase: "channels" })
    expect(manifest.retrieval?.generation).toBe(manifest.generation)
    expect(manifest.generation).not.toBe("unindexed")
    expect(manifest.retrieval?.channels.find((item) => item.name === "keyword")?.state).toBe("completed")
    expect(manifest.retrieval?.channels.find((item) => item.name === "semantic")?.state).toBe("abandoned")
    expect(manifest.selection).toBeUndefined()
    expect(manifest.entries).toEqual([])
    expect(manifest.attempts).toEqual([])
    expect(await api.request(manifest.id, "other")).toBeUndefined()
    gate.resolve([source("late.ts", "private late canary", "code")])
    await immediate()
    expect(await api.request(manifest.id, "private")).toEqual(manifest)
    expect(JSON.stringify(manifest)).not.toContain("private late canary")
  } finally { gate.resolve([]); await api.dispose(); await fixture.close() }
})

test("failed selection retains channel execution without inventing selected evidence", async () => {
  const fixture = await setup()
  try {
    const failure = await fixture.api.enhance({ text: "Inspect queue", pin: ["missing-pin"] }).then(() => undefined, (err) => err)
    expect(failure).toBeInstanceOf(Error)
    const manifest = (await fixture.api.manifests()).at(0)!
    expect(manifest.retrieval).toMatchObject({ state: "failed", phase: "selection" })
    expect(manifest.retrieval?.channels.find((item) => item.name === "keyword")?.state).toBe("completed")
    expect(manifest.entries).toEqual([])
    expect(manifest.selection).toBeUndefined()
    expect(manifest.attempts).toEqual([])
  } finally { await fixture.close() }
})

test("purging a collection cannot resurrect an in-flight retrieval journal", async () => {
  const fixture = await setup()
  const saved = Promise.withResolvers<void>()
  const gate = Promise.withResolvers<void>()
  const api = engine({
    root: fixture.root,
    store: {
      ...fixture.storage,
      async manifest(value) {
        await fixture.storage.manifest(value)
        if (value.retrieval?.channels.some((item) => item.name === "semantic" && item.state === "running")) saved.resolve()
      },
    },
    complete: async () => { throw new Error("No provider request should run") },
    semantic: async () => { await gate.promise; return [] },
  })
  try {
    const collection = await api.register({ kind: "text", label: "Purge target", location: "", content: "purge target" })
    await api.refresh()
    const failed = api.enhance({ text: "Inspect queue", session: "private" }).then(() => undefined, (err) => err)
    await saved.promise
    await fixture.storage.purge(fixture.root, collection.id)
    gate.resolve()
    expect(await failed).toBeInstanceOf(Error)
    await immediate()
    expect(await api.manifests({ session: "private" })).toEqual([])
  } finally { gate.resolve(); await api.dispose(); await fixture.close() }
})

test("selection records sources changed between retrieval and freshness validation as omitted", async () => {
  const fixture = await setup()
  const api = engine({
    root: fixture.root, store: fixture.storage,
    complete: async () => { throw new Error("No model needed") },
    semantic: async () => {
      await writeFile(path.join(fixture.root, "queue.ts"), "export const queue = ['updated after retrieval']")
      return []
    },
  })
  try {
    const value = await api.retrieve("queue waiting")
    expect(value.matches).toEqual([])
    expect(value.audit?.candidates.some((item) => item.reason === "Source changed or is unavailable" && item.state === "omitted")).toBe(true)
  } finally { await api.dispose(); await fixture.close() }
})

test("clarification terms reach retrieval while the original request stays intact", async () => {
  const fixture = await setup()
  const queries: string[] = []
  await writeFile(path.join(fixture.root, "ledger.ts"), "export const zirconiumLedger = 'zirconium epoch leases'")
  const api = engine({
    root: fixture.root, store: fixture.storage,
    semantic: async (query) => { queries.push(query); return [] },
    complete: async () => ({
      text: JSON.stringify({ objective: "Inspect queue and ledger", reuse: [], inspect: [], changes: [], constraints: [], hypotheses: [], questions: [], acceptance: [], verification: [], evidence: [] }),
      usage: usage("fixture"),
    }),
  })
  try {
    const proposal = await api.enhance({ text: "Inspect queue.", answers: "Check zirconiumLedger epoch leases." })
    expect(queries).toEqual(["Inspect queue.\n\nCheck zirconiumLedger epoch leases."])
    expect(proposal.original).toBe("Inspect queue.")
    expect(proposal.prompt).toContain("Developer clarifications:\nCheck zirconiumLedger epoch leases.")
    expect(proposal.context.matches.some((item) => item.source.uri === "ledger.ts")).toBe(true)
  } finally { await api.dispose(); await fixture.close() }
})

test("preparation persists pre-fusion channel hits and distinguishes fusion from budget omissions", async () => {
  const fixture = await setup()
  await mkdir(path.join(fixture.root, ".kilo"))
  await writeFile(path.join(fixture.root, ".kilo/forge.jsonc"), JSON.stringify({ candidates: 1, budget: 2000 }))
  await writeFile(path.join(fixture.root, "ledger.ts"), "export const ledger = 'epoch lease'")
  const api = engine({
    root: fixture.root, store: fixture.storage,
    semantic: async () => {
      const snapshot = await fixture.storage.snapshot(fixture.root)
      const item = snapshot!.sources.find((item) => item.method === "file" && item.uri === "ledger.ts")!
      return [{ source: item, score: 0.95, reason: "Semantic lease match" }]
    },
    complete: async () => ({
      text: JSON.stringify({ objective: "Inspect queue", reuse: [], inspect: [], changes: [], constraints: [], hypotheses: [], questions: [], acceptance: [], verification: [], evidence: [] }),
      usage: usage("fixture"),
    }),
  })
  try {
    const proposal = await api.enhance({ text: "queue waiting" })
    const audit = proposal.context.audit!
    expect(proposal.context.matches.length).toBeLessThanOrEqual(1)
    expect(audit.candidates.length).toBeGreaterThan(1)
    expect(audit.candidates.some((item) => item.state === "omitted" && item.reason === "Outside fused candidate limit")).toBe(true)
    expect(audit.candidates.flatMap((item) => item.channels ?? []).some((item) => item.name === "semantic" && item.score === 0.95 && item.rank === 1)).toBe(true)
    expect(audit.channels?.find((item) => item.name === "keyword")?.state).toBe("completed")
    expect(audit.channels?.find((item) => item.name === "domains")?.state).toBe("disabled")
    expect((await api.request(proposal.id))?.selection).toEqual(audit)
    expect(JSON.stringify(audit)).not.toContain("export const ledger")
  } finally { await api.dispose(); await fixture.close() }
})

test("channel history distinguishes failed adapters, keyword fallback, and disabled channels", async () => {
  const fixture = await setup()
  const api = engine({
    root: fixture.root, store: fixture.storage,
    complete: async () => { throw new Error("No model needed") },
    semantic: async () => { throw new Error("Semantic offline") },
    memory: async () => { throw new Error("Memory offline") },
    docs: async () => { throw new Error("Docs offline") },
  })
  try {
    await api.refresh()
    fixture.db.run("DROP TABLE forge_search")
    const result = await api.retrieve("queue", { session: "chat", docs: true })
    expect(result.matches.length).toBeGreaterThan(0)
    expect(result.audit?.channels?.map((item) => [item.name, item.state])).toEqual([
      ["keyword", "fallback"], ["semantic", "failed"], ["collection-semantic", "disabled"], ["domains", "disabled"],
      ["memory", "failed"], ["relationships", "completed"], ["public-docs", "disabled"], ["dependency-docs", "failed"],
    ])
    expect(result.audit?.candidates.some((item) => item.channels?.some((channel) => channel.reason === "Bounded content fallback"))).toBe(true)
    const lookup = await api.lookup({ tool: "forge_search_docs", query: "queue", session: "chat" })
    const captured = await api.request(lookup.request, "chat")
    expect(captured?.retrieval?.state).toBe("completed")
    expect(captured?.retrieval?.channels.map((item) => [item.name, item.state])).toEqual(result.audit?.channels?.map((item) => [item.name, item.state]))
  } finally { await api.dispose(); await fixture.close() }
})

test.each(["uninitialized", "initializing", "disabled", "error", "ready", "indexing", "paused", "unknown"] as const)("semantic %s readiness is read-only and retained with lookup history", async (state) => {
  const fixture = await setup()
  const observed: Semantic = { state, ...(state === "unknown" ? {} : { searchable: ["ready", "indexing", "paused"].includes(state) }) }
  let calls = 0
  const api = engine({
    root: fixture.root, store: fixture.storage, readiness: () => observed,
    complete: async () => { throw new Error("No model needed") },
    semantic: async () => { calls++; return [] },
  })
  try {
    const status = await api.status()
    expect(status.semantic).toEqual(observed)
    expect(status.inventory.indexed).toBe(false)
    expect(calls).toBe(0)
    const result = await api.retrieve("queue")
    expect(result.matches.length).toBeGreaterThan(0)
    expect(calls).toBe(observed.searchable === false ? 0 : 1)
    expect(result.audit?.channels?.find((item) => item.name === "semantic")).toMatchObject({
      readiness: observed, candidates: 0,
      state: observed.searchable !== false ? "completed" : state === "disabled" ? "disabled" : state === "error" ? "failed" : "unavailable",
    })
  } finally { await api.dispose(); await fixture.close() }
})

test("semantic observations are captured before lookup and inspection failure remains unknown", async () => {
  const fixture = await setup()
  const observed: { state: Semantic["state"]; searchable: boolean } = { state: "indexing", searchable: true }
  let failed = false
  const warnings: string[] = []
  const api = engine({
    root: fixture.root, store: fixture.storage,
    complete: async () => { throw new Error("No model needed") },
    readiness: () => { if (failed) throw new Error("Private canary"); return observed },
    semantic: async () => { observed.state = "ready"; return [] },
    warn: (text) => warnings.push(text),
  })
  try {
    const result = await api.retrieve("queue")
    expect(result.audit?.channels?.find((item) => item.name === "semantic")?.readiness?.state).toBe("indexing")
    expect((await api.status()).semantic?.state).toBe("ready")
    failed = true
    expect((await api.status()).semantic).toEqual({ state: "unknown" })
    expect(warnings).toContain("Semantic readiness could not be inspected.")
    expect(warnings.join(" ")).not.toContain("Private canary")
  } finally { await api.dispose(); await fixture.close() }
})

test("unmapped semantic and other-session memory hits contribute counts without identities", async () => {
  const fixture = await setup()
  const hidden = source("private:canary", "Private channel canary", "document", { method: "kilo-memory-recall", detail: { session: "other" } })
  const api = engine({
    root: fixture.root, store: fixture.storage,
    complete: async () => { throw new Error("No model needed") },
    semantic: async () => [{ source: hidden, score: 1, reason: "Private semantic reason" }],
    memory: async () => [hidden],
  })
  try {
    const result = await api.retrieve("queue", { session: "chat" })
    for (const name of ["semantic", "memory"]) expect(result.audit?.channels?.find((item) => item.name === name)).toMatchObject({ state: "completed", candidates: 0, withheld: 1 })
    expect(JSON.stringify(result.audit)).not.toContain(hidden.id)
    expect(JSON.stringify(result.audit)).not.toContain("canary")
    expect(JSON.stringify(result.audit)).not.toContain("Private semantic reason")
  } finally { await api.dispose(); await fixture.close() }
})

test.each(["complete", "cancel"] as const)("independent lookup channels start together and %s without accepting late results", async (mode) => {
  const fixture = await setup()
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const settled = Promise.withResolvers<void>()
  const signals: AbortSignal[] = []
  const returned: string[] = []
  const calls: string[] = []
  const controller = new AbortController()
  const document = source("mcp:fixture:late", "Queue dependency evidence", "document")
  async function hold(name: string, signal?: AbortSignal) {
    signals.push(signal!)
    if (signals.length === 3) started.resolve()
    await release.promise
    returned.push(name)
    if (returned.length === 3) settled.resolve()
  }
  const api = engine({
    root: fixture.root, store: fixture.storage,
    semantic: async (_query, signal) => { await hold("semantic", signal); return [] },
    memory: async (_query, _session, signal) => { await hold("memory", signal); return [] },
    docs: async (input) => { await hold("docs", input.signal); return [document] },
    complete: async () => {
      calls.push("model")
      return { text: JSON.stringify({ objective: "Inspect queue", reuse: [], inspect: [], changes: [], constraints: [], hypotheses: [], questions: [], acceptance: [], verification: [], evidence: [] }), usage: usage("fixture") }
    },
  })
  const pending = api.enhance({ text: "Inspect queue", session: "chat", signal: controller.signal })
  try {
    await deadline(() => started.promise, undefined, 2000)
    expect(new Set(signals).size).toBe(1)
    expect(calls).toEqual([])
    if (mode === "cancel") {
      controller.abort(new Error("Stop this preparation"))
      await expect(pending).rejects.toThrow("Stop this preparation")
      expect(returned).toEqual([])
      expect(signals.every((signal) => signal.aborted)).toBe(true)
      const captured = await api.manifests({ session: "chat" })
      expect(captured.at(0)?.state).toBe("failed")
      release.resolve()
      await settled.promise
      expect(await api.manifests({ session: "chat" })).toEqual(captured)
      expect((await fixture.storage.externals(fixture.root)).some((item) => item.id === document.id)).toBe(false)
      expect(calls).toEqual([])
      return
    }
    release.resolve()
    const proposal = await pending
    expect(calls).toEqual(["model"])
    expect(proposal.context.audit?.channels?.filter((item) => ["semantic", "memory", "dependency-docs"].includes(item.name)).every((item) => item.state === "completed")).toBe(true)
    expect((await fixture.storage.externals(fixture.root)).some((item) => item.id === document.id)).toBe(true)
  } finally {
    release.resolve()
    await pending.catch(() => undefined)
    await api.dispose()
    await fixture.close()
  }
})

test("search lookup capture links preparation policy and redacts failed query text", async () => {
  const fixture = await setup(async () => ({
    text: JSON.stringify({ objective: "Inspect queue", reuse: [], inspect: [], changes: [], constraints: [], hypotheses: [], questions: [], acceptance: [], verification: [], evidence: [] }),
    usage: usage("fixture"),
  }))
  try {
    const proposal = await fixture.api.enhance({ text: "Inspect queue" })
    const result = await fixture.api.lookup({ query: "queue", tool: "forge_search_code", session: "chat", call: "one", message: "turn", preparation: proposal.id })
    const record = (await fixture.api.request(result.request, "chat"))!
    expect(record.preparation).toBe(proposal.id)
    expect(record.operation).toBe(proposal.id)
    expect(record.selection).toEqual(result.result.audit)
    expect(record.entries.every((item) => item.stage === "assembled")).toBe(true)
    const controller = new AbortController()
    controller.abort(new Error("Cancelled"))
    await expect(fixture.api.lookup({ query: "password=private-secret queue", tool: "forge_search_code", session: "chat", signal: controller.signal })).rejects.toThrow("Cancelled")
    // Client cancellation does not wait for admitted history persistence.
    await fixture.api.dispose()
    const failed = (await fixture.api.manifests({ session: "chat" })).find((item) => item.state === "failed")!
    expect(failed.lookup?.query).toContain("[REDACTED]")
    expect(JSON.stringify(failed)).not.toContain("private-secret")
    expect(failed.entries).toEqual([])
    expect(failed.selection).toBeUndefined()
  } finally { await fixture.close() }
})

test("empty repositories show an overview without calling a model", async () => {
  const fixture = await setup()
  try {
    await rm(path.join(fixture.root, "queue.ts"))
    const result = await fixture.api.overview()
    expect(result.summary).toContain("No repository evidence is available")
    expect(result.evidence).toEqual([])
    expect(result.snapshot.sources.every((item) => item.kind === "directory")).toBe(true)
    expect(await fixture.api.manifests()).toEqual([])
  } finally {
    await fixture.close()
  }
})

test("knowledge views return persisted metadata without scanning or calling a model", async () => {
  const fixture = await setup()
  try {
    expect((await fixture.api.status("chat")).inventory.indexed).toBe(false)
    expect((await fixture.api.view()).sources).toEqual([])
    const snapshot = await fixture.api.refresh()
    await writeFile(path.join(fixture.root, "later.ts"), "export const later = true")
    const status = await fixture.api.status("chat")
    expect(status.inventory.generation).toBe(snapshot.generation)
    expect(status.inventory.counts.code).toBeGreaterThan(0)
    expect(status.job.state).toBe("completed")
    expect((await fixture.api.view()).sources.some((item) => item.uri === "later.ts")).toBe(false)
    expect((await fixture.api.view({ query: "queue" })).sources.every((item) => `${item.uri} ${item.label} ${item.text}`.toLowerCase().includes("queue"))).toBe(true)
  } finally {
    await fixture.close()
  }
})

test("session views filter history and compacted knowledge before limiting records", async () => {
  const fixture = await setup()
  try {
    await fixture.storage.external(fixture.root, source("summary:private", "Private session summary", "summary", { detail: { session: "private" } }))
    await fixture.api.refresh()
    for (let index = 0; index < 110; index++) {
      await fixture.api.observe({
        id: `request-${index}`, root: fixture.root, session: index === 0 ? "chat" : "private",
        generation: "fixture", purpose: "coding", model: "fixture", observed: index, entries: [],
        coverage: [], usage: usage(), state: "completed",
      })
    }
    await fixture.api.observe({
      id: "preparation", root: fixture.root, session: "chat", generation: "fixture", purpose: "enhance",
      model: "fixture", observed: 999, entries: [{ source: "test", hash: "hash", text: "test", stage: "sent", tokens: 4 }],
      coverage: [], usage: usage(), state: "completed",
    })
    const status = await fixture.api.status("chat")
    expect(status.coding?.id).toBe("request-0")
    expect(status.preparation?.id).toBe("preparation")
    expect(status.preparation?.sent).toBe(1)
    const publicView = await fixture.api.view({ session: "chat" })
    const summaries = publicView.sources.filter((item) => item.method === "domain-index").length
    expect(summaries).toBeGreaterThan(0)
    expect(status.inventory.counts.summary).toBe(summaries)
    expect((await fixture.api.status("private")).inventory.counts.summary).toBe(summaries + 1)
    expect((await fixture.api.view({ session: "private" })).sources.some((item) => item.uri === "summary:private")).toBe(true)
    expect((await fixture.api.view({ session: "chat" })).sources.some((item) => item.uri === "summary:private")).toBe(false)
    expect(await fixture.api.manifests({ session: "chat", purpose: "coding", limit: 1 })).toHaveLength(1)
    expect(await fixture.api.manifests({ session: "chat", purpose: "coding", offset: 1 })).toEqual([])
  } finally {
    await fixture.close()
  }
})

test("source pages traverse large scoped catalogs without duplicates or false next pages", async () => {
  const fixture = await setup()
  try {
    const sources = Array.from({ length: 505 }, (_, index) => ({
      ...source(`document-${index}.md`, `needle ${"excerpt ".repeat(100)}`, "document", { detail: index < 55 ? { session: "private" } : {} }),
      id: String(index).padStart(24, "0"),
    }))
    const snapshot = { root: fixture.root, generation: "pages", revision: "fixture", observed: 1, files: 505, partial: false, warnings: [], sources, relations: [] }
    await fixture.storage.replace(snapshot)
    await fixture.storage.replace({ ...snapshot, root: `${fixture.root}-other` })
    const ids: string[] = []
    let offset = 0
    while (true) {
      const page = await fixture.api.view({ limit: 100, offset, query: "needle", session: "chat", generation: "pages" })
      expect(page.sources.every((item) => item.text.length <= 500 && !item.detail.session)).toBe(true)
      ids.push(...page.sources.map((item) => item.id))
      if (page.page.next == null) break
      offset = page.page.next
    }
    expect(ids).toEqual(sources.slice(55).map((item) => item.id))
    expect(new Set(ids).size).toBe(450)
    expect((await fixture.api.view({ offset: 400, limit: 50 })).page.next).toBeUndefined()
    expect((await fixture.api.view({ offset: 450 })).sources).toEqual([])
    expect((await fixture.api.view({ limit: 9999 })).sources).toHaveLength(200)
    expect((await fixture.api.view({ offset: Number.NaN, limit: Number.NaN })).page).toEqual({ offset: 0, limit: 120, next: 120 })
    expect((await fixture.api.view({ session: "private", limit: 1 })).sources.at(0)?.id).toBe(sources.at(0)?.id)
    expect((await fixture.api.view({ query: "document-504", limit: 1 })).page.next).toBeUndefined()
    expect((await fixture.api.view({ query: "document-504", limit: 1 })).sources.at(0)?.id).toBe(sources.at(-1)?.id)
    expect((await fixture.api.view({ query: "missing", offset: 10 })).sources).toEqual([])
  } finally {
    await fixture.close()
  }
})

test("source pages retain focus, bound edges, and restart when the generation changes", async () => {
  const fixture = await setup()
  try {
    const snapshot = await fixture.api.refresh()
    const full = await fixture.api.view({ limit: 200 })
    const focus = full.sources.find((item) => full.relations.some((edge) => edge.from === item.id || edge.to === item.id))!
    const focused = await fixture.api.view({ focus: focus.id, limit: 200 })
    const first = await fixture.api.view({ focus: focus.id, limit: 1 })
    const second = await fixture.api.view({ focus: focus.id, limit: 1, offset: 1 })
    expect([first.sources.at(0)?.id, second.sources.at(0)?.id]).toEqual(focused.sources.slice(0, 2).map((item) => item.id))
    expect(first.relations.every((edge) => first.sources.some((item) => item.id === edge.from) && first.sources.some((item) => item.id === edge.to))).toBe(true)
    await fixture.storage.replace({ ...snapshot, generation: "updated" })
    const reset = await fixture.api.view({ offset: 10, limit: 1, generation: full.generation })
    expect(reset.page.offset).toBe(0)
    expect(reset.generation).toBe("updated")
    expect(reset.warnings.join(" ")).toContain("restarted")
    expect(reset.sources.at(0)?.id).toBe(full.sources.at(0)?.id)
  } finally {
    await fixture.close()
  }
})

test("status and published views remain available while a refresh is blocked", async () => {
  const fixture = await setup()
  const gate = Promise.withResolvers<string>()
  const api = engine({ root: fixture.root, store: fixture.storage, revision: () => gate.promise, complete: async () => { throw new Error("No model calls allowed") } })
  try {
    await fixture.api.refresh()
    expect(api.start().state).toBe("running")
    expect((await api.status()).job.state).toBe("running")
    expect((await api.view()).sources.length).toBeGreaterThan(0)
  } finally {
    gate.resolve("fixture")
    await api.refresh()
    await api.dispose()
    await fixture.close()
  }
})

test("proposal validation accepts current sources and rejects changed or deleted code", async () => {
  const fixture = await setup()
  try {
    const snapshot = await fixture.api.refresh()
    const item = snapshot.sources.find((item) => item.uri === "queue.ts" && item.method === "file")!
    const draft = proposal(item)
    expect(await fixture.api.validate(draft)).toBe(true)
    await writeFile(path.join(fixture.root, "queue.ts"), "export const queue = ['assigned']")
    expect(await fixture.api.validate(draft)).toBe(false)
    await rm(path.join(fixture.root, "queue.ts"))
    expect(await fixture.api.validate(draft)).toBe(false)
  } finally {
    await fixture.close()
  }
})

test("proposal validation rejects missing, unavailable, and expired external evidence", async () => {
  const fixture = await setup()
  try {
    await mkdir(path.join(fixture.root, ".kilo"))
    await Bun.write(path.join(fixture.root, ".kilo/forge.jsonc"), JSON.stringify({ documents: { server: "docs" } }))
    const snapshot = await fixture.api.refresh()
    const code = snapshot.sources.find((item) => item.uri === "queue.ts" && item.method === "file")!
    const item = source("mcp:docs:/queue/api", "Queue API documentation for assigning a patient", "document", {
      method: "context7",
      evidence: [code.id],
      detail: { server: "docs", dependencies: JSON.stringify({ [code.id]: code.hash }) },
    })
    const draft = proposal(item)
    expect(await fixture.api.validate(draft)).toBe(false)
    await fixture.storage.external(fixture.root, item)
    expect(await fixture.api.validate(draft)).toBe(true)
    await fixture.storage.external(fixture.root, { ...item, status: "unavailable" })
    expect(await fixture.api.validate(draft)).toBe(false)
    await fixture.storage.external(fixture.root, { ...item, observed: Date.now() - 25 * 60 * 60 * 1000 })
    expect(await fixture.api.validate(draft)).toBe(false)
  } finally {
    await fixture.close()
  }
})

test("unchanged summary text cannot validate after its supporting code changes", async () => {
  const fixture = await setup()
  try {
    const snapshot = await fixture.api.refresh()
    const code = snapshot.sources.find((item) => item.uri === "queue.ts" && item.method === "file")!
    const summary = source("summary:queue", "The queue starts with one waiting patient.", "summary", {
      evidence: [code.id],
      detail: { dependencies: JSON.stringify({ [code.id]: code.hash }) },
    })
    await fixture.storage.external(fixture.root, summary)
    const draft = proposal(summary)
    expect(await fixture.api.validate(draft)).toBe(true)
    await writeFile(path.join(fixture.root, "queue.ts"), "export const queue = []")
    expect(await fixture.api.validate(draft)).toBe(false)
  } finally {
    await fixture.close()
  }
})

test("enhancement integrates classified decisions without another model call or workspace changes", async () => {
  const requests: Parameters<Ports["complete"]>[0][] = []
  // A fixed provider response exercises the real engine contract, not model classification quality.
  const fixture = await setup(async (input) => {
    requests.push(input)
    return {
      text: JSON.stringify({
        objective: "Extend the queue",
        reuse: [],
        inspect: [],
        changes: [],
        constraints: [],
        hypotheses: [],
        questions: [
          { kind: "assumption", statement: "Follow local test naming", reason: "No public behavior changes" },
          { kind: "inspect", action: "Read the queue callers before editing" },
          { kind: "answered", statement: "Keep input order", basis: "The draft explicitly requires input order" },
        ],
        acceptance: [],
        verification: [],
        evidence: [],
      }),
      usage: { ...usage("fixture"), input: 42, output: 20, measured: true },
    }
  })
  try {
    const original = "Extend the queue while preserving input order. Do not remove waiting patients."
    const before = await fixture.api.refresh()
    const result = await fixture.api.enhance({ text: original, answers: "Choose test filenames yourself." })
    expect(result.status).toBe("ready")
    expect(result.task.questions).toEqual([])
    expect(result.task.inspect).toContain("Read the queue callers before editing")
    expect(result.task.hypotheses.at(0)).toContain("Follow local test naming")
    expect(result.prompt).toContain(original)
    expect(result.prompt).toContain("Choose test filenames yourself.")
    expect(requests).toHaveLength(1)
    expect(requests.at(0)?.system).toContain('"kind":"blocking"')
    expect(requests.at(0)?.prompt).toContain("Choose test filenames yourself.")
    expect(result.usage.input).toBe(42)
    expect(result.usage.output).toBe(20)
    expect((await fixture.api.manifests()).at(0)?.usage).toEqual(result.usage)
    expect((await fixture.api.refresh(true)).generation).toBe(before.generation)
    expect(await fixture.api.validate(result)).toBe(true)
  } finally {
    await fixture.close()
  }
})

test("enhancement revisions keep user feedback authoritative and previous AI text separate", async () => {
  const calls: Parameters<Ports["complete"]>[0][] = []
  const f = await setup(async (input) => {
    calls.push(input)
    return {
      text: JSON.stringify({
        objective: "Revise the queue task", reuse: [], inspect: [], changes: [], constraints: [],
        hypotheses: [], questions: [], acceptance: [], verification: [], evidence: [],
      }),
      usage: usage("fixture"),
    }
  })
  try {
    const original = "Improve the queue."
    const revision = "A previous AI suggestion to replace the entire public API."
    const result = await f.api.enhance({ text: original, answers: "Keep input ordering.", feedback: "Preserve the public API and add regression tests.", revision })
    expect(calls).toHaveLength(1)
    expect(calls.at(0)?.prompt).toContain(`Previous proposed prompt (non-authoritative):\n${revision}`)
    expect(calls.at(0)?.system).toContain("Apply developer events in conversation order")
    expect(result.original).toBe(original)
    expect(result.prompt).toContain("Keep input ordering.")
    expect(result.prompt).toContain("Preserve the public API and add regression tests.")
    expect(result.prompt).not.toContain(revision)
    expect(result.questions).toEqual([])
  } finally { await f.close() }
})

test.each(["path", "shortened", "unknown"] as const)("restored %s citations retain factual activity and current evidence boundaries", async (mode) => {
  const calls: Parameters<Ports["complete"]>[0][] = []
  const updates: EnhancementProgress[] = []
  const f = await setup(async (input) => {
    calls.push(input)
    return { text: JSON.stringify({
      objective: "Improve the queue", reuse: [], inspect: [], changes: [], constraints: [], hypotheses: [],
      questions: [], acceptance: [], verification: [], evidence: [mode === "path" ? "queue.ts" : mode === "shortened" ? input.evidence?.at(0)?.slice(0, -1) : "invented-source"],
    }), usage: usage("fixture") }
  })
  try {
    await writeFile(path.join(f.root, ".env"), "PRIVATE_ACTIVITY_CANARY")
    const result = await f.api.enhance({ text: "Improve the queue", update: (value) => updates.push(value) }).then(
      (value) => value, (err: unknown) => err,
    )
    expect(calls).toHaveLength(1)
    expect(calls.at(0)?.system).toContain("Allowed evidence IDs for this revision")
    expect(JSON.stringify(updates)).not.toContain(".env")
    const entries = updates.at(-1)?.activity?.entries ?? []
    expect(entries.some((item) => item.action === "Read locally" && item.path === "queue.ts")).toBe(true)
    expect(entries.some((item) => item.action === "Selected for model" && item.path?.startsWith("queue.ts:"))).toBe(true)
    if (mode === "unknown") {
      expect(result).toBeInstanceOf(Error)
      expect((await f.api.manifests()).at(0)?.state).toBe("failed")
      return
    }
    const proposal = decode(Proposal, result)
    expect(calls.at(0)?.evidence).toEqual(proposal.context.matches.map((match) => match.source.id))
    expect(proposal.task.evidence.every((key) => proposal.context.matches.some((match) => match.source.id === key))).toBe(true)
    expect(proposal.activity?.counts?.checks).toBeGreaterThan(0)
    if (mode === "shortened") {
      expect(proposal.task.evidence).toEqual(calls.at(0)?.evidence?.slice(0, 1) ?? [])
      expect(proposal.warnings.some((warning) => warning.startsWith("Resolved model citation formatting"))).toBe(true)
    }
  } finally { await f.close() }
})
