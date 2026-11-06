import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { deadline } from "../src/deadline"
import { engine } from "../src/engine"
import { knowledge } from "../src/knowledge"
import { usage, type Collection } from "../src/schema"
import { store } from "../src/store"

test("consent snapshots are scoped, single-statement reads across separate SQLite connections", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "forge-consent-store-")))
  const file = path.join(root, "catalog.sqlite")
  const reader = new Database(file)
  const writer = new Database(file)
  let reads = 0
  function connect(db: Database) {
    return store({
      all: async (query) => {
        if (db === reader) reads++
        return db.query<Record<string, unknown>, (string | number | null)[]>(query.text).all(...query.values ?? [])
      },
      batch: async (queries) => {
        db.transaction(() => { for (const query of queries) db.query(query.text).run(...query.values ?? []) })()
      },
    })
  }
  const storage = connect(reader)
  const other = connect(writer)
  const collection: Collection = {
    id: "selected", label: "Selected", kind: "text", location: "", session: "", origin: "interface",
    include: [], exclude: [], watch: false, approved: true, providers: ["approved"], state: "ready",
    observed: 1, generation: "first", files: 1, chunks: 1, warnings: [],
  }
  try {
    await other.save(root, collection)
    await other.save(root, { ...collection, id: "unselected" })
    const before = reads
    const initial = await storage.consent(root, "chat", ["selected"])
    expect(reads - before).toBe(1)
    expect(await storage.consent(root, "chat", ["selected", "selected"])).toBe(initial)
    await other.save(`${root}/other`, { ...collection, state: "removed" })
    await other.save(root, { ...collection, id: "unselected", state: "paused" })
    await other.policySave(root, { version: "other", session: "other", pin: [], exclude: ["selected"] })
    expect(await storage.consent(root, "chat", ["selected"])).toBe(initial)
    await other.save(root, { ...collection, providers: [], state: "paused" })
    expect(await storage.consent(root, "chat", ["selected"])).not.toBe(initial)
    await other.save(root, collection)
    expect(await storage.consent(root, "chat", ["selected"])).toBe(initial)
    for (const session of ["", "chat"]) {
      const current = await storage.consent(root, "chat", ["selected"])
      await other.policySave(root, { version: session || "workspace", session, pin: [], exclude: ["selected"] })
      expect(await storage.consent(root, "chat", ["selected"])).not.toBe(current)
    }
    const current = await storage.consent(root, "chat", ["selected"])
    await other.purge(root, "selected")
    expect(await storage.consent(root, "chat", ["selected"])).not.toBe(current)
  } finally {
    reader.close()
    writer.close()
    await rm(root, { recursive: true, force: true })
  }
})

for (const phase of ["preparation", "acceptance"] as const) {
  for (const action of ["pause", "remove", "revoke", "workspace-policy", "session-policy", "other-policy", "unrelated", "unchanged"] as const) {
    test(`${phase}/${action}: earlier collection checks cannot outlive later authorization`, async () => {
      const root = await realpath(await mkdtemp(path.join(tmpdir(), "forge-collection-handoff-")))
      await Bun.write(path.join(root, ".kilo/forge.jsonc"), JSON.stringify({ budget: 2400, exclude: [".kilo/**"] }))
      const db = new Database(path.join(root, ".kilo/catalog.sqlite"))
      const storage = store({
        all: async (query) => db.query<Record<string, unknown>, (string | number | null)[]>(query.text).all(...query.values ?? []),
        batch: async (queries) => {
          db.transaction(() => { for (const query of queries) db.query(query.text).run(...query.values ?? []) })()
        },
      })
      const library = knowledge(root, storage)
      const reached = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const collections: Collection[] = []
      let armed = false
      let checks = 0
      let calls = 0
      const api = engine({
        root, store: storage, provider: async () => "approved",
        authorize: async (item) => {
          if (!armed || item.id !== collections.at(1)?.id) return
          if (phase === "preparation" && (await storage.latest(root, "chat", "enhance"))?.state !== "assembled") return
          checks++
          // Preparation first authorizes collections, then validates their files.
          if (checks !== (phase === "preparation" ? 2 : 1)) return
          reached.resolve()
          await release.promise
        },
        complete: async () => {
          calls++
          return {
            text: JSON.stringify({
              objective: "Inspect recovery", reuse: [], inspect: [], changes: [], constraints: [],
              hypotheses: [], questions: [], acceptance: [], verification: [], evidence: [],
            }),
            usage: usage("local-fixture"),
          }
        },
      })
      try {
        for (const name of ["first", "second", "unrelated"]) {
          const file = path.join(root, ".kilo", `${name}.txt`)
          await Bun.write(file, `${name} recovery requires an approved checkpoint.`)
          const item = await library.register({ kind: "file", location: file, label: name })
          await library.approve(item.id, "", ["approved"])
          await library.index(item.id)
          collections.push((await storage.collection(root, item.id))!)
        }
        const originals = await storage.knowledge(root, "chat", "approved")
        const pins = collections.slice(0, 2).map((item) => originals.find((source) =>
          source.detail.collection === item.id && source.method === "collection-section")!.id)
        const input = { text: "Inspect recovery", session: "chat", pin: pins, exclude: originals.filter((item) => item.detail.collection === collections.at(2)!.id).map((item) => item.id) }
        const proposal = phase === "acceptance" ? await api.enhance(input) : undefined
        if (proposal) expect(proposal.context.matches.map((item) => item.source.id)).toEqual(pins)
        armed = true
        const pending = (proposal ? api.validate(proposal) : api.enhance(input))
          .then((value) => ({ value }), (error: unknown) => ({ error }))
        try {
          await deadline(() => reached.promise, undefined, 2000)
          const first = collections.at(0)!
          if (action === "pause") await library.stop(first.id)
          if (action === "remove") await library.stop(first.id, "", true)
          if (action === "revoke") await library.approve(first.id, "", [])
          if (action === "unrelated") await library.stop(collections.at(2)!.id)
          if (action.endsWith("-policy")) {
            const session = action === "workspace-policy" ? "" : action === "session-policy" ? "chat" : "other"
            await api.configure({ ...await api.policy(session), exclude: [pins.at(0)!] })
          }
        } finally {
          release.resolve()
        }
        const result = await pending
        const accepted = ["unchanged", "unrelated", "other-policy"].includes(action)
        if (phase === "acceptance") {
          expect(result).toEqual({ value: accepted })
          expect(calls).toBe(1)
          return
        }
        expect("value" in result).toBe(accepted)
        expect(calls).toBe(accepted ? 1 : 0)
        if ("value" in result && typeof result.value !== "boolean") {
          expect(result.value.context.matches.map((item) => item.source.id)).toEqual(pins)
        }
        const latest = (await storage.latest(root, "chat", "enhance"))!
        const history = await api.request(latest.id, "chat")
        expect(history?.state).toBe(accepted ? "completed" : "failed")
        expect(history?.entries.map((item) => item.source)).toEqual(pins)
        expect(await api.request(latest.id, "other")).toBeUndefined()
      } finally {
        release.resolve()
        await Promise.all([api.dispose(), library.dispose()])
        db.close()
        await rm(root, { recursive: true, force: true })
      }
    })
  }
}
