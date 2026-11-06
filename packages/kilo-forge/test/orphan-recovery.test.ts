import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { engine } from "../src/engine"
import { source } from "../src/parse"
import type { Source } from "../src/schema"
import { store } from "../src/store"

for (const selector of ["ranked", "greedy", "knapsack"] as const) {
  for (const scope of ["missing", "other-session", "other-workspace"] as const) {
    test(`${selector}/${scope}: persisted orphan records cannot break retrieval after restart`, async () => {
      const home = await realpath(await mkdtemp(path.join(tmpdir(), "forge-orphan-")))
      const root = path.join(home, "workspace")
      const other = path.join(home, "other")
      await mkdir(root)
      await mkdir(other)
      await Bun.write(path.join(root, ".kilo/forge.jsonc"), JSON.stringify({ selector, budget: 2400, exclude: [".kilo/**"] }))
      await Bun.write(path.join(root, "fallback.txt"), "Journal recovery fallback remains available.")
      let saved: Source | undefined
      let valid = ""
      try {
        for (const restart of [false, true]) {
          const db = new Database(path.join(home, "catalog.sqlite"))
          const storage = store({
            all: async (query) => db.query<Record<string, unknown>, (string | number | null)[]>(query.text).all(...query.values ?? []),
            batch: async (queries) => {
              db.transaction(() => {
                for (const query of queries) db.query(query.text).run(...query.values ?? [])
              })()
            },
          })
          let denied = false
          const calls: string[] = []
          const complete = async (): Promise<never> => { throw new Error("No model calls permitted") }
          const api = engine({
            root, store: storage, provider: async () => "test", complete,
            authorize: async (item) => {
              calls.push(item.id)
              if (denied && item.id === valid) throw new Error("Collection access denied")
            },
          })
          const foreign = engine({ root: other, store: storage, provider: async () => "test", complete })
          try {
            if (!restart) {
              const collection = await api.register({ kind: "text", label: "Recovery", content: "Journal recovery requires a verified checkpoint.", location: "", session: "chat" })
              valid = collection.id
              await api.approve(valid, "chat", ["test"])
              await api.index(valid, "chat")
              const hidden = scope === "missing" ? undefined
                : await (scope === "other-workspace" ? foreign : api).register({
                  kind: "text", label: "Private archive", content: "Do not expose this private original.", location: "",
                  session: scope === "other-session" ? "private" : "chat",
                })
              saved = source("legacy:orphan", "Orphan journal recovery canary.", "document", {
                method: "adapter-document",
                detail: { collection: hidden?.id ?? "missing-registration", providers: '["test"]', session: "chat" },
              })
              await storage.external(root, saved)
              await api.refresh()
            }
            const orphan = saved!
            calls.length = 0
            const result = await api.retrieve("journal recovery", { session: "chat" })
            expect(result.matches.some((item) => item.source.detail.collection === valid)).toBe(true)
            expect(result.text).toContain("verified checkpoint")
            expect(JSON.stringify(result)).not.toContain(orphan.id)
            expect(JSON.stringify(result)).not.toContain(orphan.text)
            expect(calls).toContain(valid)
            expect(calls).not.toContain(orphan.detail.collection!)
            expect(result.tokens).toBe(Buffer.byteLength(result.text))
            expect(result.tokens).toBeLessThanOrEqual(2400)
            const lookup = await api.lookup({ tool: "forge_search_code", query: "journal recovery", session: "chat" })
            expect((await api.request(lookup.request, "chat"))?.selection).toEqual(lookup.result.audit)
            expect(await api.request(lookup.request, "private")).toBeUndefined()
            denied = true
            const restricted = await api.retrieve("journal recovery", { session: "chat" })
            expect(restricted.matches.some((item) => item.source.detail.collection === valid)).toBe(false)
            expect(restricted.text).toContain("fallback remains available")
            expect(JSON.stringify(restricted)).not.toContain(orphan.text)
            const pinned = await api.retrieve("journal recovery", { session: "chat", pin: [orphan.id] }).catch((error: unknown) => error)
            expect(String(pinned)).toContain("Pinned excerpt is unavailable")
            const approval = await api.approve(orphan.detail.collection!, "chat").catch((error: unknown) => error)
            expect(String(approval)).toContain("not available in this session")
            expect((await storage.externals(root)).find((item) => item.id === orphan.id)).toEqual(orphan)
            expect((await storage.collection(root, valid))?.providers).toEqual(["test"])
          } finally {
            await Promise.all([api.dispose(), foreign.dispose()])
            db.close()
          }
        }
      } finally {
        await rm(home, { recursive: true, force: true })
      }
    })
  }
}
