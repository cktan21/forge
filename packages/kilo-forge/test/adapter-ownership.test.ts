import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { engine, type Ports } from "../src/engine"
import { knowledge } from "../src/knowledge"
import { source } from "../src/parse"
import { usage, type Source } from "../src/schema"
import { store } from "../src/store"

const text = "Checkpoint recovery requires the original signed journal."
const canary = "Adapter replacement canary must never become registered evidence."
const query = "checkpoint recovery"

async function setup(selector: string, channel: "docs" | "memory", session = "") {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "forge-ownership-")))
  await Bun.write(
    path.join(root, ".kilo/forge.jsonc"),
    JSON.stringify({ selector, budget: 2400, exclude: [".kilo/**"] }),
  )
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
  const library = knowledge(root, storage)
  const collection = await library.register({ kind: "text", label: "Recovery", location: "", content: text, session })
  await library.approve(collection.id, session, ["test"])
  await library.index(collection.id, session)
  const original = (await storage.knowledge(root, session, "test")).find(
    (item) => item.method === "collection-section",
  )!
  const records: Source[] = []
  const calls: Parameters<Ports["complete"]>[0][] = []
  const api = engine({
    root,
    store: storage,
    provider: async () => "test",
    ...(channel === "docs" ? { docs: async () => records } : { memory: async () => records }),
    complete: async (input) => {
      calls.push(input)
      return {
        text: JSON.stringify({
          objective: query,
          reuse: [],
          inspect: [],
          changes: [],
          constraints: [],
          hypotheses: [],
          questions: [],
          acceptance: [],
          verification: [],
          evidence: [],
        }),
        usage: usage("fixture"),
      }
    },
  })
  return {
    root,
    db,
    storage,
    library,
    api,
    original,
    records,
    calls,
    async close() {
      await Promise.all([api.dispose(), library.dispose()])
      db.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}

for (const selector of ["ranked", "greedy", "knapsack"]) {
  for (const session of ["", "private"]) {
    for (const mutation of ["unchanged", "content", "stripped", "stale"] as const) {
      test(`${selector}/${session || "workspace"}/${mutation}: document adapters cannot replace registered sources`, async () => {
        const fixture = await setup(selector, "docs", session)
        try {
          fixture.records.push(
            mutation === "unchanged"
              ? fixture.original
              : {
                  ...fixture.original,
                  text: mutation === "stale" ? text : canary,
                  ...(mutation === "stripped"
                    ? { detail: {}, uri: "adapter:replacement", method: "adapter-document" }
                    : {}),
                  ...(mutation === "stale" ? { status: "stale" as const } : {}),
                },
          )
          const result = await fixture.api.lookup({ query, session: "chat", tool: "forge_search_docs" })
          expect(result.result.text).not.toContain(canary)
          const match = result.result.matches.find((item) => item.source.id === fixture.original.id)
          if (!session) expect(match?.source).toEqual(fixture.original)
          if (session) expect(match).toBeUndefined()
          expect(JSON.stringify(result.result)).not.toContain(canary)
          expect((await fixture.storage.externals(fixture.root)).some((item) => item.id === fixture.original.id)).toBe(
            false,
          )
          expect((await fixture.api.request(result.request, "chat"))?.selection).toEqual(result.result.audit)
          expect(await fixture.api.request(result.request, "other")).toBeUndefined()
          await fixture.api.refresh(true)
          expect(await fixture.storage.source(fixture.root, fixture.original.id)).toEqual(fixture.original)
          const again = await fixture.api.lookup({ query, session: "chat", tool: "forge_search_docs" })
          expect(again.result.text).not.toContain(canary)
          if (!session) {
            expect(again.result.matches.find((item) => item.source.id === fixture.original.id)?.source).toEqual(
              fixture.original,
            )
            const draft = await fixture.api.enhance({ text: query, session: "chat" })
            expect(draft.context.matches.find((item) => item.source.id === fixture.original.id)?.source).toEqual(
              fixture.original,
            )
            expect(fixture.calls).toHaveLength(1)
            expect(fixture.calls.at(0)?.prompt).toContain(text)
            expect(fixture.calls.at(0)?.prompt).not.toContain(canary)
          }
          const excluded = await fixture.api.retrieve(query, {
            session: "chat",
            docs: true,
            exclude: [fixture.original.id],
          })
          expect(excluded.matches.some((item) => item.source.id === fixture.original.id)).toBe(false)
        } finally {
          await fixture.close()
        }
      })
    }
  }

  for (const stripped of [false, true]) {
    test(`${selector}/memory/${stripped}: memory cannot impersonate a registered source`, async () => {
      const fixture = await setup(selector, "memory")
      try {
        fixture.records.push({
          ...fixture.original,
          text: canary,
          method: "kilo-memory-recall",
          detail: { ...(stripped ? {} : fixture.original.detail), session: "chat", query },
        })
        const result = await fixture.api.lookup({ query, session: "chat", tool: "forge_search_code" })
        expect(result.result.text).not.toContain(canary)
        expect(result.result.matches.find((item) => item.source.id === fixture.original.id)?.source).toEqual(
          fixture.original,
        )
        expect(result.result.audit?.channels?.find((item) => item.name === "memory")?.withheld).toBe(1)
        expect(await fixture.storage.source(fixture.root, fixture.original.id)).toEqual(fixture.original)
      } finally {
        await fixture.close()
      }
    })
  }

  for (const stripped of [false, true]) {
    test(`${selector}/legacy/${stripped}: duplicate collection records cannot overwrite registered originals on refresh`, async () => {
      const fixture = await setup(selector, "docs")
      try {
        const duplicate = { ...fixture.original, text: canary, ...(stripped ? { detail: {} } : {}) }
        await fixture.storage.external(fixture.root, duplicate)
        await fixture.api.refresh(true)
        expect(await fixture.storage.source(fixture.root, fixture.original.id)).toEqual(fixture.original)
        const result = await fixture.api.retrieve(query, { session: "chat" })
        expect(result.matches.find((item) => item.source.id === fixture.original.id)?.source).toEqual(fixture.original)
        expect(JSON.stringify(result)).not.toContain(canary)
        // Ignore legacy duplication without silently deleting stored history.
        expect((await fixture.storage.externals(fixture.root)).find((item) => item.id === duplicate.id)).toEqual(
          duplicate,
        )
        const independent = source("adapter:independent", "Independent recovery reference.", "document", {
          method: "adapter-document",
        })
        fixture.records.push(independent)
        const selected = await fixture.api.retrieve(query, { session: "chat", docs: true })
        expect(selected.matches.find((item) => item.source.id === independent.id)?.source).toEqual(independent)
        expect((await fixture.storage.externals(fixture.root)).find((item) => item.id === independent.id)).toEqual(
          independent,
        )
      } finally {
        await fixture.close()
      }
    })
  }
}
