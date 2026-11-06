import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { rejects } from "node:assert/strict"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Schema } from "effect"
import { embeddings } from "../src/embeddings"
import { embeddingJobs } from "../src/embedding-jobs"
import { engine } from "../src/engine"
import { knowledge } from "../src/knowledge"
import { store, type Query } from "../src/store"
import { decode, type EmbeddingJob } from "../src/schema"
import { account } from "../src/embedding-usage"
import { exportEmbeddings } from "../src/embedding-export"

async function until<T>(read: () => Promise<T>, check: (value: T) => boolean) {
  const deadline = performance.now() + 5000
  while (true) {
    const value = await read()
    if (check(value)) return value
    if (performance.now() > deadline) throw new Error(`Timed out waiting for job: ${JSON.stringify(value)}`)
    await Bun.sleep(5)
  }
}

async function setup(count = 2, session = "", writing?: (queries: readonly Query[]) => Promise<void>) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "forge-embedding-jobs-")))
  const db = new Database(path.join(root, "state.sqlite"))
  function connect() {
    return store({
      all: async (query) =>
        db.query<Record<string, unknown>, (string | number | null)[]>(query.text).all(...(query.values ?? [])),
      batch: async (queries) => {
        await writing?.(queries)
        db.transaction(() => {
          for (const query of queries) db.query(query.text).run(...(query.values ?? []))
        })()
      },
    })
  }
  const storage = connect()
  const library = knowledge(root, storage)
  const collection = await library.register({
    kind: "text",
    label: "Operations",
    location: "",
    session,
    content: Array.from(
      { length: count },
      (_, index) => `# Rule ${index}\n\nRelease item ${index} only after a signed receipt arrives.`,
    ).join("\n\n"),
  })
  await library.approve(collection.id, session, [])
  await library.index(collection.id, session)
  const state = {
    hold: false,
    fail: 0,
    denied: false,
    configured: true,
    invalid: false,
    usage: undefined as unknown,
    sends: [] as string[][],
    held: [] as ReturnType<typeof Promise.withResolvers<void>>[],
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const input = decode(Schema.Struct({ input: Schema.Array(Schema.String) }), await request.json()).input
      state.sends.push([...input])
      if (state.hold) {
        const gate = Promise.withResolvers<void>()
        state.held.push(gate)
        await gate.promise
      }
      if (state.fail === state.sends.length) return new Response("private provider diagnostic", { status: 503 })
      return Response.json({
        data: input.map((_, index) => ({ index, embedding: state.invalid ? [0, 0] : [1, 0] })),
        usage: state.usage,
      })
    },
  })
  const host = {
    configuration: async () =>
      state.configured ? { endpoint: `${server.url}v1/embeddings`, model: "fixture", dimensions: 2 } : undefined,
    authorize: async () => {
      if (state.denied) throw new Error("Local permission denied")
    },
  }
  const api = embeddings({ ...host, root, store: storage, library })
  async function grant(scope = session) {
    await api.approve(collection.id, (await api.review(collection.id, scope)).revision, scope)
  }
  const list = () => api.jobs.list(collection.id, session)
  const done = () => until(list, (rows) => !!rows.at(0)?.finished)
  return {
    root,
    db,
    connect,
    storage,
    library,
    collection,
    host,
    api,
    state,
    grant,
    list,
    done,
    async [Symbol.asyncDispose]() {
      for (const gate of state.held) gate.resolve()
      await api.dispose()
      await library.dispose()
      await server.stop(true)
      db.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}

test("jobs persist explicit progress and reuse without indexing from observation", async () => {
  await using fixture = await setup()
  expect(await fixture.list()).toEqual([])
  expect(fixture.state.sends).toEqual([])
  await rejects(fixture.api.jobs.start(fixture.collection.id))
  await fixture.grant()
  expect(fixture.state.sends).toEqual([])
  const first = await fixture.api.jobs.start(fixture.collection.id)
  expect(first.state).toBe("queued")
  const completed = (await fixture.done()).at(0)!
  expect(completed.state).toBe("completed")
  expect(completed.result).toEqual({ sections: 2, embedded: 2, reused: 0 })
  expect(completed.progress).toEqual({ phase: "validating", sections: 2, processed: 2, embedded: 2, reused: 0 })
  expect(completed.usage).toMatchObject({
    attempts: 1,
    inputs: 2,
    pending: 0,
    responses: 1,
    failed: 0,
    promptTokens: 0,
    promptReports: 0,
    totalTokens: 0,
    totalReports: 0,
  })
  expect(completed.usage!.bytes).toBeGreaterThan(0)
  expect(JSON.stringify(completed)).not.toContain("signed receipt")
  expect(fixture.state.sends).toHaveLength(1)
  await fixture.api.jobs.start(fixture.collection.id)
  await until(fixture.list, (rows) => rows.filter((row) => row.state === "completed").length === 2)
  expect((await fixture.list()).find((row) => row.id !== first.id)?.usage).toEqual({
    attempts: 0,
    inputs: 0,
    bytes: 0,
    responses: 0,
    failed: 0,
    pending: 0,
    promptTokens: 0,
    promptReports: 0,
    totalTokens: 0,
    totalReports: 0,
  })
  expect((await fixture.list()).find((row) => row.id !== first.id)?.result).toEqual({
    sections: 2,
    embedded: 0,
    reused: 2,
  })
  expect(fixture.state.sends).toHaveLength(1)
  await fixture.api.dispose()
  const reopened = embeddings({
    ...fixture.host,
    root: fixture.root,
    store: fixture.connect(),
    library: fixture.library,
  })
  try {
    expect(await reopened.jobs.list(fixture.collection.id)).toHaveLength(2)
    expect((await reopened.jobs.list(fixture.collection.id)).find((row) => row.id === first.id)?.usage).toEqual(
      completed.usage,
    )
  } finally {
    await reopened.dispose()
  }
})

test("job usage retains provider subtotals and failed attempts without inventing missing tokens", async () => {
  await using fixture = await setup(17)
  fixture.state.usage = { prompt_tokens: 123, total_tokens: 123, private: "must-not-persist" }
  fixture.state.fail = 2
  await fixture.grant()
  await fixture.api.jobs.start(fixture.collection.id)
  const failed = (await fixture.done()).at(0)!
  expect(failed.state).toBe("failed")
  expect(failed.usage).toMatchObject({
    attempts: 2,
    inputs: 17,
    responses: 1,
    failed: 1,
    pending: 0,
    promptTokens: 123,
    promptReports: 1,
    totalTokens: 123,
    totalReports: 1,
  })
  expect(JSON.stringify(failed)).not.toContain("must-not-persist")
  fixture.state.fail = 0
  await fixture.api.jobs.start(fixture.collection.id)
  const rows = await until(fixture.list, (rows) => rows.some((row) => row.state === "completed"))
  expect(rows.find((row) => row.state === "completed")!.usage).toMatchObject({
    attempts: 2,
    inputs: 17,
    responses: 2,
    failed: 0,
    pending: 0,
    promptTokens: 246,
    promptReports: 2,
    totalTokens: 246,
    totalReports: 2,
  })
  expect(rows.find((row) => row.id === failed.id)!.usage).toEqual(failed.usage)
})

test("durable ledger accounts synchronous indexing and concurrent queries once across collections", async () => {
  await using fixture = await setup()
  fixture.state.usage = { prompt_tokens: 7, total_tokens: 9, private: "usage-private-canary" }
  await fixture.grant()
  await fixture.api.index(fixture.collection.id, "chat")
  const other = await fixture.library.register({
    kind: "text",
    label: "Other",
    location: "",
    content: "A second signed receipt is required.",
  })
  await fixture.library.approve(other.id, "", [])
  await fixture.library.index(other.id)
  await fixture.api.approve(other.id, (await fixture.api.review(other.id)).revision)
  await fixture.api.index(other.id, "chat")
  const sources = await fixture.storage.knowledge(fixture.root, "chat")
  const query = { query: "query-private-canary", sources, session: "chat", limit: 10 }
  await Promise.all(Array.from({ length: 20 }, () => fixture.api.retrieve(query)))
  const first = await fixture.api.usage({ session: "chat", limit: 7 })
  const second = await fixture.api.usage({ session: "chat", limit: 7, after: first.next })
  const third = await fixture.api.usage({ session: "chat", limit: 100, after: second.next })
  const entries = [...first.entries, ...second.entries, ...third.entries]
  expect(entries).toHaveLength(22)
  expect(new Set(entries.map((entry) => entry.id)).size).toBe(22)
  expect(third.next).toBeUndefined()
  expect(entries.filter((entry) => entry.purpose === "query")).toHaveLength(20)
  for (const entry of entries.filter((entry) => entry.purpose === "query")) {
    expect(new Set(entry.collections)).toEqual(new Set([fixture.collection.id, other.id]))
    expect(entry.usage).toMatchObject({
      attempts: 1,
      inputs: 1,
      responses: 1,
      pending: 0,
      promptTokens: 7,
      totalTokens: 9,
    })
  }
  expect(entries.reduce((sum, entry) => sum + entry.usage.attempts, 0)).toBe(fixture.state.sends.length)
  expect(JSON.stringify(entries)).not.toMatch(/query-private-canary|usage-private-canary|signed receipt/)
  expect((await fixture.api.usage()).entries).toEqual([])
  expect((await fixture.api.usage({ session: "foreign" })).entries).toEqual([])
  expect((await fixture.storage.embeddingLedger(fixture.root + "-other", "chat")).entries).toEqual([])
  fixture.state.configured = false
  expect((await fixture.api.usage({ session: "chat", limit: 100 })).entries).toEqual(entries)
  const exported = await exportEmbeddings({
    session: "chat",
    read: (request, signal) => fixture.api.usage(request, signal),
  })
  expect(exported.entries).toEqual(entries)
  expect(exported.groups.find((group) => group.purpose === "query")!.usage).toMatchObject({
    attempts: 20,
    promptTokens: 140,
    totalTokens: 180,
  })
  expect(exported.groups.find((group) => group.purpose === "index")!.usage).toMatchObject({
    attempts: 2,
    promptTokens: 14,
    totalTokens: 18,
  })
  expect(fixture.state.sends).toHaveLength(22)
  fixture.state.denied = true
  await rejects(fixture.api.usage({ session: "chat" }), /Local permission denied/)
  await rejects(
    exportEmbeddings({ session: "chat", read: (request, signal) => fixture.api.usage(request, signal) }),
    /Local permission denied/,
  )
  for (const limit of [0, 101, 1.5]) await rejects(fixture.api.usage({ session: "chat", limit }), /limit/)
  for (const after of ["0", "-1", "1.5", "9007199254740992", "bad"])
    await rejects(fixture.api.usage({ session: "chat", after }), /cursor/)
})

test("ledger admission failure prevents transport and old jobs are not fabricated into ledger entries", async () => {
  await using fixture = await setup()
  await fixture.grant()
  fixture.db.run(
    "CREATE TRIGGER deny_usage BEFORE INSERT ON forge_records WHEN NEW.kind = 'embedding-attempt' BEGIN SELECT RAISE(ABORT, 'usage admission denied'); END",
  )
  await rejects(fixture.api.index(fixture.collection.id), /usage admission denied/)
  expect(fixture.state.sends).toEqual([])
  expect((await fixture.api.usage()).entries).toEqual([])
  fixture.db.run("DROP TRIGGER deny_usage")
  await fixture.api.jobs.start(fixture.collection.id)
  const job = (await fixture.done()).at(0)!
  const ledger = await fixture.api.usage()
  expect(ledger.entries).toHaveLength(1)
  expect(ledger.entries.at(0)!.purpose).toBe("job")
  expect(ledger.entries.at(0)!.usage).toEqual(job.usage!)
  for (let index = 1; index <= 20; index++)
    await fixture.storage.embeddingJobSave(fixture.root, {
      ...job,
      id: `legacy-${index}`,
      usage: undefined,
      started: job.started + index,
    })
  expect((await fixture.list()).some((entry) => entry.id === job.id)).toBe(false)
  expect(await fixture.api.usage()).toEqual(ledger)
})

test("ledger retains reported usage for invalid vectors and unknown usage for HTTP failure", async () => {
  await using fixture = await setup()
  await fixture.grant()
  fixture.state.invalid = true
  fixture.state.usage = { prompt_tokens: 11, total_tokens: 11 }
  await rejects(
    fixture.api.index(fixture.collection.id),
    /Embedding response does not match requested inputs or dimensions/,
  )
  const reported = (await fixture.api.usage()).entries.at(0)!
  expect(reported.usage).toMatchObject({ responses: 1, failed: 0, pending: 0, promptTokens: 11, promptReports: 1 })
  fixture.state.fail = 2
  await rejects(fixture.api.index(fixture.collection.id), /HTTP 503/)
  const failed = (await fixture.api.usage()).entries.at(0)!
  expect(failed.usage).toMatchObject({ responses: 0, failed: 1, pending: 0, promptTokens: 0, promptReports: 0 })
  fixture.state.invalid = false
  await fixture.api.index(fixture.collection.id)
  expect((await fixture.api.usage()).entries).toHaveLength(3)
  expect((await fixture.api.usage()).entries.find((entry) => entry.id === reported.id)).toEqual(reported)
  expect(fixture.state.sends).toHaveLength(3)
})

test("cancelled synchronous query retains observed attempt and purge cannot resurrect ledger rows", async () => {
  await using fixture = await setup()
  await fixture.grant()
  await fixture.api.index(fixture.collection.id)
  fixture.state.hold = true
  const signal = new AbortController()
  const sources = await fixture.storage.knowledge(fixture.root)
  const pending = fixture.api.retrieve({
    query: "signed receipt",
    session: "",
    sources,
    limit: 10,
    signal: signal.signal,
  })
  const rejected = rejects(pending, /cancel query/)
  await until(
    async () => fixture.state.held.length,
    (count) => count === 1,
  )
  const admitted = (await fixture.api.usage()).entries.at(0)!
  expect(admitted.usage).toMatchObject({ pending: 1, responses: 0, attempts: 1 })
  signal.abort(new Error("cancel query"))
  await rejected
  const page = await until(
    () => fixture.api.usage(),
    (page) => page.entries.at(0)!.finished != null,
  )
  expect(page.entries.at(0)!.usage).toMatchObject({ failed: 1, pending: 0, totalReports: 0 })
  await fixture.library.purge(fixture.collection.id)
  fixture.state.held.at(0)!.resolve()
  await fixture.storage.embeddingAttemptSave(
    fixture.root,
    { ...admitted, finished: Date.now(), usage: page.entries.at(0)!.usage },
    admitted,
  )
  expect((await fixture.api.usage()).entries).toEqual([])
  expect(fixture.db.query("SELECT id FROM forge_records WHERE kind = 'embedding-attempt'").all()).toEqual([])
})

test("usage read rechecks permissions and collection state after held authorization", async () => {
  await using fixture = await setup()
  await fixture.grant()
  await fixture.api.index(fixture.collection.id)
  const entered = Promise.withResolvers<void>()
  const released = Promise.withResolvers<void>()
  const other = embeddings({
    ...fixture.host,
    root: fixture.root,
    store: fixture.storage,
    library: fixture.library,
    authorize: async () => {
      entered.resolve()
      await released.promise
    },
  })
  try {
    const pending = other.usage()
    const rejected = rejects(pending, /changed during embedding usage/)
    await entered.promise
    await fixture.api.revoke(fixture.collection.id)
    released.resolve()
    await rejected
    expect(fixture.state.sends).toHaveLength(1)
  } finally {
    released.resolve()
    await other.dispose()
  }
})

test("ledger outcomes keep cursor positions, reject stale writes and preserve unknown usage", async () => {
  await using fixture = await setup()
  await fixture.grant()
  await fixture.api.index(fixture.collection.id)
  const first = (await fixture.api.usage()).entries.at(0)!
  const admitted = {
    ...first,
    id: crypto.randomUUID(),
    finished: undefined,
    usage: account(undefined, { state: "attempt", inputs: 2, bytes: 42 }),
  }
  await fixture.storage.embeddingAttemptSave(fixture.root, admitted)
  const page = await fixture.api.usage({ limit: 1 })
  const result = { ...admitted, finished: Date.now(), usage: account(admitted.usage, { state: "response" }) }
  await fixture.connect().embeddingAttemptSave(fixture.root, result, admitted)
  await rejects(fixture.storage.embeddingAttemptSave(fixture.root, result, admitted))
  expect((await fixture.api.usage({ limit: 1 })).next).toBe(page.next)
  expect((await fixture.api.usage({ after: page.next })).entries).toEqual([first])
  expect((await fixture.api.usage()).entries.at(0)!.usage).toMatchObject({ responses: 1, pending: 0, totalReports: 0 })
  for (const usage of [
    { ...admitted.usage, attempts: 2 },
    { ...admitted.usage, totalTokens: 100 },
    { ...admitted.usage, inputs: 0 },
    { ...admitted.usage, bytes: Number.MAX_SAFE_INTEGER + 1 },
  ])
    await rejects(
      fixture.storage.embeddingAttemptSave(fixture.root, { ...admitted, id: crypto.randomUUID(), usage }),
      /counters|Expected an integer/,
    )
})

test("usage read rejects outcomes recorded while authorization is pending", async () => {
  await using fixture = await setup()
  await fixture.grant()
  await fixture.api.index(fixture.collection.id)
  const first = (await fixture.api.usage()).entries.at(0)!
  const admitted = {
    ...first,
    id: crypto.randomUUID(),
    finished: undefined,
    usage: account(undefined, {
      state: "attempt",
      inputs: 1,
      bytes: 40,
    }),
  }
  await fixture.storage.embeddingAttemptSave(fixture.root, admitted)
  const entered = Promise.withResolvers<void>()
  const released = Promise.withResolvers<void>()
  const other = embeddings({
    ...fixture.host,
    root: fixture.root,
    store: fixture.storage,
    library: fixture.library,
    authorize: async () => {
      entered.resolve()
      await released.promise
    },
  })
  try {
    const pending = other.usage()
    const rejected = rejects(pending, /Ledger changed during embedding usage inspection/)
    await entered.promise
    await fixture.connect().embeddingAttemptSave(
      fixture.root,
      {
        ...admitted,
        finished: Date.now(),
        usage: account(admitted.usage, { state: "response", total: 7 }),
      },
      admitted,
    )
    released.resolve()
    await rejected
    expect(fixture.state.sends).toHaveLength(1)
  } finally {
    released.resolve()
    await other.dispose()
  }
})

test("job checkpoint admission failure leaves one unresolved ledger attempt and sends nothing", async () => {
  await using fixture = await setup()
  await fixture.grant()
  fixture.db.run(
    "CREATE TRIGGER deny_job_usage BEFORE INSERT ON forge_records WHEN NEW.kind = 'embedding-job' AND json_extract(NEW.body, '$.usage.attempts') > 0 BEGIN SELECT RAISE(ABORT, 'job checkpoint denied'); END",
  )
  await fixture.api.jobs.start(fixture.collection.id)
  expect((await fixture.done()).at(0)!.state).toBe("failed")
  expect(fixture.state.sends).toEqual([])
  const page = await fixture.api.usage()
  expect(page.entries).toHaveLength(1)
  expect(page.entries.at(0)!.usage).toMatchObject({ pending: 1, attempts: 1, responses: 0, failed: 0 })
})

test("aborting a usage read releases held permissions and makes no model calls", async () => {
  await using fixture = await setup()
  await fixture.grant()
  await fixture.api.index(fixture.collection.id)
  const entered = Promise.withResolvers<void>()
  const released = Promise.withResolvers<void>()
  const other = embeddings({
    ...fixture.host,
    root: fixture.root,
    store: fixture.storage,
    library: fixture.library,
    authorize: async () => {
      entered.resolve()
      await released.promise
    },
  })
  try {
    const signal = new AbortController()
    const pending = other.usage({}, signal.signal)
    const rejected = rejects(pending, /cancel usage read/)
    await entered.promise
    signal.abort(new Error("cancel usage read"))
    await rejected
    expect(fixture.state.sends).toHaveLength(1)
    released.resolve()
  } finally {
    released.resolve()
    await other.dispose()
  }
})

for (const purpose of ["index", "query"] as const) {
  for (const action of ["revoke", "purge", "disable", "deny", "exclude"] as const) {
    test(`${purpose} revalidates ${action} across a held ledger admission before sending`, async () => {
      const entered = Promise.withResolvers<void>()
      const released = Promise.withResolvers<void>()
      let held = false
      await using fixture = await setup(2, "", async (queries) => {
        if (!held || !queries.some((query) => query.text.includes("VALUES(?,'embedding-attempt'"))) return
        entered.resolve()
        await released.promise
      })
      try {
        await fixture.grant()
        if (purpose === "query") await fixture.api.index(fixture.collection.id)
        const sources = await fixture.storage.knowledge(fixture.root)
        const count = fixture.state.sends.length
        held = true
        const pending =
          purpose === "query"
            ? fixture.api.retrieve({ query: "signed receipt", session: "", sources, limit: 10 })
            : fixture.api.index(fixture.collection.id)
        const rejected = rejects(pending)
        await entered.promise
        if (action === "revoke") await fixture.api.revoke(fixture.collection.id)
        if (action === "purge") await fixture.library.purge(fixture.collection.id)
        if (action === "disable") fixture.state.configured = false
        if (action === "deny") fixture.state.denied = true
        if (action === "exclude")
          await fixture.storage.policySave(fixture.root, {
            version: "changed",
            session: "",
            pin: [],
            exclude: sources.map((source) => source.id),
          })
        released.resolve()
        await rejected
        expect(fixture.state.sends).toHaveLength(count)
        const page = await fixture.storage.embeddingLedger(fixture.root)
        if (action === "purge") expect(page.entries).toEqual([])
        if (action !== "purge")
          expect(page.entries.at(0)!.usage).toMatchObject({ attempts: 1, pending: 1, responses: 0 })
      } finally {
        released.resolve()
      }
    })
  }
}

test("cancelled job keeps admitted usage unknown and ignores a late provider report", async () => {
  await using fixture = await setup()
  await fixture.grant()
  fixture.state.hold = true
  fixture.state.usage = { prompt_tokens: 900, total_tokens: 900 }
  const job = await fixture.api.jobs.start(fixture.collection.id)
  await until(
    async () => fixture.state.held.length,
    (count) => count === 1,
  )
  expect((await fixture.list()).at(0)!.usage).toMatchObject({ attempts: 1, pending: 1, inputs: 2 })
  await fixture.api.jobs.cancel(fixture.collection.id, job.id)
  const cancelled = (await fixture.list()).at(0)!
  expect(cancelled.state).toBe("cancelled")
  expect(cancelled.usage).toMatchObject({ attempts: 1, responses: 0, promptReports: 0, totalReports: 0 })
  expect(cancelled.usage!.pending + cancelled.usage!.failed).toBe(1)
  fixture.state.held.at(0)!.resolve()
  fixture.state.hold = false
  await fixture.api.jobs.start(fixture.collection.id)
  await until(fixture.list, (rows) => rows.some((row) => row.state === "completed"))
  expect((await fixture.list()).find((row) => row.id === job.id)!.usage).toEqual(cancelled.usage)
})

test("closing a start request does not cancel an admitted shared job; heartbeat is not material progress", async () => {
  await using fixture = await setup()
  await fixture.grant()
  fixture.state.hold = true
  const signal = new AbortController()
  const started = await fixture.api.jobs.start(fixture.collection.id, "", signal.signal)
  signal.abort()
  await until(
    async () => fixture.state.held.length,
    (count) => count === 1,
  )
  const initial = (await fixture.list()).at(0)!
  expect(initial.state).toBe("running")
  expect(initial.progress.phase).toBe("embedding")
  const observed = await until(fixture.list, (rows) => rows.at(0)!.updated > initial.updated)
  expect(observed.at(0)!.progressed).toBe(initial.progressed)
  expect(observed.at(0)!.progress.processed).toBe(0)
  const joined = await Promise.all(Array.from({ length: 5 }, () => fixture.api.jobs.start(fixture.collection.id)))
  expect(joined.every((job) => job.id === started.id)).toBe(true)
  expect(fixture.state.sends).toHaveLength(1)
  fixture.state.held.at(0)!.resolve()
  expect((await fixture.done()).at(0)!.state).toBe("completed")
})

test("same-store handles share ownership and only the last disposal cancels work", async () => {
  await using fixture = await setup()
  const other = embeddings({ ...fixture.host, root: fixture.root, store: fixture.storage, library: fixture.library })
  await fixture.grant()
  fixture.state.hold = true
  const started = await fixture.api.jobs.start(fixture.collection.id)
  await until(
    async () => fixture.state.held.length,
    (count) => count === 1,
  )
  expect((await other.jobs.start(fixture.collection.id)).id).toBe(started.id)
  await fixture.api.dispose()
  expect((await other.jobs.list(fixture.collection.id)).at(0)!.state).toBe("running")
  await other.dispose()
  const stored = (await fixture.storage.embeddingJobs(fixture.root, fixture.collection.id)).at(0)!
  expect(stored.state).toBe("cancelled")
  fixture.state.held.at(0)!.resolve()
  await Bun.sleep(10)
  expect((await fixture.storage.embeddingJobs(fixture.root, fixture.collection.id)).at(0)!.state).toBe("cancelled")
})

test("explicit cancellation permits retry before the old response and preserves previous publication", async () => {
  await using fixture = await setup()
  await fixture.grant()
  fixture.state.hold = true
  const first = await fixture.api.jobs.start(fixture.collection.id)
  await until(
    async () => fixture.state.held.length,
    (count) => count === 1,
  )
  await fixture.api.jobs.cancel(fixture.collection.id, first.id)
  expect((await fixture.done()).at(0)!.state).toBe("cancelled")
  fixture.state.hold = false
  const second = await fixture.api.jobs.start(fixture.collection.id)
  await until(fixture.list, (rows) => rows.some((row) => row.id === second.id && row.state === "completed"))
  fixture.state.held.at(0)!.resolve()
  await Bun.sleep(10)
  expect((await fixture.list()).find((row) => row.id === first.id)!.state).toBe("cancelled")
  expect(fixture.state.sends).toHaveLength(2)
})

test("job history and cancellation stay within originating session and workspace", async () => {
  await using fixture = await setup(2, "private")
  await fixture.grant()
  fixture.state.hold = true
  const started = await fixture.api.jobs.start(fixture.collection.id, "private")
  await until(
    async () => fixture.state.held.length,
    (count) => count === 1,
  )
  await rejects(fixture.api.jobs.list(fixture.collection.id, "other"))
  await rejects(fixture.api.jobs.cancel(fixture.collection.id, started.id, "other"))
  expect(await fixture.storage.embeddingJobs(fixture.root + "-other", fixture.collection.id, "private")).toEqual([])
  fixture.state.denied = true
  await rejects(fixture.list(), /Local permission denied/)
  fixture.state.denied = false
  await fixture.api.jobs.cancel(fixture.collection.id, started.id, "private")
})

test("job observation and cancellation work offline without resolving provider configuration", async () => {
  await using fixture = await setup()
  await fixture.grant()
  fixture.state.hold = true
  const job = await fixture.api.jobs.start(fixture.collection.id)
  await until(
    async () => fixture.state.held.length,
    (count) => count === 1,
  )
  fixture.state.configured = false
  expect((await fixture.list()).at(0)?.id).toBe(job.id)
  await fixture.api.jobs.cancel(fixture.collection.id, job.id)
  expect((await fixture.done()).at(0)!.state).toBe("cancelled")
})

test("shared collections retain separate session jobs and enforce the two-job admission bound", async () => {
  await using fixture = await setup()
  await fixture.grant()
  fixture.state.hold = true
  const first = await fixture.api.jobs.start(fixture.collection.id, "first")
  const second = await fixture.api.jobs.start(fixture.collection.id, "second")
  await until(
    async () => fixture.state.held.length,
    (count) => count === 2,
  )
  expect(first.id).not.toBe(second.id)
  expect(await fixture.list()).toEqual([])
  expect((await fixture.api.jobs.list(fixture.collection.id, "first")).map((job) => job.id)).toEqual([first.id])
  await rejects(fixture.api.jobs.start(fixture.collection.id, "third"), /Two embedding jobs/)
  expect(fixture.state.sends).toHaveLength(2)
  await fixture.api.jobs.cancel(fixture.collection.id, second.id, "first")
  expect((await fixture.api.jobs.list(fixture.collection.id, "second")).at(0)?.state).toBe("running")
  await fixture.api.jobs.cancel(fixture.collection.id, first.id, "first")
  const third = await fixture.api.jobs.start(fixture.collection.id, "third")
  expect(third.id).not.toBe(first.id)
})

test("pre-aborted starts and observations create no work", async () => {
  await using fixture = await setup()
  await fixture.grant()
  const controller = new AbortController()
  controller.abort(new Error("View closed"))
  await rejects(fixture.api.jobs.start(fixture.collection.id, "", controller.signal), /View closed/)
  await rejects(fixture.api.jobs.list(fixture.collection.id, "", controller.signal), /View closed/)
  expect(fixture.state.sends).toEqual([])
  expect(await fixture.list()).toEqual([])
})

test("failed later batch reports uncommitted work without publishing a partial cache", async () => {
  await using fixture = await setup(18)
  await fixture.grant()
  fixture.state.fail = 2
  await fixture.api.jobs.start(fixture.collection.id)
  const failed = (await fixture.done()).at(0)!
  expect(failed.state).toBe("failed")
  expect(failed.progress.processed).toBe(16)
  expect(failed.result).toBeUndefined()
  expect(failed.error).not.toContain("private provider diagnostic")
  fixture.state.fail = 0
  const job = await fixture.api.jobs.start(fixture.collection.id)
  const rows = await until(fixture.list, (rows) => rows.some((row) => row.id === job.id && row.finished != null))
  expect(rows.find((row) => row.id === job.id)?.result).toEqual({ sections: 18, embedded: 18, reused: 0 })
})

test("revocation during a held job fails it without cache publication", async () => {
  await using fixture = await setup()
  await fixture.grant()
  fixture.state.hold = true
  await fixture.api.jobs.start(fixture.collection.id)
  await until(
    async () => fixture.state.held.length,
    (count) => count === 1,
  )
  await fixture.api.revoke(fixture.collection.id)
  fixture.state.held.at(0)!.resolve()
  expect((await fixture.done()).at(0)!.state).toBe("failed")
  expect(
    fixture.db.query("SELECT id FROM forge_records WHERE kind = 'cache' AND id LIKE 'collection-vectors:%'").all(),
  ).toEqual([])
})

test("purge prevents late job records and cached vectors from reappearing", async () => {
  await using fixture = await setup()
  await fixture.grant()
  fixture.state.hold = true
  await fixture.api.jobs.start(fixture.collection.id)
  await until(
    async () => fixture.state.held.length,
    (count) => count === 1,
  )
  await fixture.library.purge(fixture.collection.id)
  fixture.state.held.at(0)!.resolve()
  await fixture.api.dispose()
  expect(fixture.db.query("SELECT id FROM forge_records WHERE kind IN ('embedding-job','cache')").all()).toEqual([])
  await rejects(fixture.list())
})

test("persisted running jobs recover as interrupted without automatic embedding or overwriting terminal jobs", async () => {
  await using fixture = await setup()
  await fixture.grant()
  await fixture.api.jobs.start(fixture.collection.id)
  const complete = (await fixture.done()).at(0)!
  await fixture.api.dispose()
  const orphan: EmbeddingJob = {
    ...complete,
    id: crypto.randomUUID(),
    revision: crypto.randomUUID(),
    state: "running",
    finished: undefined,
    result: undefined,
  }
  await fixture.storage.embeddingJobSave(fixture.root, orphan)
  const reopened = embeddings({
    ...fixture.host,
    root: fixture.root,
    store: fixture.connect(),
    library: fixture.library,
  })
  try {
    const rows = await reopened.jobs.list(fixture.collection.id)
    expect(rows.find((row) => row.id === orphan.id)!.state).toBe("interrupted")
    expect(rows.find((row) => row.id === complete.id)!.state).toBe("completed")
    expect(fixture.state.sends).toHaveLength(1)
    await rejects(fixture.storage.embeddingJobSave(fixture.root, { ...orphan, state: "completed" }, orphan.revision))
  } finally {
    await reopened.dispose()
  }
})

test("killed worker leaves a persisted interruption that restart observes without sending again", async () => {
  await using fixture = await setup()
  await fixture.grant()
  await fixture.api.dispose()
  fixture.state.hold = true
  const configuration = await fixture.host.configuration()
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "embedding-job-child.ts")], {
    env: {
      ...process.env,
      FORGE_JOB_FIXTURE: JSON.stringify({
        root: fixture.root,
        collection: fixture.collection.id,
        endpoint: configuration!.endpoint,
      }),
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  try {
    await until(
      async () => fixture.state.held.length,
      (count) => count === 1,
    )
    const before = (await fixture.storage.embeddingJobs(fixture.root, fixture.collection.id)).at(0)!
    expect(before.state).toBe("running")
    expect(before.progress.phase).toBe("embedding")
    expect(before.usage).toMatchObject({ attempts: 1, pending: 1, responses: 0, totalReports: 0 })
    const ledger = await fixture.storage.embeddingLedger(fixture.root)
    expect(ledger.entries).toHaveLength(1)
    expect(ledger.entries.at(0)!.usage).toEqual(before.usage!)
    child.kill("SIGKILL")
    await child.exited
    fixture.state.held.at(0)!.resolve()
    const reopened = embeddings({
      ...fixture.host,
      root: fixture.root,
      store: fixture.connect(),
      library: fixture.library,
    })
    try {
      const after = (await reopened.jobs.list(fixture.collection.id)).at(0)!
      expect(after.id).toBe(before.id)
      expect(after.state).toBe("interrupted")
      expect(after.progress).toEqual(before.progress)
      expect(after.usage).toEqual(before.usage)
      expect(await reopened.usage()).toEqual(ledger)
      expect(after.result).toBeUndefined()
      expect(fixture.state.sends).toHaveLength(1)
    } finally {
      await reopened.dispose()
    }
  } finally {
    child.kill("SIGKILL")
    await child.exited
  }
})

test("job history retains the latest sixteen runs and stale checkpoint updates fail atomically", async () => {
  await using fixture = await setup()
  await fixture.grant()
  await fixture.api.jobs.start(fixture.collection.id)
  const value = (await fixture.done()).at(0)!
  for (let index = 1; index <= 20; index++) {
    await fixture.storage.embeddingJobSave(fixture.root, {
      ...value,
      id: `run-${index}`,
      revision: String(index),
      started: value.started + index,
    })
  }
  const rows = await fixture.list()
  expect(rows).toHaveLength(16)
  expect(rows.at(0)?.id).toBe("run-20")
  await rejects(fixture.storage.embeddingJobSave(fixture.root, { ...rows.at(0)!, revision: "wrong" }, "not-current"))
  expect((await fixture.list()).at(0)?.revision).toBe("20")
})

test("engine disposal owns background work but client abort after start does not", async () => {
  await using fixture = await setup()
  await fixture.api.dispose()
  const api = engine({
    root: fixture.root,
    store: fixture.storage,
    embeddings: fixture.host,
    complete: async () => {
      throw new Error("No coding calls")
    },
  })
  await fixture.grant()
  fixture.state.hold = true
  const signal = new AbortController()
  try {
    await api.embeddings!.jobs.start(fixture.collection.id, "", signal.signal)
    signal.abort()
    await until(
      async () => fixture.state.held.length,
      (count) => count === 1,
    )
    expect((await api.embeddings!.jobs.list(fixture.collection.id)).at(0)!.state).toBe("running")
    await api.dispose()
    expect((await fixture.storage.embeddingJobs(fixture.root, fixture.collection.id)).at(0)!.state).toBe("cancelled")
    await rejects(api.embeddings!.jobs.list(fixture.collection.id))
  } finally {
    await api.dispose()
  }
})

test("bounded deadline cancels a noncooperative job without waiting for its result", async () => {
  await using fixture = await setup()
  await fixture.api.dispose()
  const gate = Promise.withResolvers<void>()
  const target = { fingerprint: "local", model: "fixture", dimensions: 2 }
  const jobs = embeddingJobs({
    root: fixture.root,
    store: fixture.storage,
    timeout: 30,
    authorize: async () => undefined,
    prepare: async () => target,
    index: async () => {
      await gate.promise
      return { sections: 0, embedded: 0, reused: 0 }
    },
  })
  try {
    await jobs.start(fixture.collection.id)
    const rows = await until(
      () => jobs.list(fixture.collection.id),
      (rows) => rows.at(0)?.state === "cancelled",
    )
    expect(rows.at(0)?.error).toContain("deadline")
  } finally {
    gate.resolve()
    await jobs.dispose()
  }
})
