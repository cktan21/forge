import { describe, expect, test } from "bun:test"
import { Database, SQLiteError } from "bun:sqlite"
import { mkdtemp, realpath, rm, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { deadline } from "../src/deadline"
import { engine } from "../src/engine"
import { store, type Value } from "../src/store"
import { source } from "../src/parse"
import { type Source } from "../src/schema"
import { render } from "../src/context"

describe("admission", () => {
  async function fixture() {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "forge-admission-")))
    const db = new Database(path.join(root, "history.sqlite"))
    const storage = store({
      all: async (query) =>
        db.query<Record<string, unknown>, (string | number | null)[]>(query.text).all(...(query.values ?? [])),
      batch: async (queries) => {
        db.transaction(() => {
          for (const query of queries) db.query(query.text).run(...(query.values ?? []))
        })()
      },
    })
    await storage.ready
    return {
      root,
      storage,
      async [Symbol.asyncDispose]() {
        db.close()
        await rm(root, { recursive: true, force: true })
      },
    }
  }

  for (const kind of ["enhance", "lookup"] as const) {
    test.each(["already", "during"] as const)(
      `${kind} cancelled %s admission rejects before held history and shutdown drains it`,
      async (timing) => {
        await using f = await fixture()
        const entered = Promise.withResolvers<void>()
        const gate = Promise.withResolvers<void>()
        const controller = new AbortController()
        const error = new Error("Cancel admission")
        const manifest = f.storage.manifest.bind(f.storage)
        f.storage.manifest = async (value) => {
          if (value.state === "retrieving") {
            entered.resolve()
            await gate.promise
          }
          await manifest(value)
        }
        const calls: string[] = []
        const api = engine({
          root: f.root,
          store: f.storage,
          provider: async () => {
            calls.push("provider")
            return ""
          },
          complete: async () => {
            calls.push("model")
            throw new Error("Model calls prohibited")
          },
        })
        if (timing === "already") controller.abort(error)
        const pending = (
          kind === "enhance"
            ? api.enhance({ text: "admission", session: "chat", signal: controller.signal })
            : api.lookup({ tool: "forge_search_code", query: "admission", session: "chat", signal: controller.signal })
        ).then(
          () => "completed",
          (err: unknown) => err,
        )
        try {
          await deadline(() => entered.promise, undefined, 2000)
          if (timing === "during") controller.abort(error)
          expect(await Promise.race([pending, delay(100).then(() => "blocked")])).toBe(error)
          expect(await f.storage.manifests(f.root, { session: "chat" })).toEqual([])
          const closing = api.dispose()
          expect(await Promise.race([closing.then(() => "closed"), delay(20).then(() => "draining")])).toBe("draining")
          gate.resolve()
          await deadline(() => closing, undefined, 2000)
          const rows = await f.storage.manifests(f.root, { session: "chat" })
          expect(rows).toHaveLength(1)
          expect(rows.at(0)).toMatchObject({ state: "failed", entries: [], attempts: [] })
          expect(rows.at(0)?.coverage.join(" ")).toContain(error.message)
          expect(calls).toEqual([])
        } finally {
          gate.resolve()
          await pending
          await api.dispose()
        }
      },
    )
  }

  test("non-aborted preflight failure waits for terminal history and a later request can retry", async () => {
    await using f = await fixture()
    const entered = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<void>()
    const error = new Error("Provider preflight failed")
    const manifest = f.storage.manifest.bind(f.storage)
    f.storage.manifest = async (value) => {
      if (value.state === "failed") {
        entered.resolve()
        await gate.promise
      }
      await manifest(value)
    }
    let calls = 0
    const api = engine({
      root: f.root,
      store: f.storage,
      provider: async () => {
        if (++calls === 1) throw error
        return ""
      },
      complete: async () => {
        throw new Error("Model calls prohibited")
      },
    })
    const pending = api.lookup({ tool: "forge_search_code", query: "admission", session: "chat" }).then(
      () => "completed",
      (err: unknown) => err,
    )
    try {
      await deadline(() => entered.promise, undefined, 2000)
      expect(await Promise.race([pending, delay(100).then(() => "blocked")])).toBe("blocked")
      gate.resolve()
      expect(await deadline(() => pending, undefined, 2000)).toBe(error)
      const failed = (await api.manifests({ session: "chat" })).at(0)!
      expect(failed.state).toBe("failed")
      expect(failed.retrieval?.state).toBe("failed")
      expect(failed.coverage.join(" ")).toContain(error.message)
      const retried = await api.lookup({ tool: "forge_search_code", query: "admission", session: "chat" })
      expect((await api.request(retried.request, "chat"))?.state).toBe("completed")
      expect(await api.request(failed.id, "chat")).toEqual(failed)
      expect(calls).toBe(2)
    } finally {
      gate.resolve()
      await pending
      await api.dispose()
    }
  })
})

describe("admission-eligibility", () => {
  const cases: Array<{ name: string; patch: Partial<Source> }> = [
    { name: "stale", patch: { status: "stale" } },
    { name: "unavailable", patch: { status: "unavailable" } },
    { name: "empty", patch: { text: "" } },
    { name: "other-session", patch: { detail: { session: "private" } } },
    { name: "unapproved-collection", patch: { detail: { collection: "private", providers: "[]" } } },
    { name: "unknown-collection", patch: { detail: { collection: "private", providers: '["test"]' } } },
  ]

  // Fixed adapter boundary inputs. The store, engine, policy, admission and
  // persisted lookup audit use the real implementation and disk-backed SQLite.
  for (const channel of ["memory", "dependency-docs"] as const) {
    for (const selector of ["ranked", "greedy", "knapsack"] as const) {
      for (const control of cases) {
        test(`${channel}/${selector}: ${control.name} cannot crowd out current evidence`, async () => {
          const root = await realpath(await mkdtemp(path.join(tmpdir(), "forge-eligible-")))
          await Bun.write(
            path.join(root, ".kilo/forge.jsonc"),
            JSON.stringify({ selector, candidates: 1, budget: 600, exclude: [".kilo/**"] }),
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
          const detail: Source["detail"] = channel === "memory" ? { session: "chat" } : {}
          const original = source("manual:allowed", "Recovery requires the original journal.", "document", {
            method: channel === "memory" ? "kilo-memory-recall" : "adapter-document",
            detail,
          })
          const blocked = source("manual:blocked", "Unusable evidence must not occupy the only slot.", "document", {
            method: original.method,
            ...control.patch,
            detail: { ...detail, ...control.patch.detail },
          })
          const api = engine({
            root,
            store: storage,
            provider: async () => "test",
            complete: async () => {
              throw new Error("No model calls permitted")
            },
            ...(channel === "memory"
              ? { memory: async () => [blocked, original] }
              : { docs: async () => [blocked, original] }),
          })
          try {
            if (channel === "dependency-docs" && ["stale", "unavailable"].includes(control.name)) {
              await storage.external(root, { ...blocked, status: "current" })
            }
            const opts = { session: "chat", docs: channel === "dependency-docs" }
            const result = await api.retrieve("recovery procedure", opts)
            expect(result.matches.map((item) => item.source.id)).toEqual([original.id])
            expect(result.matches.at(0)?.source).toEqual(original)
            expect(result.tokens).toBe(Buffer.byteLength(result.text))
            expect(result.tokens).toBeLessThanOrEqual(600)
            expect(result.audit?.channels?.find((item) => item.name === channel)?.state).toBe("completed")
            if (control.name.includes("collection") || control.name === "other-session") {
              expect(JSON.stringify(result.audit)).not.toContain(blocked.id)
              expect(JSON.stringify(result)).not.toContain(blocked.text)
              expect((await storage.externals(root)).some((item) => item.id === blocked.id)).toBe(false)
            }
            if (channel === "dependency-docs" && ["stale", "unavailable"].includes(control.name)) {
              expect((await storage.externals(root)).find((item) => item.id === blocked.id)?.status).toBe(
                control.patch.status,
              )
            }
            const lookup = await api.lookup({
              tool: channel === "memory" ? "forge_search_code" : "forge_search_docs",
              query: "recovery procedure",
              session: "chat",
            })
            expect(lookup.result.matches.map((item) => item.source.id)).toEqual([original.id])
            expect((await api.request(lookup.request, "chat"))?.selection).toEqual(lookup.result.audit)
            expect(await api.request(lookup.request, "other")).toBeUndefined()
            const empty = await api.retrieve("recovery procedure", { ...opts, exclude: [original.id] })
            expect(empty.matches).toEqual([])
            expect(empty.tokens).toBe(0)
          } finally {
            await api.dispose()
            db.close()
            await rm(root, { recursive: true, force: true })
          }
        })
      }
    }
  }
})

describe("exclusion-admission", () => {
  // Development controls for admission, not semantic relevance acceptance labels.
  for (const routing of ["default", "domains"] as const) {
    for (const fallback of [false, true]) {
      test(`exclusions precede candidate limits: ${routing}, fallback=${fallback}`, async () => {
        const home = await realpath(await mkdtemp(path.join(tmpdir(), "forge-exclusion-")))
        const dir = path.join(home, `${routing}-${fallback}`)
        await mkdir(path.join(dir, ".kilo"), { recursive: true })
        const root = await realpath(dir)
        const file = path.join(root, ".kilo", "forge.jsonc")
        const cfg = { ...(routing === "domains" ? { routing } : {}), exclude: [".kilo/**", "manuals/**"] }
        await Bun.write(file, JSON.stringify({ ...cfg, budget: 600 }))
        const location = path.join(root, "manuals")
        await mkdir(location)
        for (let index = 0; index < 102; index++) {
          await Bun.write(
            path.join(location, `${String(index).padStart(3, "0")}.md`),
            `Harbor alarm procedure ${String(index).padStart(3, "0")}.`,
          )
        }
        const filename = path.join(root, ".kilo", "catalog.sqlite")
        const fault = { armed: false, errors: 0 }
        function open() {
          const db = new Database(filename)
          const storage = store({
            async all(query) {
              const broken = fault.armed && query.text.startsWith("SELECT s.body, bm25(forge_search,")
              try {
                return db
                  .query<
                    Record<string, unknown>,
                    Value[]
                  >(broken ? query.text.replace("SELECT ", "SELECT , ") : query.text)
                  .all(...(query.values ?? []))
              } catch (err) {
                if (broken && err instanceof SQLiteError) fault.errors++
                throw err
              }
            },
            async batch(queries) {
              db.transaction(() => {
                for (const query of queries) db.query(query.text).run(...(query.values ?? []))
              })()
            },
          })
          const api = engine({
            root,
            store: storage,
            provider: async () => "local",
            complete: async () => {
              throw new Error("No model calls in admission controls")
            },
          })
          return { db, storage, api }
        }
        const initial = open()
        try {
          const collection = await initial.api.register({ kind: "folder", label: "Manual", location, watch: false })
          await initial.api.approve(collection.id, "", ["local"])
          await initial.api.index(collection.id)
          await initial.api.retrieve("harbor alarm")
        } finally {
          await initial.api.dispose()
          initial.db.close()
        }
        const f = open()
        try {
          const sources = (await f.storage.knowledge(root, "", "local")).filter(
            (item) => item.method === "collection-section",
          )
          expect(sources).toHaveLength(102)
          const prior = await f.storage.search(root, "harbor alarm", 100, { provider: "local", domains: false })
          expect(prior).toHaveLength(100)
          const excluded = prior.map((item) => item.source.id)
          const allowed = sources.filter((item) => !excluded.includes(item.id))
          expect(allowed).toHaveLength(2)
          expect(
            allowed.reduce((sum, source) => sum + Buffer.byteLength(render({ source, score: 1, reason: "" })) + 1, 0),
          ).toBeLessThanOrEqual(600)
          const rows: Array<{ budget: number; policy: boolean; ids: string[]; bytes: number }> = []
          fault.armed = fallback
          for (const budget of [600, 2400]) {
            await Bun.write(file, JSON.stringify({ ...cfg, budget }))
            await f.api.refresh(true)
            for (const policy of [false, true]) {
              await f.api.configure({ ...(await f.api.policy()), exclude: policy ? excluded : [] })
              const result = await f.api.retrieve("harbor alarm", { exclude: policy ? [] : excluded })
              expect(result.audit?.channels?.find((item) => item.name === "keyword")?.state).toBe(
                fallback ? "fallback" : "completed",
              )
              expect(result.matches.every((item) => !excluded.includes(item.source.id))).toBe(true)
              expect(
                result.audit?.candidates
                  .filter((item) => excluded.includes(item.source))
                  .every((item) => item.state === "omitted" && item.reason === "Excluded by developer"),
              ).toBe(true)
              expect(result.audit?.candidates.some((item) => excluded.includes(item.source))).toBe(true)
              expect(
                result.matches.every((item) =>
                  sources.some(
                    (source) =>
                      source.id === item.source.id &&
                      source.hash === item.source.hash &&
                      source.text === item.source.text,
                  ),
                ),
              ).toBe(true)
              expect(result.tokens).toBe(Buffer.byteLength(result.text))
              expect(result.tokens).toBeLessThanOrEqual(budget)
              rows.push({
                budget,
                policy,
                ids: result.matches.map((item) => item.source.id).sort(),
                bytes: result.tokens,
              })
            }
          }
          expect(fault.errors).toBe(fallback ? 4 : 0)
          const failure = await f.api.retrieve("harbor alarm", { pin: [excluded.at(0)!] }).then(
            () => undefined,
            (err: unknown) => err,
          )
          expect(failure).toBeInstanceOf(Error)
          expect(String(failure)).toContain("Pinned excerpt is excluded")
          await f.api.configure({ ...(await f.api.policy()), exclude: [] })
          const restored = await f.api.retrieve("harbor alarm")
          expect(restored.matches.some((item) => excluded.includes(item.source.id))).toBe(true)

          for (const row of rows) expect(row.ids).toEqual(allowed.map((item) => item.id).sort())
        } finally {
          await f.api.dispose()
          f.db.close()
          await rm(root, { recursive: true, force: true })
        }
      }, 30_000)
    }
  }
})

describe("fresh-admission", () => {
  for (const selector of ["ranked", "greedy", "knapsack"] as const) {
    for (const kind of ["repository", "collection"] as const) {
      for (const change of ["edit", "delete"] as const) {
        test(`${selector}/${kind}/${change}: current channel evidence replaces an invalidated candidate`, async () => {
          const root = await realpath(await mkdtemp(path.join(tmpdir(), "forge-fresh-")))
          await Bun.write(
            path.join(root, ".kilo/forge.jsonc"),
            JSON.stringify({
              selector,
              candidates: 1,
              budget: 600,
              exclude: [".kilo/**"],
            }),
          )
          const file = path.join(root, kind === "repository" ? "first.txt" : ".kilo/first.txt")
          const text = "Recovery requires the original journal."
          await Bun.write(file, text)
          await Bun.write(path.join(root, "second.txt"), "Recovery requires a verified checkpoint.")
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
          let records: Source[] = []
          let mutations = 0
          const mutate = async () => {
            if (!records.length) return
            mutations++
            if (change === "delete") return rm(file)
            await Bun.write(file, "Changed content is not reviewed evidence.")
          }
          const api = engine({
            root,
            store: storage,
            provider: async () => "test",
            complete: async () => {
              throw new Error("No model calls permitted")
            },
            ...(kind === "repository"
              ? {
                  semantic: async () => {
                    await mutate()
                    return records.map((source) => ({ source, score: 1, reason: "Semantic boundary input" }))
                  },
                }
              : {
                  docs: async () => {
                    await mutate()
                    return records
                  },
                }),
          })
          try {
            const snapshot = await api.refresh()
            const second = snapshot.sources.find((item) => item.uri === "second.txt" && item.method === "file")!
            const first = await (async () => {
              if (kind === "repository")
                return snapshot.sources.find((item) => item.uri === "first.txt" && item.method === "file")!
              const collection = await api.register({ kind: "file", label: "Journal", location: file, session: "chat" })
              await api.approve(collection.id, "chat", ["test"])
              await api.index(collection.id, "chat")
              await api.retrieve("settle indexing", { session: "chat" })
              return (await storage.knowledge(root, "chat", "test")).find(
                (item) =>
                  item.detail.collection === collection.id &&
                  item.method !== "collection-document" &&
                  item.text === text,
              )!
            })()
            expect(first).toBeDefined()
            records = [first, second]
            const opts = { session: "chat", docs: kind === "collection" }
            const lookup = await api.lookup({
              tool: kind === "repository" ? "forge_search_code" : "forge_search_docs",
              query: "unmatched request",
              session: "chat",
            })
            const result = lookup.result
            expect(result.matches.map((item) => item.source.id)).toEqual([second.id])
            expect(result.matches.at(0)?.source).toEqual(second)
            expect(result.tokens).toBe(Buffer.byteLength(result.text))
            expect(result.tokens).toBeLessThanOrEqual(600)
            expect((await api.request(lookup.request, "chat"))?.selection).toEqual(result.audit)
            expect(await api.request(lookup.request, "private")).toBeUndefined()
            const channel = kind === "repository" ? "semantic" : "dependency-docs"
            expect(result.audit?.candidates.find((item) => item.source === second.id)?.channels).toContainEqual(
              expect.objectContaining({ name: channel, rank: 2 }),
            )
            if (kind === "collection") {
              expect(JSON.stringify(result)).not.toContain(first.id)
              expect(JSON.stringify(result)).not.toContain(first.text)
            } else {
              expect(result.reasons?.[first.id]).toBe("Source changed or is unavailable")
            }
            // Restore the indexed original before each new channel-time mutation.
            await Bun.write(file, text)
            const excluded = await api.retrieve("unmatched request", { ...opts, exclude: [second.id] })
            expect(excluded.matches).toEqual([])
            await Bun.write(file, text)
            const before = mutations
            const pinned = await api
              .retrieve("unmatched request", { ...opts, pin: [first.id] })
              .catch((error: unknown) => error)
            expect(mutations).toBe(before + 1)
            expect(String(pinned)).toContain("Pinned excerpt changed or is unavailable")
          } finally {
            await api.dispose()
            db.close()
            await rm(root, { recursive: true, force: true })
          }
        })
      }
    }
  }
})
