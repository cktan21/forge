import { expect, test } from "bun:test"
import { rejects } from "node:assert/strict"
import { exportEmbeddings } from "../src/embedding-export"
import { account } from "../src/embedding-usage"
import type { EmbeddingAttempt } from "../src/schema"

function entry(id: string): EmbeddingAttempt {
  return {
    id,
    session: "chat",
    collections: ["one", "two"],
    target: { fingerprint: "target", model: "fixture", dimensions: 2 },
    purpose: "query",
    started: 1,
    usage: account(undefined, { state: "attempt", inputs: 1, bytes: 40 }),
  }
}

test("export groups only observed entries and preserves unknown, zero and live-history semantics", async () => {
  const first = entry("one")
  const second = { ...entry("two"), finished: 2, usage: account(first.usage, { state: "response", prompt: 0 }) }
  const third = {
    ...entry("three"),
    purpose: "index" as const,
    finished: 2,
    usage: account(first.usage, { state: "response", prompt: 7, total: 7 }),
  }
  const requests: unknown[] = []
  const value = await exportEmbeddings({
    session: "chat",
    read: async (request) => {
      requests.push(request)
      return request.after == null
        ? { session: "chat", entries: [first, second], next: "10" }
        : { session: "chat", entries: [third] }
    },
  })
  expect(requests).toEqual([
    { session: "chat", limit: 100 },
    { session: "chat", limit: 100, after: "10" },
  ])
  expect(value.entries).toHaveLength(3)
  expect(value.groups).toHaveLength(2)
  expect(value.groups.at(0)).toMatchObject({
    usage: {
      attempts: 2,
      inputs: 2,
      bytes: 80,
      responses: 1,
      pending: 1,
      promptTokens: 0,
      promptReports: 1,
      totalReports: 0,
    },
    unknown: { prompt: 1, total: 2 },
  })
  expect(value.groups.at(1)).toMatchObject({
    purpose: "index",
    usage: { promptTokens: 7, totalTokens: 7 },
    unknown: { prompt: 0, total: 0 },
  })
  expect(value).toMatchObject({
    traversal: "exhausted",
    snapshot: false,
    history: "recorded-admissions-only",
    cost: null,
  })
  expect(value.warnings.join(" ")).toContain("does not prove complete historical usage")
})

test("bounded export retains a resume cursor without calling unrequested pages", async () => {
  let calls = 0
  const value = await exportEmbeddings({
    session: "chat",
    max: 1,
    after: "20",
    read: async (request) => {
      calls++
      expect(request).toEqual({ session: "chat", limit: 1, after: "20" })
      return { session: "chat", entries: [entry("one")], next: "10" }
    },
  })
  expect(calls).toBe(1)
  expect(value).toMatchObject({ traversal: "limited", after: "20", next: "10" })
  const empty = await exportEmbeddings({ session: "chat", read: async () => ({ session: "chat", entries: [] }) })
  expect(empty.groups).toEqual([])
  expect(empty.history).toBe("recorded-admissions-only")
})

for (const page of [
  { session: "foreign", entries: [] },
  { session: "chat", entries: [], next: "10" },
  { session: "chat", entries: [entry("one")], next: "20" },
  { session: "chat", entries: [entry("one")], next: "bad" },
  { session: "chat", entries: [{ ...entry("one"), session: "foreign" }] },
  { session: "chat", entries: [entry("one"), entry("one")] },
  { session: "chat", entries: [{ ...entry("one"), collections: [] }] },
  { session: "chat", entries: [{ ...entry("one"), usage: { ...entry("one").usage, attempts: 2 } }] },
  { session: "chat", entries: [{ ...entry("one"), finished: 2 }] },
]) {
  test(`invalid export page is rejected: ${JSON.stringify(page)}`, async () => {
    await rejects(exportEmbeddings({ session: "chat", after: "20", read: async () => page }))
  })
}

test("export rejects repeated entries across pages, unsafe subtotals and oversized records", async () => {
  await rejects(
    exportEmbeddings({
      session: "chat",
      read: async (request) => ({
        session: "chat",
        entries: [entry("one")],
        ...(request.after == null ? { next: "10" } : {}),
      }),
    }),
    /repeated/,
  )
  await rejects(
    exportEmbeddings({
      session: "chat",
      read: async () => ({
        session: "chat",
        entries: ["one", "two"].map((id) => ({
          ...entry(id),
          finished: 2,
          usage: account(entry(id).usage, { state: "response", total: Number.MAX_SAFE_INTEGER }),
        })),
      }),
    }),
  )
  await rejects(
    exportEmbeddings({
      session: "chat",
      read: async () => ({
        session: "chat",
        entries: [{ ...entry("one"), collections: ["x".repeat(16 * 1024 * 1024)] }],
      }),
    }),
    /16 MiB/,
  )
})

test("cancelled export releases an uncooperative read and rejects partial output", async () => {
  const entered = Promise.withResolvers<void>()
  const released = Promise.withResolvers<void>()
  const controller = new AbortController()
  const pending = exportEmbeddings({
    session: "chat",
    signal: controller.signal,
    read: async () => {
      entered.resolve()
      await released.promise
      return { session: "chat", entries: [] }
    },
  })
  const rejected = rejects(pending, /cancel export/)
  await entered.promise
  controller.abort(new Error("cancel export"))
  await rejected
  released.resolve()
})

test("invalid export bounds fail before reading", async () => {
  let calls = 0
  const read = async () => {
    calls++
    return { session: "", entries: [] }
  }
  for (const max of [0, -1, 1.5, 10001]) await rejects(exportEmbeddings({ session: "", max, read }))
  await rejects(exportEmbeddings({ session: "", after: "0", read }))
  expect(calls).toBe(0)
})

test("export keeps different destinations separate and fails on later permission errors", async () => {
  const value = await exportEmbeddings({
    session: "chat",
    read: async () => ({
      session: "chat",
      entries: [entry("one"), { ...entry("two"), target: { ...entry("two").target, fingerprint: "other" } }],
    }),
  })
  expect(value.groups).toHaveLength(2)
  expect(value.groups.map((group) => group.usage.attempts)).toEqual([1, 1])
  await rejects(
    exportEmbeddings({
      session: "chat",
      read: async (request) => {
        if (request.after) throw new Error("Permission revoked")
        return { session: "chat", entries: [entry("one")], next: "10" }
      },
    }),
    /Permission revoked/,
  )
})

for (const change of ["missing", "added", "revision", "history"] as const) {
  test(`export rejects ${change} observation metadata between pages`, async () => {
    const observation = { revision: "a".repeat(32), since: 1, before: "unknown", deleted: false }
    await rejects(
      exportEmbeddings({
        session: "chat",
        read: async (request) => {
          if (request.after == null)
            return {
              session: "chat",
              entries: [entry("one")],
              next: "10",
              ...(change === "added" ? {} : { observation }),
            }
          return {
            session: "chat",
            entries: [entry("two")],
            ...(change === "missing"
              ? {}
              : {
                  observation: {
                    ...observation,
                    ...(change === "revision" ? { revision: "b".repeat(32) } : {}),
                    ...(change === "history" ? { deleted: true } : {}),
                  },
                }),
          }
        },
      }),
      /changed during embedding usage export/,
    )
  })
}
