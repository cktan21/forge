import { expect, test } from "bun:test"
import { getEventListeners } from "node:events"
import { wait } from "../../../src/indexing/search-wait"

test("cancelled admission never starts work, including cancellation before its microtask", async () => {
  for (const early of [false, true]) {
    const controller = new AbortController()
    let calls = 0
    if (early) controller.abort("closed")
    const pending = wait(async () => ++calls, controller.signal).then(
      (value) => value,
      (err: unknown) => err,
    )
    if (!early) controller.abort("closed")
    expect(await pending).toBe("closed")
    expect(calls).toBe(0)
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)
  }
})

test.each(["resolve", "reject"] as const)(
  "cancelled work observes late %s without leaving a listener",
  async (ending) => {
    const controller = new AbortController()
    const entered = Promise.withResolvers<void>()
    const work = Promise.withResolvers<number>()
    const reason = new Error("cancelled")
    const pending = wait(() => {
      entered.resolve()
      return work.promise
    }, controller.signal).then(
      (value) => value,
      (err: unknown) => err,
    )
    await entered.promise
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(1)
    controller.abort(reason)
    expect(await pending).toBe(reason)
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)
    if (ending === "resolve") work.resolve(1)
    if (ending === "reject") work.reject(new Error("late transport error"))
    await work.promise.catch(() => undefined)
    expect(await pending).toBe(reason)
  },
)

test("successful and failed work detach their abort listeners", async () => {
  const controller = new AbortController()
  expect(await wait(async () => 1, controller.signal)).toBe(1)
  expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)
  const reason = new Error("synchronous failure")
  const rejected = await wait(() => {
    throw reason
  }, controller.signal).catch((err: unknown) => err)
  expect(rejected).toBe(reason)
  expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)
  controller.abort()
})

test("uncancelled callers retain ordinary resolution and rejection", async () => {
  expect(await wait(async () => 7)).toBe(7)
  const reason = new Error("ordinary failure")
  expect(await wait(() => Promise.reject(reason)).catch((err: unknown) => err)).toBe(reason)
})
