import { expect, test } from "bun:test"
import { retrieval, progress } from "../src/retrieval"
import { decode, RetrievalRun, usage, type Manifest } from "../src/schema"
import { Database } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { store, type Query } from "../src/store"

test("failed execution history survives a file-backed store reopen", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "forge-retrieval-"))
  const filename = path.join(dir, "history.sqlite")
  function open() {
    const db = new Database(filename)
    const api = store({
      all: async (query: Query) =>
        db.query<Record<string, unknown>, (string | number | null)[]>(query.text).all(...(query.values ?? [])),
      batch: async (queries: readonly Query[]) => {
        db.transaction(() => {
          for (const query of queries) db.query(query.text).run(...(query.values ?? []))
        })()
      },
    })
    return { db, api }
  }
  try {
    const first = open()
    const manifest: Manifest = {
      id: "request",
      root: "/workspace",
      session: "private",
      generation: "version",
      purpose: "enhance",
      model: "pending",
      observed: 1,
      entries: [],
      attempts: [],
      coverage: [],
      usage: usage(),
      state: "failed",
    }
    try {
      const history = retrieval(async (value) => first.api.manifest({ ...manifest, retrieval: value }))
      history.phase("channels", "version")
      await history.run("keyword", () => [])
      history.mark("semantic", "running")
      await history.finish("failed")
    } finally {
      first.db.close()
    }
    const second = open()
    try {
      const captured = await second.api.request("/workspace", "private", "request")
      expect(captured?.retrieval).toMatchObject({ state: "failed", generation: "version", phase: "channels" })
      expect(captured?.retrieval?.channels.find((item) => item.name === "keyword")?.state).toBe("completed")
      expect(captured?.retrieval?.channels.find((item) => item.name === "semantic")?.state).toBe("abandoned")
      expect(captured?.entries).toEqual([])
      expect(await second.api.request("/workspace", "other", "request")).toBeUndefined()
      expect(await second.api.request("/other", "private", "request")).toBeUndefined()
      await second.api.manifest({ ...manifest, id: "legacy" })
      expect((await second.api.request("/workspace", "private", "legacy"))?.retrieval).toBeUndefined()
    } finally {
      second.db.close()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("retrieval history snapshots are bounded and ignore late work after cancellation", async () => {
  const saved: RetrievalRun[] = []
  const history = retrieval(async (value) => {
    saved.push(decode(RetrievalRun, value))
  })
  const gate = Promise.withResolvers<number>()
  history.phase("channels", "version")
  const waiting = history.run("semantic", () => gate.promise)
  await history.run("keyword", () => [])
  history.mark("memory", "disabled")
  await history.finish("cancelled")
  const terminal = saved.at(-1)!
  expect(terminal).toMatchObject({ state: "cancelled", phase: "channels", generation: "version" })
  expect(terminal.channels).toHaveLength(8)
  expect(terminal.channels.find((item) => item.name === "collection-semantic")?.state).toBe("pending")
  expect(terminal.channels.find((item) => item.name === "keyword")?.state).toBe("completed")
  expect(terminal.channels.find((item) => item.name === "semantic")?.state).toBe("abandoned")
  expect(terminal.channels.find((item) => item.name === "domains")?.state).toBe("pending")
  expect(saved.at(0)?.channels.every((item) => item.state === "pending")).toBe(true)
  const count = saved.length
  gate.resolve(42)
  expect(await waiting).toBe(42)
  history.phase("selection")
  history.mark("domains", "completed")
  await history.finish("completed")
  expect(saved).toHaveLength(count)
  expect(saved.at(-1)).toEqual(terminal)
  let ran = false
  const error = await history
    .run("memory", () => {
      ran = true
    })
    .then(
      () => undefined,
      (err) => err,
    )
  expect(error).toBeInstanceOf(Error)
  expect(ran).toBe(false)
  expect(progress(terminal).join(" ")).toContain("adapters may have continued running")
  expect(progress()).toEqual(["Retrieval execution history unavailable for this capture."])
})

test("retrieval history preserves channel failure, fallback, and storage failure", async () => {
  const saved: RetrievalRun[] = []
  const history = retrieval(async (value) => {
    saved.push(value)
  })
  const error = await history
    .run("keyword", () => {
      throw new Error("private canary")
    })
    .then(
      () => undefined,
      (err) => err,
    )
  expect(error).toBeInstanceOf(Error)
  history.mark("keyword", "fallback")
  history.phase("selection")
  await history.finish("completed")
  expect(saved.some((item) => item.channels.find((channel) => channel.name === "keyword")?.state === "failed")).toBe(
    true,
  )
  expect(saved.at(-1)?.channels.find((item) => item.name === "keyword")?.state).toBe("fallback")
  expect(JSON.stringify(saved)).not.toContain("private canary")
  const broken = retrieval(async () => {
    throw new Error("storage unavailable")
  })
  await broken.run("keyword", () => [])
  const failure = await broken.finish("completed").then(
    () => undefined,
    (err) => err,
  )
  expect(failure).toBeInstanceOf(Error)
  expect(failure.message).toBe("storage unavailable")
})

for (const state of ["failed", "cancelled"] as const) {
  test(`completed history can be corrected to ${state} without reopening channels`, async () => {
    const saved: RetrievalRun[] = []
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const history = retrieval(async (value) => {
      if (value.state === "completed") {
        entered.resolve()
        await release.promise
      }
      saved.push(value)
    })
    await history.run("keyword", () => [])
    const completion = history.finish("completed")
    await entered.promise
    const correction = history.finish(state)
    release.resolve()
    await Promise.all([completion, correction])
    expect(saved.filter((item) => item.state !== "running").map((item) => item.state)).toEqual(["completed", state])
    expect(saved.at(-1)?.channels.find((item) => item.name === "keyword")?.state).toBe("completed")
    const count = saved.length
    history.phase("selection")
    history.mark("semantic", "completed")
    await history.finish("completed")
    await history.finish(state)
    expect(saved).toHaveLength(count)
    expect(saved.at(-1)?.state).toBe(state)
  })
}
