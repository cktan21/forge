import { expect, test } from "bun:test"
import path from "node:path"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { getEventListeners } from "node:events"
import { IndexingWorker } from "../../src/kilocode/indexing-worker-client"

// These driver controls do not load an Instance or its service runtime.
async function directory() {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "forge-worker-cancel-")))
  return {
    path: dir,
    async [Symbol.asyncDispose]() {
      await rm(dir, { recursive: true, force: true })
    },
  }
}

async function bounded<T>(work: Promise<T>, milliseconds = 1000) {
  const deadline = Promise.withResolvers<undefined>()
  const timer = setTimeout(() => deadline.resolve(undefined), milliseconds)
  try {
    return await Promise.race([work, deadline.promise])
  } finally {
    clearTimeout(timer)
  }
}

for (const action of ["cancel", "dispose"]) {
  test(`real worker ${action} releases held and queued searches without affecting a sibling`, async () => {
    if (process.env.FORGE_SEARCH_TRACE) console.info("fixture start", action)
    await using tmp = await directory()
    await using other = await directory()
    await using cache = await directory()
    if (process.env.FORGE_SEARCH_TRACE) console.info("fixture directories ready")
    for (const dir of [tmp.path, other.path])
      await Bun.write(
        path.join(dir, "file.ts"),
        "export function checkpoint(epoch: number) {\n  return `Current queue lease ${epoch} is checked before dispatch and retry`;\n}\n",
      )
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const calls: string[] = []
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const body: { input: string | string[] } = await request.json()
        const input = Array.isArray(body.input) ? body.input : [body.input]
        calls.push(...input)
        if (input.includes("held")) {
          entered.resolve()
          await release.promise
        }
        return Response.json({
          data: input.map((_, index) => ({ index, embedding: [1, 0, 0] })),
          usage: { prompt_tokens: 1, total_tokens: 1 },
        })
      },
    })
    const failures: unknown[] = []
    const create = (dir: string) => {
      const indexed = Promise.withResolvers<void>()
      const driver = IndexingWorker.create(dir, cache.path, {
        status(value) {
          if (process.env.FORGE_SEARCH_TRACE) console.info("fixture status", dir, value.state, value.message)
          if (value.state === "Complete") indexed.resolve()
        },
        telemetry() {},
        warning() {},
        log(value) {
          if (process.env.FORGE_SEARCH_TRACE) console.info("fixture log", dir, value.message)
        },
        failure(err) {
          failures.push(err)
        },
      })
      return { driver, indexed }
    }
    const left = create(tmp.path)
    const right = create(other.path)
    const cfg = {
      enabled: true,
      embedderProvider: "openai-compatible" as const,
      vectorStoreProvider: "lancedb" as const,
      modelId: "fixture",
      modelDimension: 3,
      openAiCompatibleBaseUrl: `${server.url}v1`,
    }
    const controller = new AbortController()
    const queued = new AbortController()
    const reason = new Error("Semantic request cancelled")
    let running: Promise<unknown> | undefined
    let waiting: Promise<unknown> | undefined
    try {
      if (process.env.FORGE_SEARCH_TRACE) console.info("fixture initializing")
      // Cold engine loading is separate from the one-second cancellation gates.
      expect(
        await bounded(
          left.driver.init(cfg).then(() => true),
          60_000,
        ),
      ).toBe(true)
      expect(
        await bounded(
          left.indexed.promise.then(() => true),
          30_000,
        ),
      ).toBe(true)
      expect(
        await bounded(
          right.driver.init(cfg).then(() => true),
          30_000,
        ),
      ).toBe(true)
      expect(
        await bounded(
          Promise.all([left.indexed.promise, right.indexed.promise]).then(() => true),
          30_000,
        ),
      ).toBe(true)
      running = left.driver.search("held", undefined, undefined, controller.signal).then(
        (value) => value,
        (err: unknown) => err,
      )
      expect(
        await bounded(
          entered.promise.then(() => true),
          10_000,
        ),
      ).toBe(true)
      waiting = left.driver.search("queued", undefined, undefined, queued.signal).then(
        (value) => value,
        (err: unknown) => err,
      )
      const sibling = await bounded(right.driver.search("sibling"))
      expect(Array.isArray(sibling)).toBe(true)
      expect(sibling?.at(0)?.payload?.filePath).toBe("file.ts")
      if (action === "cancel") {
        queued.abort(reason)
        expect(await bounded(waiting)).toBe(reason)
        controller.abort(reason)
        expect(await bounded(running)).toBe(reason)
        expect((await bounded(left.driver.search("fresh")))?.at(0)?.payload?.filePath).toBe("file.ts")
        const early = await left.driver.search("never", undefined, undefined, AbortSignal.abort(reason)).then(
          (value) => value,
          (err: unknown) => err,
        )
        expect(early).toBe(reason)
      }
      if (action === "dispose") {
        expect(await bounded(left.driver.dispose().then(() => true))).toBe(true)
        expect(await bounded(running)).toBeInstanceOf(Error)
        expect(await bounded(waiting)).toBeInstanceOf(Error)
      }
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)
      expect(getEventListeners(queued.signal, "abort")).toHaveLength(0)
      expect((await bounded(right.driver.search("survivor")))?.at(0)?.payload?.filePath).toBe("file.ts")
      expect(calls).not.toContain("queued")
      expect(calls).not.toContain("never")
      expect(calls).toContain("sibling")
      expect(failures).toEqual([])
    } finally {
      release.resolve()
      await Promise.allSettled([running, waiting])
      await Promise.all([left.driver.dispose(), right.driver.dispose()])
      await server.stop(true)
    }
    expect(failures).toEqual([])
  }, 120_000)
}
