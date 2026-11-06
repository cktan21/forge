import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { deadline } from "../src/deadline"
import { engine, type Ports } from "../src/engine"
import { source } from "../src/parse"
import { usage, type Source } from "../src/schema"
import { store } from "../src/store"

const query = "Inspect the journal recovery procedure"
const originals = ["checkpoint", "maintenance"].map((name) =>
  source(`memory:${name}`, `Journal recovery requires a verified ${name} record.`, "summary", {
    method: "kilo-memory-recall",
    inferred: true,
    detail: { session: "chat", query, lineage: "Permitted session memory" },
  }),
)

async function setup(memory: NonNullable<Ports["memory"]>, selector = "ranked") {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "forge-memory-")))
  await Bun.write(path.join(root, ".kilo/forge.jsonc"), JSON.stringify({ selector, budget: 2400 }))
  const db = new Database(path.join(root, ".kilo/catalog.sqlite"))
  const storage = store({
    all: async (query) =>
      db.query<Record<string, unknown>, (string | number | null)[]>(query.text).all(...(query.values ?? [])),
    batch: async (queries) => {
      db.transaction(() => {
        for (const query of queries) db.query(query.text).run(...(query.values ?? []))
      })()
    },
  })
  const calls: Parameters<Ports["complete"]>[0][] = []
  const api = engine({
    root,
    store: storage,
    memory,
    complete: async (input) => {
      calls.push(input)
      return {
        text: JSON.stringify({
          objective: query, reuse: [], inspect: [], changes: [], constraints: [],
          hypotheses: [], questions: [], acceptance: [], verification: [], evidence: [],
        }),
        usage: usage("fixture"),
      }
    },
  })
  return {
    api, calls, storage, root,
    async close() {
      await api.dispose()
      db.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}

const changes: Record<string, (item: Source) => Source[]> = {
  unchanged: (item) => [item],
  observed: (item) => [{ ...item, observed: item.observed + 1000 }],
  "detail-order": (item) => [{ ...item, detail: Object.fromEntries(Object.entries(item.detail).reverse()) }],
  removed: () => [],
  partial: (item) => item.id === originals.at(0)!.id ? [] : [item],
  text: (item) => [{ ...item, text: "Changed memory with a retained adapter hash" }],
  hash: (item) => [{ ...item, hash: "changed" }],
  id: (item) => [{ ...item, id: "different" }],
  uri: (item) => [{ ...item, uri: "memory:different" }],
  method: (item) => [{ ...item, method: "file" }],
  stale: (item) => [{ ...item, status: "stale" }],
  unavailable: (item) => [{ ...item, status: "unavailable" }],
  session: (item) => [{ ...item, detail: { ...item.detail, session: "other" } }],
  query: (item) => [{ ...item, detail: { ...item.detail, query: "different query" } }],
  lineage: (item) => [{ ...item, detail: { ...item.detail, lineage: "Different permission lineage" } }],
  label: (item) => [{ ...item, label: "Different attribution" }],
  kind: (item) => [{ ...item, kind: "document" }],
  start: (item) => [{ ...item, start: 9 }],
  end: (item) => [{ ...item, end: 9 }],
  inferred: (item) => [{ ...item, inferred: false }],
  evidence: (item) => [{ ...item, evidence: ["different"] }],
  denied: () => { throw new Error("Memory permission denied") },
}

for (const phase of ["preparation", "validation"] as const) {
  for (const [action, change] of Object.entries(changes)) {
    test(`${phase}/${action}: require the same current memory original`, async () => {
      let armed = phase === "preparation"
      let recalls = 0
      const fixture = await setup(async (text, session) => {
        expect(text).toBe(query)
        expect(session).toBe("chat")
        recalls++
        return armed && recalls > 1 ? originals.flatMap(change) : originals
      })
      const accepted = ["unchanged", "observed", "detail-order"].includes(action)
      try {
        const result = await fixture.api.enhance({ text: query, session: "chat" }).then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        )
        if (phase === "preparation" && !accepted) {
          expect("error" in result).toBe(true)
          if (!("error" in result)) throw new Error("Changed memory reached completion")
          expect(String(result.error)).toContain("Evidence changed or is unavailable before preparation")
          expect(fixture.calls).toHaveLength(0)
          const latest = await fixture.storage.latest(fixture.root, "chat", "enhance")
          const history = await fixture.api.request(latest!.id, "chat")
          expect(history?.state).toBe("failed")
          expect(history?.entries.map((entry) => entry.source).sort()).toEqual(originals.map((item) => item.id).sort())
          expect(history?.attempts ?? []).toEqual([])
          expect(await fixture.api.request(latest!.id, "other")).toBeUndefined()
          return
        }
        expect("value" in result).toBe(true)
        if (!("value" in result)) throw result.error
        expect(result.value.context.matches.map((item) => item.source.id).sort()).toEqual(originals.map((item) => item.id).sort())
        expect(fixture.calls).toHaveLength(1)
        for (const item of originals) expect(fixture.calls.at(0)!.prompt).toContain(item.text)
        if (phase === "preparation") {
          expect(recalls).toBe(2)
          return
        }
        armed = true
        const before = recalls
        expect(await fixture.api.validate(result.value)).toBe(accepted)
        expect(recalls - before).toBe(1)
        expect(fixture.calls).toHaveLength(1)
        expect((await fixture.api.request(result.value.id, "chat"))?.state).toBe("completed")
      } finally {
        await fixture.close()
      }
    })
  }
}

test("proposal validation recalls each distinct query once and rejects missing scope before recall", async () => {
  const calls: string[] = []
  const records = originals.map((item, index) => ({
    ...item,
    detail: { ...item.detail, query: `${query} ${index}` },
  }))
  const fixture = await setup(async (text, session) => {
    expect(session).toBe("chat")
    calls.push(text)
    return text === query ? originals : records.filter((item) => item.detail.query === text)
  })
  try {
    const draft = await fixture.api.enhance({ text: query, session: "chat" })
    const proposal = {
      ...draft,
      context: { ...draft.context, matches: records.map((source) => ({ source, score: 1, reason: "Memory" })) },
    }
    calls.length = 0
    expect(await fixture.api.validate(proposal)).toBe(true)
    expect(calls).toEqual(records.map((item) => item.detail.query))
    for (const session of [undefined, "", "other"]) {
      calls.length = 0
      expect(await fixture.api.validate({ ...proposal, session })).toBe(false)
      expect(calls).toEqual([])
    }
    calls.length = 0
    expect(await fixture.api.validate({
      ...proposal,
      context: {
        ...proposal.context,
        matches: proposal.context.matches.map((item) => ({
          ...item, source: { ...item.source, detail: { session: "chat" } },
        })),
      },
    })).toBe(false)
    expect(calls).toEqual([])
  } finally {
    await fixture.close()
  }
})

for (const selector of ["ranked", "greedy", "knapsack"]) {
  test(`${selector}: cancellation discards noncooperative memory revalidation`, async () => {
    const reached = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const finished = Promise.withResolvers<void>()
    const controller = new AbortController()
    let recalls = 0
    let signal: AbortSignal | undefined
    const fixture = await setup(async (_query, _session, input) => {
      if (++recalls === 1) return originals
      signal = input
      reached.resolve()
      await release.promise
      finished.resolve()
      return originals
    }, selector)
    const pending = fixture.api.enhance({ text: query, session: "chat", signal: controller.signal }).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    )
    try {
      await deadline(() => reached.promise, undefined, 2000)
      controller.abort(new Error("Cancelled memory handoff"))
      const result = await deadline(() => pending, undefined, 2000)
      expect("error" in result).toBe(true)
      if (!("error" in result)) throw new Error("Cancellation reached completion")
      expect(String(result.error)).toContain("Cancelled memory handoff")
      expect(signal?.aborted).toBe(true)
      release.resolve()
      await deadline(() => finished.promise, undefined, 2000)
      expect(fixture.calls).toHaveLength(0)
      const latest = await fixture.storage.latest(fixture.root, "chat", "enhance")
      const history = await fixture.api.request(latest!.id, "chat")
      expect(history?.state).toBe("failed")
      expect(history?.attempts ?? []).toEqual([])
      expect(history?.entries).toHaveLength(2)
    } finally {
      controller.abort()
      release.resolve()
      await pending
      await fixture.close()
    }
  })
}
