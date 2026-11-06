import { expect, test } from "bun:test"
import { reconcile } from "../src/model-accounting"
import { usage, type Attempt, type Manifest } from "../src/schema"

const attempt: Attempt = {
  id: "attempt",
  sequence: 1,
  started: 10,
  finished: 11,
  state: "response",
  status: 200,
  sent: [],
  membership: "unknown",
  response: {
    state: "completed",
    bytes: 120,
    usage: { format: "openai-chat", input: 10, output: 2, total: 12, cached: 3 },
  },
}
const record: Manifest = {
  id: "request",
  root: "/fixture",
  session: "chat",
  purpose: "enhance",
  model: "local",
  observed: 10,
  generation: "fixture",
  entries: [],
  coverage: [],
  state: "completed",
  attempts: [attempt],
  discarded: 0,
  usage: { ...usage("local"), input: 10, output: 2, cached: 3, measured: true },
}

test("response reports replace overlapping final-call usage instead of being added twice", () => {
  const result = reconcile(record)
  expect(result.usage).toEqual(record.usage)
  expect(result).toMatchObject({ complete: true, priced: true, attempts: 1, reports: 1, unknown: 0, discarded: 0 })
  const retried = reconcile({ ...record, attempts: [attempt, { ...attempt, id: "retry", sequence: 2 }] })
  expect(retried.usage).toMatchObject({ input: 20, output: 4, cached: 6 })
  expect(retried.complete).toBe(true)
})

test("failed, unconsumed, unsupported and unreported attempts block completeness", () => {
  for (const changed of [
    { state: "pending" as const, response: undefined },
    { state: "error" as const, response: undefined },
    { status: 503 },
    { response: { state: "pending" as const, bytes: 0 } },
    { response: { ...attempt.response!, state: "cancelled" as const } },
    { response: { ...attempt.response!, state: "error" as const } },
    { response: { ...attempt.response!, state: "limited" as const } },
    { response: { state: "unsupported" as const, bytes: 120 } },
    { response: { state: "completed" as const, bytes: 120 } },
    { response: { ...attempt.response!, usage: { ...attempt.response!.usage!, invalid: true } } },
    { response: { ...attempt.response!, usage: { format: "openai-chat" as const, input: 10 } } },
  ]) {
    const result = reconcile({ ...record, attempts: [attempt, { ...attempt, ...changed, id: "retry", sequence: 2 }] })
    expect(result.complete).toBe(false)
    expect(result.unknown).toBe(1)
    expect(result.usage.input).toBeGreaterThanOrEqual(10)
    expect(result.usage.output).toBeGreaterThanOrEqual(2)
  }
})

test("missing, discarded, duplicate, gapped and nonterminal captures cannot prove coverage", () => {
  for (const changed of [
    { attempts: undefined },
    { attempts: [] },
    { discarded: undefined },
    { discarded: 1 },
    { attempts: [attempt, { ...attempt, sequence: 2 }] },
    { attempts: [{ ...attempt, sequence: 2 }] },
    { state: "sent" as const },
  ]) {
    const result = reconcile({ ...record, ...changed })
    expect(result.complete).toBe(false)
    expect(result.usage.input).toBeGreaterThanOrEqual(10)
  }
})

test("explicit zeros are reports, missing cache breakdown affects price but not token coverage", () => {
  const zero = {
    ...attempt,
    response: {
      state: "completed" as const,
      bytes: 120,
      usage: { format: "openai-chat" as const, input: 0, output: 0, total: 0, cached: 0 },
    },
  }
  expect(reconcile({ ...record, attempts: [zero], usage: usage("local") })).toMatchObject({
    complete: true,
    priced: true,
    usage: { input: 0, output: 0, cached: 0, measured: true },
  })
  expect(
    reconcile({
      ...record,
      attempts: [
        { ...attempt, response: { ...attempt.response!, usage: { format: "openai-chat", input: 10, output: 2 } } },
      ],
    }),
  ).toMatchObject({
    complete: true,
    priced: false,
  })
})

test("blocked-before-fetch attempts are zero transport, not fabricated provider usage", () => {
  const blocked = { ...attempt, state: "blocked" as const, status: undefined, response: undefined }
  expect(reconcile({ ...record, attempts: [blocked], usage: usage("local"), state: "failed" })).toMatchObject({
    complete: true,
    priced: true,
    reports: 0,
    unknown: 0,
    usage: { input: 0, output: 0, measured: false },
  })
})

test("contradictory final adapter usage retains a lower bound but blocks completeness", () => {
  const result = reconcile({ ...record, usage: { ...record.usage, input: 100 } })
  expect(result.complete).toBe(false)
  expect(result.usage).toMatchObject({ input: 100, output: 2 })
  const crossed = reconcile({ ...record, usage: { ...record.usage, input: 8, output: 3 } })
  expect(crossed.complete).toBe(false)
  expect(crossed.usage).toMatchObject({ input: 10, output: 2 })
})

test("unsafe sums never turn into a known operation total", () => {
  const huge = {
    ...attempt,
    response: {
      ...attempt.response!,
      usage: { format: "openai-chat" as const, input: Number.MAX_SAFE_INTEGER, output: 0 },
    },
  }
  const result = reconcile({ ...record, attempts: [huge, { ...huge, id: "retry", sequence: 2 }] })
  expect(result.complete).toBe(false)
  expect(result.usage).toEqual(record.usage)
})
