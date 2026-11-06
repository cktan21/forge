import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { deadline } from "../src/deadline"
import { engine, fingerprint } from "../src/engine"
import { knowledge } from "../src/knowledge"
import { source } from "../src/parse"
import type { Source } from "../src/schema"
import { store } from "../src/store"

for (const selector of ["ranked", "greedy", "knapsack"] as const) {
  for (const mode of ["direct", "derived"] as const) {
    for (const action of [
      "unchanged", "observed", "dependency-edit", "dependency-delete", "server", "disabled",
      "stale", "unavailable", "expiry", "text", "fingerprint",
    ] as const) {
      test(`${selector}/${mode}/${action}: preparation checks external dependencies after authorization`, async () => {
        const root = await realpath(await mkdtemp(path.join(tmpdir(), "forge-external-")))
        const cfg = { selector, budget: 2400, exclude: [".kilo/**"], documents: { server: "docs" } }
        const file = path.join(root, "package.json")
        const config = path.join(root, ".kilo/forge.jsonc")
        await Bun.write(config, JSON.stringify(cfg))
        await Bun.write(file, JSON.stringify({ dependencies: { "queue-kit": "1.0.0" } }))
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
        const reached = Promise.withResolvers<void>()
        const release = Promise.withResolvers<void>()
        const library = knowledge(root, storage)
        let armed = true
        let calls = 0
        let records: Source[] = []
        const api = engine({
          root, store: storage, provider: async () => "test",
          docs: async () => records.slice(1),
          authorize: async () => {
            if (!armed || (await storage.latest(root, "chat", "enhance"))?.state !== "assembled") return
            armed = false
            reached.resolve()
            await release.promise
          },
          complete: async (input) => {
            calls++
            expect(input.prompt).toContain(records.at(-1)!.text)
            throw new Error("Preparation boundary reached")
          },
        })
        try {
          const registration = await library.register({
            kind: "text", label: "Procedure", location: "", content: "Journal recovery requires a signed maintenance record.",
          })
          await library.approve(registration.id, "", ["test"])
          await library.index(registration.id)
          const registered = (await storage.knowledge(root, "chat", "test")).find(
            (item) => item.detail.collection === registration.id && item.method === "collection-section",
          )!
          const snapshot = await api.refresh()
          const dependency = snapshot.sources.find((item) => item.kind === "dependency" && item.label === "queue-kit")!
          expect(dependency).toBeDefined()
          const document = source("mcp:docs:queue-kit", "Queue recovery requires a checkpoint before retry.", "document", {
            method: "context7", evidence: [dependency.id],
            detail: { server: "docs", dependencies: JSON.stringify({ [dependency.id]: fingerprint(dependency) }) },
          })
          const derived = source("summary:queue-kit", "The queue recovery procedure uses checkpointed retries.", "summary", {
            method: "subsystem-summary", evidence: [document.id],
            detail: { dependencies: JSON.stringify({ [document.id]: fingerprint(document) }) },
          })
          await storage.external(root, document)
          records = [registered, mode === "direct" ? document : derived]
          const exclude = [...snapshot.sources.map((item) => item.id), ...(mode === "derived" ? [document.id] : [])]
          const pending = api.enhance({ text: "Journal recovery", session: "chat", exclude }).then(
            (value) => ({ value }),
            (error: unknown) => ({ error }),
          )
          try {
            await deadline(() => reached.promise, undefined, 2000)
            const captured = await storage.latest(root, "chat", "enhance")
            const assembled = await api.request(captured!.id, "chat")
            expect(assembled?.entries.map((item) => item.source).sort()).toEqual(records.map((item) => item.id).sort())
            if (action === "dependency-edit") await Bun.write(file, JSON.stringify({ dependencies: { "queue-kit": "2.0.0" } }))
            if (action === "dependency-delete") await rm(file)
            if (action === "server") await Bun.write(config, JSON.stringify({ ...cfg, documents: { server: "other" } }))
            if (action === "disabled") await Bun.write(config, JSON.stringify({ ...cfg, documents: undefined }))
            if (action === "stale" || action === "unavailable") await storage.external(root, { ...document, status: action })
            if (action === "expiry") await storage.external(root, { ...document, observed: Date.now() - 25 * 60 * 60 * 1000 })
            if (action === "observed") await storage.external(root, { ...document, observed: document.observed + 100 })
            if (action === "text") {
              const selected = records.at(-1)!
              await storage.external(root, { ...selected, text: "Changed adapter content with retained hash" })
            }
            if (action === "fingerprint") await storage.external(root, { ...document, detail: { ...document.detail, revision: "changed" } })
          } finally {
            release.resolve()
          }
          const result = await pending
          expect("error" in result).toBe(true)
          if (!("error" in result)) throw new Error("Expected boundary error")
          const accepted = action === "unchanged" || action === "observed"
          expect(String(result.error)).toContain(accepted ? "Preparation boundary reached" : "Evidence changed or is unavailable before preparation")
          expect(calls).toBe(accepted ? 1 : 0)
          const latest = await storage.latest(root, "chat", "enhance")
          const history = await api.request(latest!.id, "chat")
          expect(history?.state).toBe("failed")
          expect(history?.entries.map((item) => item.source).sort()).toEqual(records.map((item) => item.id).sort())
          expect(history?.attempts ?? []).toEqual([])
          expect(await api.request(latest!.id, "other")).toBeUndefined()
        } finally {
          release.resolve()
          await Promise.all([api.dispose(), library.dispose()])
          db.close()
          await rm(root, { recursive: true, force: true })
        }
      })
    }
  }
}
