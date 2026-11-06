import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { deadline } from "@kilocode/forge/deadline"
import { knowledge } from "@kilocode/forge/knowledge"
import { store } from "@kilocode/forge/store"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { authorize, register, start } from "../../src/kilocode/forge/trace"

for (const connection of ["same", "separate"] as const) {
  for (const phase of ["authorization", "capture", "send"] as const) {
    for (const action of ["pause", "remove", "revoke", "policy", "other-policy", "unrelated", "unchanged"] as const) {
      test(`${connection}/${phase}/${action}: transport consent follows scoped persisted state`, async () => {
        const root = await realpath(await mkdtemp(path.join(tmpdir(), "forge-transport-consent-")))
        const file = path.join(root, "catalog.sqlite")
        const reader = new Database(file)
        const writer = new Database(file)
        function connect(db: Database) {
          return store({
            all: async (query) => db.query<Record<string, unknown>, (string | number | null)[]>(query.text).all(...query.values ?? []),
            batch: async (queries) => {
              db.transaction(() => { for (const query of queries) db.query(query.text).run(...query.values ?? []) })()
            },
          })
        }
        const storage = connect(reader)
        const writing = connection === "same" ? storage : connect(writer)
        const entered = Promise.withResolvers<void>()
        const release = Promise.withResolvers<void>()
        const received: string[] = []
        const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
          received.push(await request.text())
          return Response.json({ ok: true })
        } })
        const destination = async () => ({ fingerprint: "reviewed-local-origin", origins: [server.url.origin] })
        const library = knowledge(root, writing, { destination })
        const viewing = knowledge(root, storage, { destination })
        const collections: string[] = []
        let armed = false
        let held = false
        async function hold() {
          if (held) return
          held = true
          entered.resolve()
          await release.promise
        }
        const off = register(root, storage, async (item) => {
          if (armed && phase !== "capture" && item.id === collections.at(1)) await hold()
        }, destination)
        const manifest = storage.manifest.bind(storage)
        storage.manifest = async (value) => {
          if (armed && phase === "capture") await hold()
          await manifest(value)
        }
        try {
          // Both stores are live before publication; this is not a restart test.
          await viewing.ready()
          for (const name of ["first", "second", "unrelated"]) {
            const location = path.join(root, `${name}.txt`)
            await Bun.write(location, `${name} original requires an approved recovery checkpoint.`)
            const collection = await library.register({ kind: "file", label: name, location, session: "chat" })
            await library.approve(collection.id, "chat", ["approved"], { approved: "reviewed-local-origin" })
            await library.index(collection.id, "chat")
            await library.settle("chat")
            collections.push(collection.id)
          }
          const sources = await storage.knowledge(root, "chat", "approved")
          const originals = collections.slice(0, 2).map((key) => sources.find((item) =>
            item.detail.collection === key && item.method === "collection-section")!)
          expect(originals.every(Boolean)).toBe(true)
          const input = {
            root, session: "chat", model: "approved/model", purpose: "coding",
            system: [], messages: originals.map((item) => `[${item.id}]\n${item.text}`),
          }
          const handle = phase === "send" ? await start(input) : undefined
          armed = true
          const pending = (phase === "authorization" ? authorize(input)
            : handle ? handle.fetch(fetch)(server.url, { method: "POST", body: JSON.stringify(input.messages) })
            : start(input)).then((value) => ({ value }), (error: unknown) => ({ error }))
          try {
            await deadline(() => entered.promise, undefined, 2000)
            const first = collections.at(0)!
            if (action === "pause") await library.stop(first, "chat")
            if (action === "remove") await library.stop(first, "chat", true)
            if (action === "revoke") await library.approve(first, "chat", [])
            if (action === "unrelated") await library.stop(collections.at(2)!, "chat")
            if (action === "policy" || action === "other-policy") {
              await writing.policySave(root, {
                session: action === "policy" ? "chat" : "other",
                version: "changed", pin: [], exclude: [originals.at(0)!.id],
              })
            }
          } finally {
            release.resolve()
            await pending
          }
          const result = await pending
          const accepted = ["unchanged", "unrelated", "other-policy"].includes(action)
          expect("value" in result).toBe(accepted)
          expect(received).toEqual(phase === "send" && accepted ? [JSON.stringify(input.messages)] : [])
          if (phase === "authorization") {
            if ("value" in result) expect(result.value).toBe(true)
            expect(await storage.manifests(root)).toEqual([])
            return
          }
          const records = await storage.manifests(root, { session: "chat" })
          expect(records).toHaveLength(1)
          if (phase === "capture") {
            expect(records.at(0)?.state).toBe(accepted ? "assembled" : "failed")
            expect(records.at(0)?.attempts).toEqual([])
            return
          }
          const attempt = records.at(0)?.attempts?.at(-1)
          expect(attempt?.state).toBe(accepted ? "response" : "blocked")
          expect(attempt?.sent).toEqual(accepted ? records.at(0)!.entries.map((item) => item.source) : [])
          expect(records.at(0)?.state).toBe(accepted ? "sent" : "failed")
        } finally {
          release.resolve()
          off()
          await library.dispose()
          await viewing.dispose()
          await server.stop(true)
          reader.close()
          writer.close()
          await rm(root, { recursive: true, force: true })
        }
      })
    }
  }
}
