import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { engine, type Ports } from "../src/engine"
import { source } from "../src/parse"
import { usage, type Source } from "../src/schema"
import { store } from "../src/store"

async function setup(complete?: Ports["complete"]) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "forge-evidence-")))
  const db = new Database(":memory:")
  const storage = store({
    all: async (query) => db.query<Record<string, unknown>, (string | number | null)[]>(query.text).all(...query.values ?? []),
    batch: async (queries) => {
      db.transaction(() => {
        for (const query of queries) db.query(query.text).run(...query.values ?? [])
      })()
    },
  })
  const api = engine({
    root,
    store: storage,
    complete: complete ?? (async () => { throw new Error("Unexpected model call") }),
  })
  await mkdir(path.join(root, ".kilo"))
  await Bun.write(path.join(root, "queue.ts"), "export const queue = ['waiting']")
  return {
    root, storage, api, db,
    configure: (value: unknown) => Bun.write(path.join(root, ".kilo/forge.jsonc"), JSON.stringify(value)),
    async [Symbol.asyncDispose]() {
      api.dispose()
      db.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}

function summary(name: string, dependencies: Source[]) {
  return source(`summary:${name}`, `Queue evidence ${name}`, "summary", {
    evidence: dependencies.map((item) => item.id),
    detail: { dependencies: JSON.stringify(Object.fromEntries(dependencies.map((item) => [item.id, item.hash]))) },
  })
}

test("legacy workspace summaries cannot expose session-private dependencies in previews", async () => {
  await using fixture = await setup()
  const privateSource = source("private:note", "private-scope-canary", "summary", { detail: { session: "private" } })
  const first = { ...summary("legacy-private", [privateSource]), text: "private-scope-canary" }
  const second = { ...summary("legacy-copy", [first]), text: "private-scope-canary" }
  for (const item of [privateSource, first, second]) await fixture.storage.external(fixture.root, item)
  await fixture.api.refresh()
  expect(JSON.stringify(await fixture.api.graph())).not.toContain("private-scope-canary")
  expect(JSON.stringify(await fixture.api.view({ session: "other" }))).not.toContain("private-scope-canary")
  await expect(fixture.api.symbol(second.id)).rejects.toThrow("withheld")
  expect((await fixture.api.retrieve("private scope canary")).matches.some((item) => [first.id, second.id].includes(item.source.id))).toBe(false)
})

test("transitive evidence remains current, retains edges, and invalidates through unchanged hashes", async () => {
  await using fixture = await setup()
  const initial = await fixture.api.refresh()
  const code = initial.sources.find((item) => item.uri === "queue.ts" && item.method === "file")!
  const first = summary("first", [code])
  const second = summary("second", [first])
  const third = summary("third", [first, second])
  for (const item of [third, second, first]) await fixture.storage.external(fixture.root, item)
  const current = await fixture.api.refresh(true)
  expect(current.sources.filter((item) => item.kind === "summary").every((item) => item.status === "current")).toBe(true)
  expect(current.relations.some((item) => item.from === third.id && item.to === second.id)).toBe(true)
  expect((await fixture.api.retrieve("Queue evidence")).matches.some((item) => item.source.id === third.id)).toBe(true)
  await fixture.storage.external(fixture.root, { ...first, status: "unavailable" })
  const unavailable = await fixture.api.refresh(true)
  expect(unavailable.sources.find((item) => item.id === first.id)?.status).toBe("unavailable")
  expect(unavailable.sources.find((item) => item.id === third.id)?.status).toBe("stale")
  await fixture.storage.external(fixture.root, first)
  expect((await fixture.api.refresh(true)).sources.find((item) => item.id === third.id)?.status).toBe("current")
  await Bun.write(path.join(fixture.root, "queue.ts"), "export const queue = []")
  const changed = await fixture.api.refresh(true)
  const ids = [first.id, second.id, third.id]
  expect(changed.sources.filter((item) => ids.includes(item.id)).map((item) => item.status)).toEqual(["stale", "stale", "stale"])
  expect((await fixture.api.retrieve("Queue evidence")).matches.some((item) => ids.includes(item.source.id))).toBe(false)
  const brief = changed.sources.find((item) => item.method === "domain-index")!
  expect(brief.status).toBe("current")
  expect(brief.evidence).toContain(code.id)
  expect(JSON.parse(brief.detail.dependencies!)[code.id]).toBe(changed.sources.find((item) => item.id === code.id)!.hash)
})

test("cycles, missing dependencies and malformed fingerprints fail closed without blocking refresh", async () => {
  await using fixture = await setup()
  const first = summary("cycle-first", [])
  const second = summary("cycle-second", [first])
  const cycle = { ...first, evidence: [second.id], detail: { dependencies: JSON.stringify({ [second.id]: second.hash }) } }
  const self = summary("self", [])
  const items = [
    cycle,
    second,
    summary("dependent", [cycle]),
    { ...self, evidence: [self.id], detail: { dependencies: JSON.stringify({ [self.id]: self.hash }) } },
    summary("missing", [source("missing.ts", "absent", "code")]),
    { ...summary("malformed", []), detail: { dependencies: "{" } },
    { ...summary("invalid", []), detail: { dependencies: JSON.stringify({ unknown: 42 }) } },
  ]
  for (const item of items) await fixture.storage.external(fixture.root, item)
  const snapshot = await fixture.api.refresh()
  const summaries = snapshot.sources.filter((item) => items.some((fixture) => fixture.id === item.id))
  expect(summaries).toHaveLength(items.length)
  expect(summaries.every((item) => item.status === "stale")).toBe(true)
  expect((await fixture.api.graph()).warnings.some((item) => item.includes("Invalid evidence dependencies"))).toBe(true)
})

test("removing or switching configured providers invalidates evidence and transitive summaries", async () => {
  await using fixture = await setup()
  const cfg = { documents: { server: "docs" }, database: { server: "db", resource: "schema:one" } }
  await fixture.configure(cfg)
  const initial = await fixture.api.refresh()
  const code = initial.sources.find((item) => item.uri === "queue.ts" && item.method === "file")!
  const docs = source("mcp:docs:queue", "Queue documentation", "document", {
    method: "context7", evidence: [code.id],
    detail: { server: "docs", dependencies: JSON.stringify({ [code.id]: code.hash }) },
  })
  const schema = source("mcp:db:schema:one", "Queue table", "schema", {
    method: "configured-postgresql-metadata", detail: { server: "db", resource: "schema:one" },
  })
  const derived = summary("providers", [docs, schema])
  for (const item of [docs, schema, derived]) await fixture.storage.external(fixture.root, item)
  expect((await fixture.api.refresh(true)).sources.find((item) => item.id === derived.id)?.status).toBe("current")
  for (const value of [
    {},
    { documents: { server: "other" }, database: { server: "other", resource: "schema:one" } },
    { ...cfg, database: { server: "db", resource: "schema:two" } },
  ]) {
    await fixture.configure(value)
    expect((await fixture.api.refresh(true)).sources.find((item) => item.id === derived.id)?.status).toBe("stale")
  }
  await fixture.configure(cfg)
  expect((await fixture.api.refresh(true)).sources.find((item) => item.id === derived.id)?.status).toBe("current")
  await fixture.storage.external(fixture.root, { ...docs, observed: Date.now() - 25 * 60 * 60 * 1000 })
  expect((await fixture.api.refresh(true)).sources.find((item) => item.id === derived.id)?.status).toBe("stale")
  await fixture.storage.external(fixture.root, { ...docs, detail: { server: "docs" } })
  expect((await fixture.api.refresh(true)).sources.find((item) => item.id === docs.id)?.status).toBe("stale")
})

test("regeneration preserves confirmation and counterevidence changes invalidate opportunity sources", async () => {
  let evidence = ""
  let counter = ""
  await using fixture = await setup(async () => ({
    text: JSON.stringify({ opportunities: [{
      title: "Queue ordering", benefit: "Preserve queue order", evidence: [evidence],
      counterevidence: [counter], uncertainty: "Check callers", verification: "Test queue order", prompt: "Preserve queue order",
    }] }),
    usage: usage("fixture"),
  }))
  await Bun.write(path.join(fixture.root, "counter.md"), "Queue ordering: callers might already preserve queue order.")
  const initial = await fixture.api.refresh()
  evidence = initial.sources.find((item) => item.uri === "queue.ts" && item.method === "file")!.id
  counter = initial.sources.find((item) => item.uri === "counter.md" && item.method === "file")!.id
  const first = (await fixture.api.ideas("Queue ordering")).at(0)!
  await fixture.api.decide(first.id, "confirmed")
  expect((await fixture.api.ideas("Queue ordering")).at(0)?.status).toBe("confirmed")
  const before = await fixture.api.refresh(true)
  const indexed = before.sources.find((item) => item.uri === `opportunity:${first.id}`)!
  expect(indexed.evidence).toContain(counter)
  expect(indexed.status).toBe("current")
  await Bun.write(path.join(fixture.root, "counter.md"), "Queue ordering: callers already preserve queue order.")
  const changed = await fixture.api.refresh(true)
  expect(changed.sources.find((item) => item.id === indexed.id)?.status).toBe("stale")
  expect((await fixture.api.opportunities()).find((item) => item.id === first.id)?.status).toBe("stale")
  await fixture.api.decide(first.id, "superseded")
  expect(await fixture.api.ideas("Queue ordering")).toEqual([])
  expect((await fixture.api.opportunities()).find((item) => item.id === first.id)?.status).toBe("superseded")
})

for (const phase of ["ideas", "idea-review"]) {
  test(`rejection during ${phase} survives regeneration and invalidates indexed supporting evidence`, async () => {
    const started = Promise.withResolvers<void>()
    const resume = Promise.withResolvers<void>()
    let paused = false
    let evidence = ""
    await using fixture = await setup(async (input) => {
      if (paused && input.purpose === phase) {
        started.resolve()
        await resume.promise
      }
      return {
        text: JSON.stringify({ opportunities: [{
          title: "Queue ordering", benefit: "Preserve queue order", evidence: [evidence],
          counterevidence: [], uncertainty: "Check callers", verification: "Test queue order", prompt: "Preserve queue order",
        }] }),
        usage: usage("fixture"),
      }
    })
    const initial = await fixture.api.refresh()
    evidence = initial.sources.find((item) => item.uri === "queue.ts" && item.method === "file")!.id
    const first = (await fixture.api.ideas("Queue ordering")).at(0)!
    const before = await fixture.api.refresh(true)
    const indexed = before.sources.find((item) => item.uri === `opportunity:${first.id}`)!
    const derived = summary("opportunity", [indexed])
    await fixture.storage.external(fixture.root, derived)
    paused = true
    const pending = fixture.api.ideas("Queue ordering")
    try {
      await started.promise
      await fixture.api.decide(first.id, "rejected")
      expect((await fixture.storage.externals(fixture.root)).find((item) => item.id === indexed.id)?.detail.status).toBe("rejected")
      expect((await fixture.storage.search(fixture.root, "Queue ordering")).find((item) => item.source.id === indexed.id)?.source.status).not.toBe("current")
      expect((await fixture.api.retrieve("Queue ordering")).matches.some((item) => item.source.id === indexed.id)).toBe(false)
    } finally {
      resume.resolve()
    }
    expect(await pending).toEqual([])
    expect((await fixture.api.opportunities()).find((item) => item.id === first.id)?.status).toBe("rejected")
    const current = await fixture.api.refresh(true)
    expect(current.sources.find((item) => item.id === indexed.id)?.status).toBe("stale")
    expect(current.sources.find((item) => item.id === derived.id)?.status).toBe("stale")
    expect((await fixture.storage.search(fixture.root, "Queue ordering")).find((item) => item.source.id === indexed.id)?.source.status).not.toBe("current")
    expect((await fixture.api.retrieve("Queue ordering")).matches.some((item) => item.source.id === indexed.id)).toBe(false)
  })
}

for (const status of ["rejected", "superseded", "confirmed"] as const) {
  test(`regeneration and decisions preserve an older ${status} opportunity beyond the latest 100`, async () => {
    let evidence = ""
    await using fixture = await setup(async () => ({
      text: JSON.stringify({ opportunities: [{
        title: "Queue ordering", benefit: "Preserve queue order", evidence: [evidence],
        counterevidence: [], uncertainty: "Check callers", verification: "Test queue order", prompt: "Preserve queue order",
      }] }),
      usage: usage("fixture"),
    }))
    evidence = (await fixture.api.refresh()).sources.find((item) => item.uri === "queue.ts" && item.method === "file")!.id
    const first = (await fixture.api.ideas("Queue ordering")).at(0)!
    const indexed = (await fixture.storage.externals(fixture.root)).find((item) => item.uri === `opportunity:${first.id}`)!
    await fixture.api.decide(first.id, status)
    fixture.db.query("UPDATE forge_records SET updated = 0 WHERE kind = 'opportunity' AND id = ?").run(first.id)
    for (let index = 0; index < 101; index++) {
      await fixture.storage.opportunity(fixture.root, { ...first, id: `newer-${index}`, title: `Newer ${index}` })
    }
    expect((await fixture.api.opportunities()).some((item) => item.id === first.id)).toBe(false)
    expect(await fixture.storage.decision("another-workspace", first.id)).toBeUndefined()
    expect((await fixture.storage.decision(fixture.root, first.id))?.status).toBe(status)
    await fixture.storage.external(fixture.root, indexed)
    expect((await fixture.api.refresh(true)).sources.find((item) => item.id === indexed.id)?.status).toBe(status === "confirmed" ? "current" : "stale")
    const generated = await fixture.api.ideas("Queue ordering")
    expect(generated.map((item) => item.status)).toEqual(status === "confirmed" ? ["confirmed"] : [])
    expect(fixture.db.query("SELECT json_extract(body, '$.status') AS status FROM forge_records WHERE kind = 'opportunity' AND id = ?").get(first.id)).toEqual({ status })
    expect((await fixture.api.decide(first.id, status)).status).toBe(status)
  })
}

for (const phase of ["ideas", "idea-review"]) {
  test(`rejected support during ${phase} cannot publish an opportunity with a new ID`, async () => {
    const started = Promise.withResolvers<void>()
    const resume = Promise.withResolvers<void>()
    const requests: Parameters<Ports["complete"]>[0][] = []
    let paused = false
    let evidence = ""
    await using fixture = await setup(async (input) => {
      requests.push(input)
      if (paused && input.purpose === phase) {
        started.resolve()
        await resume.promise
      }
      return {
        text: JSON.stringify({ opportunities: [{
          title: paused ? "Queue delivery" : "Queue ordering", benefit: "Preserve queue order", evidence: [evidence],
          counterevidence: [], uncertainty: "Check callers", verification: "Test queue order", prompt: "Preserve queue order",
        }] }),
        usage: usage("fixture"),
      }
    })
    evidence = (await fixture.api.refresh()).sources.find((item) => item.uri === "queue.ts" && item.method === "file")!.id
    const first = (await fixture.api.ideas("Queue ordering")).at(0)!
    const indexed = (await fixture.api.refresh(true)).sources.find((item) => item.uri === `opportunity:${first.id}`)!
    evidence = indexed.id
    paused = true
    const pending = fixture.api.ideas("Queue ordering")
    try {
      await started.promise
      expect(requests.at(-1)?.prompt).toContain(`[${indexed.id}]`)
      await fixture.api.decide(first.id, "rejected")
    } finally {
      resume.resolve()
    }
    expect(await pending).toEqual([])
    expect((await fixture.api.opportunities()).map((item) => item.id)).toEqual([first.id])
    expect((await fixture.storage.externals(fixture.root)).some((item) => item.label === "Queue delivery")).toBe(false)
    if (phase === "ideas") expect(requests.filter((item) => item.purpose === "idea-review")).toHaveLength(1)
  })
}

for (const refreshed of [false, true]) for (const change of ["expiry", "provider", "disabled", "rejection", "fingerprint"]) {
  test(`overview cache revalidates transitive evidence after ${change}, explicit refresh: ${refreshed}`, async () => {
    let evidence = ""
    let calls = 0
    const requests: Parameters<Ports["complete"]>[0][] = []
    await using fixture = await setup(async (input) => {
      requests.push(input)
      calls++
      return { text: JSON.stringify({ summary: `Queue overview ${calls}`, evidence: [evidence] }), usage: usage("fixture") }
    })
    const exclude = [".kilo/forge.jsonc"]
    await fixture.configure({ exclude, documents: { server: "docs" } })
    const initial = await fixture.api.refresh()
    const code = initial.sources.find((item) => item.uri === "queue.ts" && item.method === "file")!
    const docs = source("mcp:docs:queue", "Queue documentation", "document", {
      method: "context7", evidence: [code.id],
      detail: { server: "docs", dependencies: JSON.stringify({ [code.id]: code.hash }) },
    })
    const support = source("opportunity:support", "Queue opportunity", "opportunity", {
      evidence: [code.id], detail: { status: "proposed", dependencies: JSON.stringify({ [code.id]: code.hash }) },
    })
    await fixture.storage.opportunity(fixture.root, {
      id: "support", title: "Queue support", goal: "", benefit: "", evidence: [code.id], counterevidence: [],
      uncertainty: "", verification: "", prompt: "", generation: initial.generation, observed: Date.now(), status: "proposed",
    })
    const derived = summary("cached", [docs, support])
    for (const item of [docs, support, derived]) await fixture.storage.external(fixture.root, item)
    await fixture.api.refresh(true)
    evidence = derived.id
    const first = await fixture.api.overview()
    expect(first.evidence).toEqual([derived.id])
    expect((await fixture.api.overview()).usage.model).toBe("cached")
    expect(calls).toBe(1)
    if (change === "expiry") await fixture.storage.external(fixture.root, { ...docs, observed: Date.now() - 25 * 60 * 60 * 1000 })
    if (change === "provider") await fixture.configure({ exclude, documents: { server: "other" } })
    if (change === "disabled") await fixture.configure({ exclude })
    if (change === "rejection") await fixture.api.decide("support", "rejected")
    if (change === "fingerprint") await fixture.storage.external(fixture.root, { ...derived, detail: { ...derived.detail, revision: "changed" } })
    if (refreshed) expect((await fixture.api.refresh(true)).generation).toBe(first.snapshot.generation)
    evidence = code.id
    const next = await fixture.api.overview()
    expect(calls).toBe(2)
    expect(next.usage.model).toBe("fixture")
    expect(next.evidence).toEqual([code.id])
    expect(next.snapshot.generation).toBe(first.snapshot.generation)
    if (change !== "fingerprint") expect(requests.at(-1)?.prompt).not.toContain(`[${derived.id}]`)
    expect((await fixture.api.overview()).usage.model).toBe("cached")
    expect(calls).toBe(2)
  })
}

test("overview cache rejects a directly cited expired document without an explicit refresh", async () => {
  let evidence = ""
  let calls = 0
  await using fixture = await setup(async () => {
    calls++
    return { text: JSON.stringify({ summary: "Queue overview", evidence: [evidence] }), usage: usage("fixture") }
  })
  await fixture.configure({ documents: { server: "docs" } })
  const initial = await fixture.api.refresh()
  const code = initial.sources.find((item) => item.uri === "queue.ts" && item.method === "file")!
  const docs = source("mcp:docs:direct", "Queue documentation", "document", {
    method: "context7", evidence: [code.id],
    detail: { server: "docs", dependencies: JSON.stringify({ [code.id]: code.hash }) },
  })
  await fixture.storage.external(fixture.root, docs)
  evidence = docs.id
  expect((await fixture.api.overview()).evidence).toEqual([docs.id])
  expect((await fixture.api.overview()).usage.model).toBe("cached")
  await fixture.storage.external(fixture.root, { ...docs, observed: Date.now() - 25 * 60 * 60 * 1000 })
  evidence = code.id
  expect((await fixture.api.overview()).evidence).toEqual([code.id])
  expect(calls).toBe(2)
})

test("overview does not publish evidence that becomes unavailable during generation", async () => {
  const started = Promise.withResolvers<void>()
  const resume = Promise.withResolvers<void>()
  let evidence = ""
  await using fixture = await setup(async () => {
    started.resolve()
    await resume.promise
    return { text: JSON.stringify({ summary: "Queue overview", evidence: [evidence] }), usage: usage("fixture") }
  })
  const initial = await fixture.api.refresh()
  const code = initial.sources.find((item) => item.uri === "queue.ts" && item.method === "file")!
  const derived = summary("overview-support", [code])
  await fixture.storage.external(fixture.root, derived)
  evidence = derived.id
  const pending = fixture.api.overview()
  try {
    await started.promise
    await fixture.storage.external(fixture.root, { ...derived, status: "unavailable" })
  } finally {
    resume.resolve()
  }
  expect(await pending.then(() => "unexpected success", (err: Error) => err.message)).toContain("Overview evidence changed")
  expect((await fixture.storage.externals(fixture.root)).some((item) => item.method === "subsystem-summary")).toBe(false)
  expect(await fixture.storage.cached(fixture.root, `overview:v2:${initial.generation}`)).toBeUndefined()
})
