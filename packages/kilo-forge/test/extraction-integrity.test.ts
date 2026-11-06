import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { engine } from "../src/engine"
import { extract } from "../src/extract"
import { knowledge } from "../src/knowledge"
import { type Source } from "../src/schema"
import { store } from "../src/store"
import { scan } from "../src/catalog"
import { config } from "../src/config"

describe("document-integrity", () => {
  const canary = "Altered cached evidence must not survive document refresh."
  const text =
    "# Journal\nRestore the original journal before replaying transactions.\n# Validation\nVerify the checkpoint checksum before restoring service."

  function normalized(items: readonly Source[]) {
    return items
      .map((item) => ({
        ...item,
        observed: 0,
        detail: Object.fromEntries(
          Object.entries(item.detail)
            .filter(([key]) => key !== "extraction")
            .sort(([a], [b]) => a.localeCompare(b)),
        ),
      }))
      .sort((a, b) => a.id.localeCompare(b.id))
  }

  for (const kind of ["file", "folder", "text", "upload"] as const) {
    for (const restart of [false, true]) {
      for (const fault of [
        "unchanged",
        "sharing",
        "legacy",
        "text",
        "locator",
        "lineage",
        "brief",
        "missing-section",
        "missing-parent",
        "extra-section",
      ]) {
        test(`${kind}/${restart ? "restart" : "refresh"}/${fault}: repair registered extraction from authorized bytes`, async () => {
          const root = await realpath(await mkdtemp(path.join(tmpdir(), "forge-document-integrity-")))
          const dir = path.join(root, "docs")
          await Bun.write(path.join(dir, "guide.md"), text)
          await Bun.write(
            path.join(root, ".kilo/forge.jsonc"),
            JSON.stringify({ exclude: ["docs/**", ".kilo/**"], budget: 8000 }),
          )
          let calls = 0
          function connect() {
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
            const library = knowledge(root, storage, {
              extract: async (...args) => {
                calls++
                return extract(...args)
              },
            })
            return { db, storage, library }
          }
          const first = connect()
          const active = { value: first }
          try {
            const item = await first.library.register({
              kind,
              label: "Recovery",
              session: "chat",
              watch: false,
              location:
                kind === "folder"
                  ? dir
                  : kind === "file"
                    ? path.join(dir, "guide.md")
                    : kind === "upload"
                      ? "guide.md"
                      : "",
              ...(["text", "upload"].includes(kind)
                ? { content: kind === "text" ? text : Buffer.from(text).toString("base64") }
                : {}),
            })
            await first.library.approve(item.id, "chat", ["approved"])
            const indexed = await first.library.index(item.id, "chat")
            expect(calls).toBe(1)
            const clean = await first.storage.knowledge(root, "chat")
            const section = clean.find((item) => item.method === "collection-section")!
            const parent = clean.find((item) => item.method === "collection-document")!
            expect(clean).toHaveLength(3)
            const corrupt = clean
              .map((item) => {
                const base = { ...item, observed: 1 }
                if (fault === "legacy")
                  return {
                    ...base,
                    detail: Object.fromEntries(Object.entries(base.detail).filter(([key]) => key !== "extraction")),
                  }
                if (item.id === section.id && fault === "text") return { ...base, text: canary }
                if (item.id === section.id && fault === "locator")
                  return { ...base, start: 999, detail: { ...base.detail, heading: canary, page: "99" } }
                if (item.id === section.id && fault === "lineage") return { ...base, evidence: ["unrelated-original"] }
                if (item.id === parent.id && fault === "brief")
                  return { ...base, label: canary, detail: { ...base.detail, brief: canary } }
                return base
              })
              .filter(
                (item) =>
                  (fault !== "missing-section" || item.id !== section.id) &&
                  (fault !== "missing-parent" || item.id !== parent.id),
              )
            if (fault === "extra-section")
              corrupt.push({ ...section, id: "unexpected-section", text: canary, observed: 1 })
            expect(corrupt.every((item) => item.detail.fileHash === section.detail.fileHash)).toBe(true)
            await first.storage.publish(root, indexed, corrupt.reverse())
            if (fault === "sharing") await first.library.approve(item.id, "chat", ["approved", "second"])
            if (restart) {
              await first.library.dispose()
              first.db.close()
              active.value = connect()
            }
            const current = active.value
            const result = await current.library.index(item.id, "chat")
            expect(result.state).toBe("ready")
            const repaired = await current.storage.knowledge(root, "chat")
            expect(normalized(repaired)).toEqual(
              normalized(
                clean.map((item) =>
                  fault !== "sharing"
                    ? item
                    : {
                        ...item,
                        detail: { ...item.detail, providers: '["approved","second"]' },
                      },
                ),
              ),
            )
            expect(JSON.stringify(repaired)).not.toContain(canary)
            const reusable = fault === "unchanged" || fault === "sharing"
            expect(result.result).toMatchObject({ extracted: reusable ? 0 : 1, reused: reusable ? 1 : 0 })
            expect(calls).toBe(reusable ? 1 : 2)
            if (reusable) expect(repaired.every((item) => item.observed === 1)).toBe(true)
            if (!reusable) expect(repaired.every((item) => item.observed > 1)).toBe(true)
            const again = await current.library.index(item.id, "chat")
            expect(again.result).toMatchObject({ extracted: 0, reused: 1 })
            expect(await current.storage.knowledge(root, "chat")).toEqual(repaired)
            expect(await current.storage.knowledge(root, "other")).toEqual([])
            const history = await current.storage.imports(root, item.id, { session: "chat" })
            expect(history.runs.some((run) => run.state === "published")).toBe(true)
            expect((await current.storage.imports(root, item.id, { session: "other" })).runs).toEqual([])
            const api = engine({
              root,
              store: current.storage,
              provider: async () => "approved",
              complete: async () => {
                throw new Error("No completion permitted")
              },
            })
            try {
              const lookup = await api.lookup({
                query: "journal checkpoint checksum",
                session: "chat",
                tool: "forge_search_docs",
              })
              expect(lookup.result.text).toContain("Restore the original journal")
              expect(lookup.result.text).toContain("Verify the checkpoint checksum")
              expect(JSON.stringify(lookup.result)).not.toContain(canary)
              expect((await api.request(lookup.request, "chat"))?.selection).toEqual(lookup.result.audit)
            } finally {
              await api.dispose()
            }
          } finally {
            await active.value.library.dispose()
            active.value.db.close()
            await rm(root, { recursive: true, force: true })
          }
        })
      }
    }
  }
})

describe("extraction-integrity", () => {
  const canary = "Corrupted cached extraction must be repaired from repository bytes."

  function normalized(item: Source) {
    return {
      ...item,
      observed: 0,
      detail: Object.fromEntries(
        Object.entries(item.detail)
          .filter(([key]) => key !== "extraction")
          .sort(([a], [b]) => a.localeCompare(b)),
      ),
    }
  }

  for (const mode of ["scanner", "restart"]) {
    for (const action of [
      "unchanged",
      "legacy",
      "file-text",
      "symbol-text",
      "symbol-label",
      "missing-symbol",
      "duplicate-symbol",
      "dependency-text",
      "imports",
      "relation",
    ]) {
      test(`${mode}/${action}: verify extraction integrity before reusing cached originals`, async () => {
        const root = await realpath(await mkdtemp(path.join(tmpdir(), "forge-extraction-")))
        await Bun.write(path.join(root, ".kilo/forge.jsonc"), JSON.stringify({ exclude: [".kilo/**"], budget: 8000 }))
        await Bun.write(
          path.join(root, "checkpoint.ts"),
          'import { journal } from "./journal"\nexport function recovery() { return journal() }\n',
        )
        await Bun.write(path.join(root, "journal.ts"), "export function journal() { return 42 }\n")
        await Bun.write(
          path.join(root, "package.json"),
          JSON.stringify({ dependencies: { "checkpoint-recovery": "1.0.0" } }),
        )
        const cfg = await config(root)
        const clean = await scan({ root, cfg })
        const file = clean.sources.find((item) => item.uri === "checkpoint.ts" && item.method === "file")!
        const symbol = clean.sources.find((item) => item.label === "recovery" && item.kind === "symbol")!
        const dependency = clean.sources.find((item) => item.kind === "dependency")!
        const edge = clean.relations.find((item) => item.from === file.id && item.to === symbol.id)!
        const sources = clean.sources
          .map((item) => {
            const base = { ...item, observed: 1 }
            if (action === "legacy")
              return {
                ...base,
                detail: Object.fromEntries(Object.entries(item.detail).filter(([key]) => key !== "extraction")),
              }
            if (action === "file-text" && item.id === file.id) return { ...base, text: canary }
            if (action === "symbol-text" && item.id === symbol.id) return { ...base, text: canary }
            if (action === "symbol-label" && item.id === symbol.id) return { ...base, label: canary }
            if (action === "dependency-text" && item.id === dependency.id) return { ...base, text: canary }
            if (action === "imports" && item.id === file.id)
              return { ...base, detail: { ...base.detail, imports: "invalid JSON" } }
            return base
          })
          .filter((item) => action !== "missing-symbol" || item.id !== symbol.id)
        if (action === "duplicate-symbol") sources.push({ ...symbol, text: canary, observed: 1 })
        const corrupt = {
          ...clean,
          sources,
          relations: clean.relations.map((item) =>
            action === "relation" && item.id === edge.id ? { ...item, reason: canary } : item,
          ),
        }
        const connect = () => {
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
          return { db, storage }
        }
        try {
          if (mode === "restart") {
            const first = connect()
            try {
              await first.storage.replace(corrupt)
            } finally {
              first.db.close()
            }
          }
          const connection = connect()
          const api = engine({
            root,
            store: connection.storage,
            complete: async () => {
              throw new Error("No model calls permitted")
            },
          })
          try {
            const repaired = mode === "scanner" ? await scan({ root, cfg, previous: corrupt }) : await api.refresh()
            for (const item of clean.sources.filter((item) => item.kind !== "directory")) {
              expect(repaired.sources.filter((value) => value.id === item.id).map(normalized)).toEqual([
                normalized(item),
              ])
            }
            expect(repaired.relations.find((item) => item.id === edge.id)).toEqual(edge)
            expect(JSON.stringify(repaired)).not.toContain(canary)
            const reused = repaired.sources.find((item) => item.id === file.id)!
            if (action === "unchanged") expect(reused.observed).toBe(1)
            if (action === "legacy") expect(reused.observed).toBeGreaterThan(1)
            const again = mode === "scanner" ? await scan({ root, cfg, previous: repaired }) : await api.refresh(true)
            expect(again.sources.find((item) => item.id === file.id)).toEqual(reused)
            if (mode === "restart") {
              expect(normalized((await connection.storage.source(root, symbol.id))!)).toEqual(normalized(symbol))
              const lookup = await api.lookup({
                query: "checkpoint recovery journal",
                session: "chat",
                tool: "forge_search_code",
              })
              expect(JSON.stringify(lookup.result)).not.toContain(canary)
              expect(lookup.result.text).toContain("journal")
              expect((await api.request(lookup.request, "chat"))?.selection).toEqual(lookup.result.audit)
              expect(await api.request(lookup.request, "other")).toBeUndefined()
            }
          } finally {
            await api.dispose()
            connection.db.close()
          }
        } finally {
          await rm(root, { recursive: true, force: true })
        }
      })
    }
  }
})

describe("fresh-integrity", () => {
  const text =
    "# Restore\nRestore the journal before replaying transactions.\n# Verify\nVerify the checkpoint checksum before restoring service."
  const canary = "Corrupted journal evidence must never reach preparation."

  async function denied(value: Promise<unknown>) {
    const error = await value.then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(error).toBeInstanceOf(Error)
    expect(String(error)).toContain("Source changed or is not eligible")
  }

  for (const kind of ["file", "text", "upload"] as const) {
    for (const fault of [
      "unchanged",
      "observed",
      "text",
      "locator",
      "missing",
      "parent",
      "legacy",
      "selected",
    ] as const) {
      test(`${kind}/${fault}: validate originals before refresh`, async () => {
        const root = await realpath(await mkdtemp(path.join(tmpdir(), "forge-fresh-integrity-")))
        await Bun.write(path.join(root, ".kilo/forge.jsonc"), JSON.stringify({ exclude: [".kilo/**"], budget: 8000 }))
        const file = path.join(root, ".kilo/guide.md")
        await Bun.write(file, text)
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
        let mutation: (() => Promise<void>) | undefined
        const authorize = async () => {
          const action = mutation
          mutation = undefined
          await action?.()
        }
        const library = knowledge(root, storage, { authorize })
        const api = engine({
          root,
          store: storage,
          authorize,
          provider: async () => "approved",
          complete: async () => {
            throw new Error("No completion permitted")
          },
        })
        try {
          const item = await library.register({
            kind,
            location: kind === "file" ? file : kind === "upload" ? "guide.md" : "",
            label: "Journal",
            session: "chat",
            ...(kind === "file" ? {} : { content: kind === "text" ? text : Buffer.from(text).toString("base64") }),
          })
          await library.approve(item.id, "chat", ["approved"])
          const indexed = await library.index(item.id, "chat")
          const originals = await storage.knowledge(root, "chat")
          const section = originals.find((item) => item.method === "collection-section")!
          const sibling = originals.find((item) => item.method === "collection-section" && item.id !== section.id)!
          expect(originals).toHaveLength(3)
          expect(await library.fresh(section, "chat", "approved")).toBe(true)
          const corrupted = originals
            .map((item): Source => {
              if (fault === "observed") return { ...item, observed: 1 }
              if (fault === "legacy")
                return {
                  ...item,
                  detail: Object.fromEntries(Object.entries(item.detail).filter(([key]) => key !== "extraction")),
                }
              if (fault === "text" && item.id === section.id) return { ...item, text: canary }
              if (fault === "locator" && item.id === section.id)
                return { ...item, start: 900, evidence: ["unknown-parent"] }
              if (fault === "parent" && item.method === "collection-document") return { ...item, label: canary }
              return item
            })
            .filter((item) => fault !== "missing" || item.id !== sibling.id)
          // For file sources mutate within the asynchronous authorization boundary.
          if (kind === "file") mutation = () => storage.publish(root, indexed, corrupted)
          if (kind !== "file") await storage.publish(root, indexed, corrupted)
          const selected = fault === "selected" ? { ...section, text: canary } : section
          const valid = fault === "unchanged" || fault === "observed"
          expect(await library.fresh(selected, "chat", "approved")).toBe(valid)
          expect(await library.fresh(selected, "other", "approved")).toBe(false)
          expect(await library.fresh(selected, "chat", "denied")).toBe(false)
          if (fault !== "selected") {
            const current = (await storage.source(root, section.id))!
            expect(await library.fresh(current, "chat")).toBe(valid)
            if (valid) expect((await api.symbol(section.id, "chat")).id).toBe(section.id)
            if (!valid) {
              await denied(api.symbol(section.id, "chat"))
              const parent = originals.find((item) => item.method === "collection-document")!
              await denied(api.view({ session: "chat", document: parent.id }))
              const policy = await api.policy("chat")
              await denied(api.configure({ ...policy, pin: [section.id] }))
              const result = await api.lookup({
                tool: "forge_search_docs",
                query: "journal checkpoint",
                session: "chat",
              })
              expect(result.result.matches).toEqual([])
              expect(JSON.stringify(result.result)).not.toContain(canary)
              expect((await api.request(result.request, "chat"))?.selection).toEqual(result.result.audit)
            }
          }
          const repaired = await library.index(item.id, "chat")
          expect(repaired.state).toBe("ready")
          const current = (await storage.knowledge(root, "chat")).find((item) => item.id === section.id)!
          expect(current.text).toBe(section.text)
          expect(await library.fresh(current, "chat", "approved")).toBe(true)
          expect((await api.symbol(section.id, "chat")).text).toBe(section.text)
        } finally {
          await api.dispose()
          await library.dispose()
          db.close()
          await rm(root, { recursive: true, force: true })
        }
      })
    }
  }
})
