import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { setImmediate as immediate } from "node:timers/promises"
import { store, type Query } from "../src/store"
import { knowledge } from "../src/knowledge"
import { engine, type Ports } from "../src/engine"
import { downloader } from "../src/download"
import { deadline } from "../src/deadline"
import { wait } from "../src/wait"

async function fixture() {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "forge-waits-")))
  const root = path.join(dir, "repo")
  await mkdir(root)
  const db = new Database(path.join(dir, "store.sqlite"))
  db.exec("PRAGMA journal_mode=WAL")
  const reader = new Database(path.join(dir, "store.sqlite"), { readonly: true })
  let queue = Promise.resolve()
  let hold:
    | { entered: ReturnType<typeof Promise.withResolvers<void>>; gate: ReturnType<typeof Promise.withResolvers<void>> }
    | undefined
  let writes = 0
  const batches: string[][] = []
  const storage = store({
    all: async (query) =>
      reader.query<Record<string, unknown>, (string | number | null)[]>(query.text).all(...(query.values ?? [])),
    batch(queries: readonly Query[]) {
      writes++
      batches.push(
        queries.map((query) =>
          query.text === "INSERT OR REPLACE INTO forge_records(workspace,kind,id,body,updated) VALUES(?,?,?,?,?)"
            ? `record:${query.values?.at(1)}`
            : query.text,
        ),
      )
      const pending = queue.then(async () => {
        const blocked = queries.some((query) => query.text.startsWith("INSERT OR REPLACE INTO forge_sources"))
          ? hold
          : undefined
        if (blocked) hold = undefined
        db.exec("BEGIN IMMEDIATE")
        try {
          for (const query of queries) db.query(query.text).run(...(query.values ?? []))
          if (blocked) {
            blocked.entered.resolve()
            await blocked.gate.promise
          }
          db.exec("COMMIT")
        } catch (err) {
          db.exec("ROLLBACK")
          throw err
        }
      })
      queue = pending.catch(() => undefined)
      return pending
    },
  })
  await storage.ready
  return {
    root,
    storage,
    writes: () => writes,
    batches: () => batches,
    hold() {
      const value = { entered: Promise.withResolvers<void>(), gate: Promise.withResolvers<void>() }
      hold = value
      return value
    },
    async close() {
      await queue
      reader.close()
      db.close()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

function observe<A>(
  storage: ReturnType<typeof store>,
  root: string,
  read: () => Promise<A>,
  accept: (value: A) => boolean,
  milliseconds = 8000,
) {
  const done = Promise.withResolvers<A>()
  const controller = new AbortController()
  const off = storage.subscribe(root, () => {
    void Promise.resolve()
      .then(read)
      .then((value) => {
        if (!controller.signal.aborted && accept(value)) done.resolve(value)
      })
      .catch(done.reject)
  })
  // Keep an abandoned observer's rejection handled, while still surfacing it
  // to an awaiting test. Cleanup must not leave deadlines in subsequent tests.
  const result = deadline(() => done.promise, controller.signal, milliseconds).then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  )
  return {
    get promise() {
      return result.then((item) => {
        if ("error" in item) throw item.error
        return item.value
      })
    },
    off() {
      off()
      controller.abort()
    },
  }
}

test("disposing an unfinished observation cancels its deadline immediately", async () => {
  const f = await fixture()
  const observation = observe(f.storage, f.root, async () => false, Boolean, 30)
  const result = observation.promise.then(
    () => undefined,
    (err: unknown) => err,
  )
  try {
    observation.off()
    const error = await result
    expect(error).toBeInstanceOf(Error)
    expect(error instanceof Error && error.name).toBe("AbortError")
  } finally {
    observation.off()
    await f.close()
  }
})

test("disposed observations ignore late reads and preserve active read failures", async () => {
  const f = await fixture()
  const entered = Promise.withResolvers<void>()
  const gate = Promise.withResolvers<boolean>()
  let accepted = 0
  const observation = observe(
    f.storage,
    f.root,
    () => {
      entered.resolve()
      return gate.promise
    },
    () => {
      accepted++
      return true
    },
  )
  try {
    f.storage.changed(f.root, "knowledge")
    await entered.promise
    observation.off()
    gate.resolve(true)
    await immediate()
    const error = await observation.promise.then(
      () => undefined,
      (err: unknown) => err,
    )
    expect(error).toBeInstanceOf(DOMException)
    expect(accepted).toBe(0)
    const failure = new Error("Observation read failed")
    const broken = observe(
      f.storage,
      f.root,
      async () => {
        throw failure
      },
      Boolean,
    )
    try {
      f.storage.changed(f.root, "knowledge")
      await immediate()
      expect(
        await broken.promise.then(
          () => undefined,
          (err: unknown) => err,
        ),
      ).toBe(failure)
    } finally {
      broken.off()
    }
  } finally {
    observation.off()
    gate.resolve(false)
    await f.close()
  }
})

test.each(["permission", "freshness"] as const)(
  "held %s preflight has live beats, prompt cancellation and no late evidence",
  async (phase) => {
    const f = await fixture()
    const gate = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    const publication = Promise.withResolvers<void>()
    const request = f.storage.request.bind(f.storage)
    // Keep the initial journal publication queued until permission is already held.
    f.storage.request = async (...args) => {
      const value = await request(...args)
      if (value?.state === "retrieving" && !value.retrieval) await publication.promise
      return value
    }
    let held = false
    let channels = 0
    const authorize: Ports["authorize"] = async (item, _session, providers) => {
      if (!held || !providers.length || item.kind !== (phase === "permission" ? "folder" : "file")) return
      entered.resolve()
      await gate.promise
    }
    const library = knowledge(f.root, f.storage)
    const api = engine({
      root: f.root,
      store: f.storage,
      authorize,
      provider: async () => "local",
      memory: async () => {
        channels++
        return []
      },
      complete: async () => {
        throw new Error("No model calls allowed")
      },
    })
    const controller = new AbortController()
    try {
      await mkdir(path.join(f.root, "docs"))
      await Bun.write(path.join(f.root, "docs/guide.md"), "# Epoch\nValidate lease ownership.")
      const item = await library.register({ kind: "folder", label: "Docs", location: "./docs" })
      await library.approve(item.id, "", ["local"])
      await library.index(item.id)
      await api.refresh()
      held = true
      const beats: number[] = []
      const progress = observe(
        f.storage,
        f.root,
        () => api.status("chat"),
        (value) => {
          if (!value.job.message.includes(`${phase} preflight`)) return false
          if (value.job.message.includes("(1s)") || value.job.message.includes("(2s)")) beats.push(value.job.updated)
          return value.job.message.includes("(2s)")
        },
      )
      const terminal = observe(
        f.storage,
        f.root,
        () => api.manifests({ session: "chat" }),
        (items) => items.at(0)?.state === "failed",
      )
      const setup = observe(
        f.storage,
        f.root,
        () => api.manifests({ session: "chat" }),
        (items) => items.at(0)?.retrieval?.phase === "setup",
      )
      const pending = api
        .lookup({ tool: "forge_search_docs", query: "epoch lease", session: "chat", signal: controller.signal })
        .then(
          () => undefined,
          (err: unknown) => err,
        )
      try {
        await deadline(() => entered.promise, undefined, 2000)
        const queued = f.writes()
        publication.resolve()
        await setup.promise
        expect(f.writes()).toBe(queued + 1)
        const writes = f.writes()
        await progress.promise
        expect(beats.length).toBeGreaterThanOrEqual(2)
        expect(beats.at(-1)! - beats.at(0)!).toBeGreaterThanOrEqual(900)
        // A delayed filesystem notification may independently republish the
        // repository. It is not a heartbeat; no request or collection writes fit
        // this exact record-kind set.
        for (const batch of f.batches().slice(writes)) {
          expect(batch.filter((entry) => entry.startsWith("record:")).sort()).toEqual([
            "record:inventory",
            "record:relation-index",
            "record:snapshot",
          ])
        }
        const started = performance.now()
        controller.abort(new Error("Stop preflight"))
        expect(await deadline(() => pending, undefined, 250)).toBeInstanceOf(Error)
        expect(performance.now() - started).toBeLessThan(250)
        const saved = (await terminal.promise).at(0)!
        expect(saved.entries).toEqual([])
        expect(saved.retrieval?.state).toBe("cancelled")
        expect(saved.retrieval?.channels.every((channel) => channel.state === "pending")).toBe(true)
        expect(channels).toBe(0)
        gate.resolve()
        await immediate()
        expect(await api.request(saved.id, "chat")).toEqual(saved)
      } finally {
        progress.off()
        terminal.off()
        setup.off()
        publication.resolve()
        gate.resolve()
        await pending
      }
    } finally {
      publication.resolve()
      gate.resolve()
      await api.dispose()
      await library.dispose()
      await f.close()
    }
  },
  15_000,
)

test.each(["dns", "callback"] as const)(
  "held download %s emits beats and pause rejects late bytes",
  async (mode) => {
    const f = await fixture()
    const entered = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<void>()
    let extracts = 0
    const library = knowledge(f.root, f.storage, {
      download:
        mode === "dns"
          ? downloader({
              resolve: async () => {
                entered.resolve()
                await gate.promise
                return [{ address: "8.8.8.8", family: 4 }]
              },
            })
          : async () => {
              entered.resolve()
              await gate.promise
              return { bytes: new TextEncoder().encode("late evidence"), name: "document.txt" }
            },
      extract: async () => {
        extracts++
        return [{ text: "late evidence" }]
      },
    })
    try {
      const item = await library.register({ kind: "url", label: "Reference", location: "https://example.com/guide" })
      await library.approve(item.id)
      const progress = observe(
        f.storage,
        f.root,
        () => library.get(item.id),
        (value) => value.warnings.some((line) => line.includes("Downloading document") && line.includes("(2s)")),
      )
      const pending = library.index(item.id).then(
        () => undefined,
        (err: unknown) => err,
      )
      try {
        await deadline(() => entered.promise, undefined, 2000)
        const writes = f.writes()
        const live = await progress.promise
        expect(live.progress).toMatchObject({ stage: "discover", bytes: 0, files: 0 })
        expect(f.writes()).toBe(writes)
        await deadline(() => library.stop(item.id), undefined, 250)
        expect(await pending).toBeInstanceOf(Error)
        gate.resolve()
        await immediate()
        expect(extracts).toBe(0)
        expect((await library.get(item.id)).state).toBe("paused")
        expect(await f.storage.knowledge(f.root)).toEqual([])
      } finally {
        progress.off()
        gate.resolve()
        await pending
      }
    } finally {
      gate.resolve()
      await library.dispose()
      await f.close()
    }
  },
  15_000,
)

test.each(["publish", "rollback", "purge", "shutdown"] as const)(
  "held SQLite publication keeps live beats and finishes separately on %s",
  async (mode) => {
    const f = await fixture()
    const library = knowledge(f.root, f.storage)
    const api = engine({
      root: f.root,
      store: f.storage,
      complete: async () => {
        throw new Error("No model calls allowed")
      },
    })
    const item = await library.register({
      kind: "text",
      label: "Reference",
      location: "",
      content: "# Lease\nEpoch ownership evidence.",
    })
    await library.approve(item.id)
    const hold = f.hold()
    const stamps: number[] = []
    const progress = observe(
      f.storage,
      f.root,
      () => api.registry(),
      (value) => {
        const live = value.collections.find((entry) => entry.id === item.id)
        if (live?.warnings.some((line) => line.includes("Publishing documents") && /\([12]s\)/.test(line)))
          stamps.push(live.progress!.updated)
        return live?.warnings.some((line) => line.includes("Publishing documents") && line.includes("(2s)")) ?? false
      },
    )
    const pending = library.index(item.id).then(
      () => "published",
      () => "failed",
    )
    let cleanup: Promise<unknown> | undefined
    try {
      await deadline(() => hold.entered.promise, undefined, 2000)
      const writes = f.writes()
      await progress.promise
      expect(stamps.at(-1)! - stamps.at(0)!).toBeGreaterThanOrEqual(900)
      expect(f.writes()).toBe(writes)
      expect(await f.storage.knowledge(f.root)).toEqual([])
      if (mode === "purge" || mode === "shutdown") {
        const cancelled = observe(
          f.storage,
          f.root,
          () => library.get(item.id),
          (value) => value.warnings.some((line) => line.includes("cancellation pending")),
        )
        cleanup = mode === "purge" ? library.purge(item.id) : library.dispose()
        try {
          await cancelled.promise
          expect(f.writes()).toBe(writes)
          expect((await library.get(item.id)).state).toBe("indexing")
        } finally {
          cancelled.off()
        }
      }
      if (mode === "rollback") hold.gate.reject(new Error("Injected transaction failure"))
      if (mode !== "rollback") hold.gate.resolve()
      expect(await pending).toBe(mode === "publish" ? "published" : "failed")
      await cleanup
      const saved = await f.storage.collection(f.root, item.id)
      if (mode === "purge") {
        expect(saved).toBeUndefined()
        expect(await f.storage.knowledge(f.root)).toEqual([])
        expect((await f.storage.imports(f.root, item.id)).runs).toEqual([])
      }
      if (mode === "publish") {
        expect(saved?.state).toBe("ready")
        expect((await f.storage.knowledge(f.root)).some((source) => source.text.includes("Epoch ownership"))).toBe(true)
      }
      if (mode === "rollback" || mode === "shutdown") {
        expect(saved?.state).toBe("failed")
        expect((await f.storage.knowledge(f.root)).every((source) => source.status !== "current")).toBe(true)
      }
      const count = f.writes()
      await immediate()
      expect(f.writes()).toBe(count)
    } finally {
      progress.off()
      hold.gate.resolve()
      await pending
      await cleanup
      await api.dispose()
      await library.dispose()
      await f.close()
    }
  },
  15_000,
)

test("repository publication reports cancellation pending while its SQLite transaction remains admitted", async () => {
  const f = await fixture()
  const api = engine({
    root: f.root,
    store: f.storage,
    complete: async () => {
      throw new Error("No model calls allowed")
    },
  })
  await Bun.write(path.join(f.root, "queue.ts"), "export const queue = 'epoch ownership'")
  const hold = f.hold()
  const pending = api.refresh().then(
    () => undefined,
    (err: unknown) => err,
  )
  try {
    await deadline(() => hold.entered.promise, undefined, 2000)
    const progress = observe(
      f.storage,
      f.root,
      () => api.status(),
      (value) => value.job.message.includes("cancellation pending"),
    )
    try {
      api.cancel()
      const live = await progress.promise
      expect(live.job.state).toBe("running")
      expect(live.inventory.indexed).toBe(false)
      hold.gate.resolve()
      expect(await pending).toBeInstanceOf(Error)
      expect((await api.status()).job.state).toBe("cancelled")
      expect((await f.storage.inventory(f.root)).indexed).toBe(true)
    } finally {
      progress.off()
    }
  } finally {
    hold.gate.resolve()
    await pending
    await api.dispose()
    await f.close()
  }
})

test("deadline observation never interrupts an admitted write and stalled means no completion, not an ETA", async () => {
  const gate = Promise.withResolvers<void>()
  const messages: string[] = []
  const signal = AbortSignal.timeout(20)
  const pending = wait(
    () => gate.promise,
    signal,
    (message) => messages.push(message),
    true,
  )
  const aborted = Promise.withResolvers<void>()
  signal.addEventListener("abort", () => aborted.resolve(), { once: true })
  await deadline(() => aborted.promise, undefined, 1000)
  expect(messages.at(-1)).toContain("Deadline exceeded; cancellation pending")
  gate.resolve()
  await pending
  const stalled = Promise.withResolvers<void>()
  const operation = wait(
    () => stalled.promise,
    undefined,
    (message) => {
      if (message.includes("Stalled")) stalled.resolve()
    },
  )
  await deadline(() => operation, undefined, 6500)
}, 8000)

test("the production collection deadline becomes pending during an admitted SQLite write", async () => {
  const f = await fixture()
  const library = knowledge(f.root, f.storage)
  const item = await library.register({ kind: "text", label: "Deadline", location: "", content: "Deadline evidence" })
  await library.approve(item.id)
  const hold = f.hold()
  // This case intentionally waits for the real 30-second production deadline.
  const expired = Promise.withResolvers<void>()
  const off = f.storage.subscribe(f.root, () => {
    void library.get(item.id).then((value) => {
      if (value.warnings.some((line) => line.includes("Deadline exceeded; cancellation pending"))) expired.resolve()
    }, expired.reject)
  })
  let finished = false
  const pending = library.index(item.id).then(
    () => {
      finished = true
      return "published"
    },
    () => {
      finished = true
      return "failed"
    },
  )
  try {
    await deadline(() => hold.entered.promise, undefined, 2000)
    const writes = f.writes()
    await deadline(() => expired.promise, undefined, 32_000)
    expect(finished).toBe(false)
    expect(f.writes()).toBe(writes)
    expect(await f.storage.knowledge(f.root)).toEqual([])
    hold.gate.resolve()
    expect(await pending).toBe("failed")
    expect((await library.get(item.id)).state).toBe("failed")
    expect((await f.storage.knowledge(f.root)).every((source) => source.status !== "current")).toBe(true)
  } finally {
    off()
    hold.gate.resolve()
    await pending
    await library.dispose()
    await f.close()
  }
}, 40_000)

test("cancellation returns during blocked terminal history and shutdown drains admitted persistence", async () => {
  const f = await fixture()
  const entered = Promise.withResolvers<void>()
  const gate = Promise.withResolvers<void>()
  const recorded = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const controller = new AbortController()
  const manifest = f.storage.manifest.bind(f.storage)
  f.storage.manifest = async (value) => {
    if (value.retrieval?.state === "cancelled") {
      recorded.resolve()
      await release.promise
    }
    await manifest(value)
  }
  const api = engine({
    root: f.root,
    store: f.storage,
    provider: async () => {
      entered.resolve()
      await gate.promise
      return "local"
    },
    complete: async () => {
      throw new Error("No model calls allowed")
    },
  })
  const pending = api.enhance({ text: "lease", session: "chat", signal: controller.signal }).then(
    () => undefined,
    (err: unknown) => err,
  )
  try {
    await deadline(() => entered.promise, undefined, 2000)
    controller.abort(new Error("Stop waiting"))
    expect(await deadline(() => pending, undefined, 250)).toBeInstanceOf(Error)
    await deadline(() => recorded.promise, undefined, 2000)
    const progress = observe(
      f.storage,
      f.root,
      () => api.status("chat"),
      (value) => value.job.message.includes("cancellation pending") && value.job.message.includes("(1s)"),
    )
    try {
      const writes = f.writes()
      await progress.promise
      expect(f.writes()).toBe(writes)
      const closing = api.dispose()
      release.resolve()
      await deadline(() => closing, undefined, 2000)
      const saved = (await f.storage.manifests(f.root, { session: "chat" })).at(0)!
      expect(saved.state).toBe("failed")
      expect(saved.entries).toEqual([])
      gate.resolve()
      await immediate()
      expect((await f.storage.manifests(f.root, { session: "chat" })).at(0)).toEqual(saved)
    } finally {
      progress.off()
    }
  } finally {
    gate.resolve()
    release.resolve()
    await pending
    await api.dispose()
    await f.close()
  }
}, 10_000)

test("workspace shutdown cancels held retrieval permission without waiting for its callback", async () => {
  const f = await fixture()
  const entered = Promise.withResolvers<void>()
  const gate = Promise.withResolvers<void>()
  const api = engine({
    root: f.root,
    store: f.storage,
    provider: async () => {
      entered.resolve()
      await gate.promise
      return "local"
    },
    complete: async () => {
      throw new Error("No model calls allowed")
    },
  })
  const pending = api.retrieve("lease").then(
    () => undefined,
    (err: unknown) => err,
  )
  try {
    await deadline(() => entered.promise, undefined, 2000)
    await deadline(() => api.dispose(), undefined, 250)
    expect(await pending).toBeInstanceOf(Error)
  } finally {
    gate.resolve()
    await api.dispose()
    await f.close()
  }
})

test("cancellation during final authorization cannot start a model after late approval", async () => {
  const f = await fixture()
  const library = knowledge(f.root, f.storage)
  const gate = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  let checks = 0
  let calls = 0
  const api = engine({
    root: f.root,
    store: f.storage,
    provider: async () => "local",
    authorize: async (_item, _session, providers) => {
      if (!providers.length || ++checks !== 2) return
      entered.resolve()
      await gate.promise
    },
    complete: async () => {
      calls++
      throw new Error("No model calls allowed")
    },
  })
  const controller = new AbortController()
  try {
    const item = await library.register({
      kind: "text",
      label: "Reference",
      location: "",
      content: "# Lease\nEpoch ownership requires validation.",
    })
    await library.approve(item.id, "", ["local"])
    await library.index(item.id)
    const pending = api.enhance({ text: "epoch ownership", signal: controller.signal }).then(
      () => undefined,
      (err: unknown) => err,
    )
    await deadline(() => entered.promise, undefined, 2000)
    controller.abort(new Error("Cancel final authorization"))
    expect(await deadline(() => pending, undefined, 250)).toBeInstanceOf(Error)
    gate.resolve()
    await api.dispose()
    expect(calls).toBe(0)
    expect((await f.storage.manifests(f.root)).at(0)?.state).toBe("failed")
  } finally {
    gate.resolve()
    await api.dispose()
    await library.dispose()
    await f.close()
  }
})

test("wait observation preserves SQLite evidence without adding writes", async () => {
  const f = await fixture()
  const library = knowledge(f.root, f.storage)
  try {
    const item = await library.register({
      kind: "text",
      label: "Corpus",
      location: "",
      content: Array.from(
        { length: 100 },
        (_, index) => `# Section ${index}\nEpoch ownership requires validation.`,
      ).join("\n"),
    })
    await library.approve(item.id)
    await library.index(item.id)
    const original = await f.storage.knowledge(f.root)
    expect(original.length).toBeGreaterThan(0)
    const writes = f.writes()
    let observations = 0
    const rows = await wait(
      () => f.storage.knowledge(f.root),
      undefined,
      () => {
        observations++
      },
    )
    expect(rows).toEqual(original)
    expect(f.writes()).toBe(writes)
    expect(observations).toBe(1)
  } finally {
    await library.dispose()
    await f.close()
  }
})
