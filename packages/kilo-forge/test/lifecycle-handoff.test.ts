import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { deadline } from "../src/deadline"
import { engine } from "../src/engine"
import { knowledge } from "../src/knowledge"
import { type Source } from "../src/schema"
import { store } from "../src/store"
import { retrieval } from "../src/retrieval"

describe("fresh-lifecycle", () => {
  async function fixture(gate: "permission" | "destination", selector = "ranked") {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "forge-lifecycle-")))
    await Bun.write(
      path.join(root, ".kilo/forge.jsonc"),
      JSON.stringify({
        selector,
        candidates: 1,
        budget: 600,
        exclude: [".kilo/**"],
      }),
    )
    const file = path.join(root, ".kilo/journal.txt")
    await Bun.write(file, "The private journal requires a verified checkpoint.")
    await Bun.write(path.join(root, "fallback.txt"), "Independent recovery evidence remains available.")
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
    let armed = false
    let channels = false
    async function hold() {
      if (!armed) return
      armed = false
      reached.resolve()
      await release.promise
    }
    const authorize = async () => {
      if (gate === "permission") await hold()
    }
    const destination = async () => {
      if (gate === "destination") await hold()
      return { fingerprint: "route", origins: [] }
    }
    const library = knowledge(root, storage, { authorize, destination })
    let records: Source[] = []
    const api = engine({
      root,
      store: storage,
      authorize,
      destination,
      provider: async () => "test",
      complete: async () => {
        throw new Error("No model calls permitted")
      },
      docs: async () => {
        if (channels) armed = true
        return records
      },
    })
    const item = await library.register(
      gate === "permission"
        ? { kind: "file", label: "Journal", location: file, session: "chat" }
        : {
            kind: "text",
            label: "Journal",
            location: "",
            content: "The private journal requires a verified checkpoint.",
            session: "chat",
          },
    )
    await library.approve(item.id, "chat", ["test"], { test: "route" })
    await library.index(item.id, "chat")
    const original = (await storage.knowledge(root, "chat", "test")).find(
      (source) => source.detail.collection === item.id && source.method === "collection-section",
    )!
    const snapshot = await api.refresh()
    const fallback = snapshot.sources.find((source) => source.uri === "fallback.txt" && source.method === "file")!
    records = [original, fallback]
    async function mutate(action: string) {
      if (action === "pause") await library.stop(item.id, "chat")
      if (action === "remove") await library.stop(item.id, "chat", true)
      if (action === "revoke") await library.approve(item.id, "chat", [])
      if (action === "purge") await library.purge(item.id, "chat")
    }
    return {
      root,
      storage,
      library,
      api,
      item,
      original,
      fallback,
      mutate,
      arm() {
        armed = true
      },
      channels() {
        channels = true
      },
      reached: () => deadline(() => reached.promise, undefined, 2000),
      release: () => release.resolve(),
      async [Symbol.asyncDispose]() {
        release.resolve()
        await Promise.all([api.dispose(), library.dispose()])
        db.close()
        await rm(root, { recursive: true, force: true })
      },
    }
  }

  for (const gate of ["permission", "destination"] as const) {
    for (const action of ["pause", "remove", "revoke", "purge", "unchanged"] as const) {
      test(`${gate}/${action}: freshness rejects collection changes across an asynchronous check`, async () => {
        await using f = await fixture(gate)
        expect(await f.library.fresh(f.original, "chat", "test")).toBe(true)
        f.arm()
        const pending = f.library.fresh(f.original, "chat", "test").then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        )
        await f.reached()
        await f.mutate(action)
        f.release()
        expect(await pending).toEqual({ value: action === "unchanged" })
        if (action === "purge") {
          expect(await f.library.fresh(f.original, "chat", "test")).toBe(false)
          expect(await f.storage.collection(f.root, f.item.id)).toBeUndefined()
        }
      })
    }
  }

  for (const selector of ["ranked", "greedy", "knapsack"] as const) {
    for (const action of ["pause", "remove", "revoke"] as const) {
      test(`${selector}/${action}: retrieval withholds collection revoked during final permission validation`, async () => {
        await using f = await fixture("permission", selector)
        expect(await f.library.fresh(f.original, "chat", "test")).toBe(true)
        f.channels()
        const pending = f.api.lookup({ tool: "forge_search_docs", query: "unmatched request", session: "chat" }).then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        )
        await f.reached()
        await f.mutate(action)
        f.release()
        const result = await pending
        if ("error" in result) throw result.error
        expect(result.value.result.matches.map((match) => match.source.id)).toEqual([f.fallback.id])
        expect(result.value.result.matches.at(0)?.source).toEqual(f.fallback)
        expect(JSON.stringify(result.value.result)).not.toContain(f.original.id)
        expect(JSON.stringify(result.value.result)).not.toContain(f.original.text)
        expect((await f.api.request(result.value.request, "chat"))?.selection).toEqual(result.value.result.audit)
        expect(await f.api.request(result.value.request, "private")).toBeUndefined()
        expect(result.value.result.tokens).toBe(Buffer.byteLength(result.value.result.text))
        expect(result.value.result.tokens).toBeLessThanOrEqual(600)
      })
    }
  }
})

describe("preparation-fresh", () => {
  for (const selector of ["ranked", "greedy", "knapsack"] as const) {
    for (const mode of ["automatic", "pinned"] as const) {
      for (const action of [
        "repository-edit",
        "repository-delete",
        "document-edit",
        "cache-text",
        "cache-parent",
        "pause",
        "remove",
        "revoke",
        "destination",
        "unchanged",
      ] as const) {
        test(`${selector}/${mode}/${action}: preparation rechecks evidence after final authorization`, async () => {
          const root = await realpath(await mkdtemp(path.join(tmpdir(), "forge-preparation-")))
          await Bun.write(
            path.join(root, ".kilo/forge.jsonc"),
            JSON.stringify({ selector, budget: 2400, exclude: [".kilo/**"] }),
          )
          const file = path.join(root, "journal.txt")
          const document = path.join(root, ".kilo/reference.txt")
          await Bun.write(file, "Recovery requires a verified checkpoint.")
          await Bun.write(document, "Journal recovery requires a signed maintenance record.")
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
          let armed = true
          let calls = 0
          let route = "approved"
          let records: Source[] = []
          const destination = async () => ({ fingerprint: route, origins: [] })
          const library = knowledge(root, storage, { destination })
          const api = engine({
            root,
            store: storage,
            destination,
            provider: async () => "test",
            authorize: async () => {
              if (!armed || (await storage.latest(root, "chat", "enhance"))?.state !== "assembled") return
              armed = false
              reached.resolve()
              await release.promise
            },
            docs: async () => records,
            complete: async (input) => {
              calls++
              expect(input.prompt).toContain(records.at(0)!.text)
              expect(input.prompt).toContain(records.at(1)!.text)
              throw new Error("Preparation boundary reached")
            },
          })
          try {
            const item = await library.register({ kind: "file", label: "Reference", location: document })
            await library.approve(item.id, "", ["test"], { test: "approved" })
            await library.index(item.id)
            const original = (await storage.knowledge(root, "chat", "test")).find(
              (source) => source.detail.collection === item.id && source.method === "collection-section",
            )!
            const snapshot = await api.refresh()
            const repository = snapshot.sources.find(
              (source) => source.uri === "journal.txt" && source.method === "file",
            )!
            records = [original, repository]
            const pending = api
              .enhance({
                text: "unmatched request",
                session: "chat",
                pin: mode === "pinned" ? records.map((source) => source.id) : [],
              })
              .then(
                (value) => ({ value }),
                (error: unknown) => ({ error }),
              )
            try {
              await deadline(() => reached.promise, undefined, 2000)
              if (action === "repository-edit") await Bun.write(file, "Changed repository evidence.")
              if (action === "repository-delete") await rm(file)
              if (action === "document-edit") await Bun.write(document, "Changed registered evidence.")
              if (action === "cache-text" || action === "cache-parent") {
                const collection = (await storage.collection(root, item.id))!
                const sources = await storage.knowledge(root)
                await storage.publish(
                  root,
                  collection,
                  sources.map((source) => {
                    if (action === "cache-text" && source.id === original.id)
                      return { ...source, text: "Changed cached evidence." }
                    if (action === "cache-parent" && source.method === "collection-document")
                      return { ...source, label: "Changed cached parent." }
                    return source
                  }),
                )
              }
              if (action === "pause") await library.stop(item.id)
              if (action === "remove") await library.stop(item.id, "", true)
              if (action === "revoke") await library.approve(item.id, "", [])
              if (action === "destination") route = "unapproved"
            } finally {
              release.resolve()
            }
            const result = await pending
            expect("error" in result).toBe(true)
            if (!("error" in result)) throw new Error("Expected preparation rejection")
            expect(String(result.error)).toContain(
              action === "unchanged"
                ? "Preparation boundary reached"
                : "Evidence changed or is unavailable before preparation",
            )
            expect(calls).toBe(action === "unchanged" ? 1 : 0)
            const latest = await storage.latest(root, "chat", "enhance")
            const history = await api.request(latest!.id, "chat")
            expect(history?.state).toBe("failed")
            expect(history?.entries.map((entry) => entry.source).sort()).toEqual(
              records.map((source) => source.id).sort(),
            )
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
})

describe("policy-race", () => {
  async function fixture(phase: "channels" | "authorization") {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "forge-policy-race-")))
    await Bun.write(
      path.join(root, ".kilo/forge.jsonc"),
      JSON.stringify({ budget: 600, candidates: 1, exclude: [".kilo/**"] }),
    )
    await Bun.write(path.join(root, "journal.txt"), "Recovery requires the original journal.")
    await Bun.write(path.join(root, "fallback.txt"), "Recovery requires a verified checkpoint.")
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
    let armed = false
    let calls = 0
    let records: Source[] = []
    async function hold() {
      if (!armed) return
      armed = false
      reached.resolve()
      await release.promise
    }
    const library = knowledge(root, storage)
    const api = engine({
      root,
      store: storage,
      provider: async () => "test",
      authorize: async () => {
        if (phase === "authorization" && (await storage.latest(root, "chat", "enhance"))?.state === "assembled")
          await hold()
      },
      docs: async () => {
        if (phase === "channels") await hold()
        return records
      },
      complete: async () => {
        calls++
        throw new Error("Preparation boundary reached")
      },
    })
    const snapshot = await api.refresh()
    const fallback = snapshot.sources.find((item) => item.uri === "fallback.txt" && item.method === "file")!
    const original = await (async () => {
      if (phase === "channels")
        return snapshot.sources.find((item) => item.uri === "journal.txt" && item.method === "file")!
      const item = await library.register({
        kind: "text",
        label: "Journal",
        location: "",
        content: "Registered journal recovery evidence.",
      })
      await library.approve(item.id, "", ["test"])
      await library.index(item.id)
      return (await storage.knowledge(root, "chat", "test")).find(
        (source) => source.detail.collection === item.id && source.method === "collection-section",
      )!
    })()
    records = [original]
    return {
      api,
      storage,
      root,
      original,
      fallback,
      arm() {
        armed = true
      },
      calls: () => calls,
      reached: () => deadline(() => reached.promise, undefined, 2000),
      release: () => release.resolve(),
      async [Symbol.asyncDispose]() {
        release.resolve()
        await Promise.all([api.dispose(), library.dispose()])
        db.close()
        await rm(root, { recursive: true, force: true })
      },
    }
  }

  for (const operation of ["retrieve", "lookup", "enhance"] as const) {
    for (const session of ["", "chat", "other"] as const) {
      for (const action of ["exclude", "pin"] as const) {
        test(`${operation}/${session || "workspace"}/${action}: in-flight retrieval respects policy versions`, async () => {
          await using f = await fixture("channels")
          f.arm()
          const pending = (
            operation === "retrieve"
              ? f.api.retrieve("unmatched request", { session: "chat", docs: true })
              : operation === "lookup"
                ? f.api.lookup({ tool: "forge_search_docs", query: "unmatched request", session: "chat" })
                : f.api.enhance({ text: "unmatched request", session: "chat" })
          ).then(
            (value) => ({ value }),
            (error: unknown) => ({ error }),
          )
          await f.reached()
          const policy = await f.api.policy(session)
          await f.api.configure({
            ...policy,
            ...(action === "exclude" ? { exclude: [f.original.id] } : { pin: [f.fallback.id] }),
          })
          f.release()
          const result = await pending
          if (session === "other" && operation !== "enhance") {
            if ("error" in result) throw result.error
            const selected = "result" in result.value ? result.value.result : result.value
            expect("matches" in selected && selected.matches.some((item) => item.source.id === f.original.id)).toBe(
              true,
            )
            return
          }
          expect("error" in result).toBe(true)
          if (!("error" in result)) throw new Error("Expected invalidated retrieval")
          expect(String(result.error)).toContain(
            session === "other" ? "Preparation boundary reached" : "Context policy changed",
          )
          expect(f.calls()).toBe(session === "other" ? 1 : 0)
          if (session !== "other" && operation !== "retrieve") {
            const latest = await f.storage.latest(f.root, "chat", operation === "lookup" ? "tool-retrieval" : "enhance")
            const history = await f.api.request(latest!.id, "chat")
            expect(history?.state).toBe("failed")
            expect(history?.entries).toEqual([])
            expect(history?.selection).toBeUndefined()
            expect(history?.retrieval?.state).toBe("failed")
          }
          if (session !== "other") {
            const retry = await f.api.retrieve("unmatched request", { session: "chat", docs: true })
            expect(retry.policy).toBe((await f.api.policy("chat")).version)
            if (action === "exclude") expect(retry.matches.some((item) => item.source.id === f.original.id)).toBe(false)
            if (action === "pin") expect(retry.matches.some((item) => item.source.id === f.fallback.id)).toBe(true)
          }
        })
      }
    }
  }

  for (const session of ["", "chat", "other"] as const) {
    test(`${session || "workspace"}: policy is rechecked after retrieval history completion`, async () => {
      await using f = await fixture("channels")
      const reached = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const journal = retrieval(async (value) => {
        await Bun.write(path.join(f.root, ".kilo/retrieval.json"), JSON.stringify(value))
        if (value.state !== "completed") return
        reached.resolve()
        await release.promise
      })
      const pending = f.api.retrieve("unmatched request", { session: "chat", docs: true, journal }).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      )
      try {
        await deadline(() => reached.promise, undefined, 2000)
        await f.api.configure({ ...(await f.api.policy(session)), exclude: [f.original.id] })
      } finally {
        release.resolve()
      }
      const result = await pending
      if (session === "other") {
        if ("error" in result) throw result.error
        expect(result.value.matches.some((item) => item.source.id === f.original.id)).toBe(true)
        return
      }
      expect("error" in result).toBe(true)
      if (!("error" in result)) throw new Error("Expected invalidated retrieval")
      expect(String(result.error)).toContain("Context policy changed")
    })
  }

  for (const session of ["", "chat", "other"] as const) {
    test(`${session || "workspace"}: policy is rechecked after final preparation authorization`, async () => {
      await using f = await fixture("authorization")
      f.arm()
      const pending = f.api.enhance({ text: "unmatched request", session: "chat" }).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      )
      await f.reached()
      await f.api.configure({ ...(await f.api.policy(session)), exclude: [f.original.id] })
      f.release()
      const result = await pending
      expect("error" in result).toBe(true)
      if (!("error" in result)) throw new Error("Expected preparation rejection")
      expect(String(result.error)).toContain(
        session === "other" ? "Preparation boundary reached" : "Context policy changed",
      )
      expect(f.calls()).toBe(session === "other" ? 1 : 0)
      const latest = await f.storage.latest(f.root, "chat", "enhance")
      const history = await f.api.request(latest!.id, "chat")
      expect(history?.state).toBe("failed")
      expect(history?.attempts ?? []).toEqual([])
    })
  }
})
