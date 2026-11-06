import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { deadline } from "../src/deadline"
import { engine } from "../src/engine"
import { knowledge } from "../src/knowledge"
import { retrieval } from "../src/retrieval"
import type { RetrievalRun, Source } from "../src/schema"
import { store } from "../src/store"

for (const mode of ["retrieve-checks", "lookup-checks", "retrieve-journal", "lookup-journal", "lookup-capture"] as const) {
  for (const action of ["pause", "remove", "revoke", "workspace-policy", "session-policy", "other-policy", "unrelated", "cancel", "unchanged"] as const) {
    test(`${mode}/${action}: returned evidence stays authorized across asynchronous publication`, async () => {
      const root = await realpath(await mkdtemp(path.join(tmpdir(), "forge-retrieval-handoff-")))
      await Bun.write(path.join(root, ".kilo/forge.jsonc"), JSON.stringify({ budget: 2400, exclude: [".kilo/**"] }))
      const db = new Database(path.join(root, ".kilo/catalog.sqlite"))
      const storage = store({
        all: async (query) => db.query<Record<string, unknown>, (string | number | null)[]>(query.text).all(...query.values ?? []),
        batch: async (queries) => {
          db.transaction(() => { for (const query of queries) db.query(query.text).run(...query.values ?? []) })()
        },
      })
      const library = knowledge(root, storage)
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const controller = new AbortController()
      const saved: RetrievalRun[] = []
      const visited: string[] = []
      let armed = false
      let held = false
      let records: Source[] = []
      async function hold() {
        if (held) return
        held = true
        entered.resolve()
        await release.promise
      }
      const manifest = storage.manifest.bind(storage)
      storage.manifest = async (value) => {
        if (armed && mode === "lookup-journal" && value.retrieval?.state === "completed") await hold()
        if (armed && mode === "lookup-capture" && value.state === "completed") await hold()
        await manifest(value)
      }
      const journal = retrieval(async (value) => {
        if (armed && mode === "retrieve-journal" && value.state === "completed") await hold()
        saved.push(value)
      })
      const api = engine({
        root, store: storage, provider: async () => "approved",
        docs: async () => { armed = true; return records },
        authorize: async (item) => {
          if (!armed || !mode.endsWith("-checks") || visited.includes(item.id)) return
          visited.push(item.id)
          if (visited.length === 2) await hold()
        },
        complete: async () => { throw new Error("No model calls permitted") },
      })
      try {
        const collections: string[] = []
        for (const name of ["first", "second", "unrelated"]) {
          const file = path.join(root, ".kilo", `${name}.txt`)
          await Bun.write(file, `${name} original requires a verified recovery checkpoint.`)
          const item = await library.register({ kind: "file", label: name, location: file })
          await library.approve(item.id, "", ["approved"])
          await library.index(item.id)
          collections.push(item.id)
        }
        records = (await storage.knowledge(root, "chat", "approved")).filter((item) =>
          collections.slice(0, 2).includes(item.detail.collection!) && item.method === "collection-section")
        expect(records).toHaveLength(2)
        const pending = (mode.startsWith("lookup")
          ? api.lookup({ tool: "forge_search_docs", query: "unmatched request", session: "chat", signal: controller.signal })
          : api.retrieve("unmatched request", { docs: true, session: "chat", signal: controller.signal, journal }))
          .then((value) => ({ value }), (error: unknown) => ({ error }))
        try {
          await deadline(() => entered.promise, undefined, 2000)
          const key = visited.at(0) ?? records.at(0)!.detail.collection!
          const original = records.find((item) => item.detail.collection === key)!
          if (action === "pause") await library.stop(key)
          if (action === "remove") await library.stop(key, "", true)
          if (action === "revoke") await library.approve(key, "", [])
          if (action === "unrelated") await library.stop(collections.at(2)!)
          if (action === "cancel") controller.abort(new Error("Cancelled retrieval handoff"))
          if (action.endsWith("-policy")) {
            const session = action === "workspace-policy" ? "" : action === "session-policy" ? "chat" : "other"
            await api.configure({ ...await api.policy(session), exclude: [original.id] })
          }
        } finally {
          release.resolve()
        }
        const result = await pending
        // Cancellation releases the caller before admitted history writes drain.
        if (action === "cancel") await api.dispose()
        const accepted = ["unchanged", "unrelated", "other-policy"].includes(action)
        expect("value" in result).toBe(accepted)
        if ("value" in result) {
          const selection = "result" in result.value ? result.value.result : result.value
          expect(selection.matches.map((item) => item.source.id).sort()).toEqual(records.map((item) => item.id).sort())
          for (const item of records) expect(selection.text).toContain(item.text)
        }
        const expected = accepted ? "completed" : action === "cancel" ? "cancelled" : "failed"
        if (mode.startsWith("retrieve")) {
          expect(saved.at(-1)?.state).toBe(expected)
          expect(saved.at(-1)?.channels).toHaveLength(8)
          expect(saved.at(-1)?.channels.find((item) => item.name === "collection-semantic")?.state).toBe("disabled")
          return
        }
        const latest = (await storage.latest(root, "chat", "tool-retrieval"))!
        const history = await api.request(latest.id, "chat")
        expect(history?.state).toBe(accepted ? "completed" : "failed")
        expect(history?.retrieval?.state).toBe(expected)
        expect(history?.entries.map((item) => item.source).sort()).toEqual(accepted ? records.map((item) => item.id).sort() : [])
        if (!accepted) expect(history?.selection).toBeUndefined()
        expect(await api.request(latest.id, "other")).toBeUndefined()
      } finally {
        release.resolve()
        await journal.finish("cancelled")
        await Promise.all([api.dispose(), library.dispose()])
        db.close()
        await rm(root, { recursive: true, force: true })
      }
    })
  }
}
