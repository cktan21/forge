import { expect, test } from "bun:test"
import { deadline } from "../src/deadline"

test("expired scope releases the caller and aborts a non-cooperative task", async () => {
  const pending = Promise.withResolvers<number>()
  const started = Promise.withResolvers<AbortSignal>()
  const result = deadline((signal) => { started.resolve(signal); return pending.promise }, undefined, 20)
  const signal = await started.promise
  await expect(result).rejects.toThrow("Retrieval channel deadline exceeded")
  expect(signal.aborted).toBe(true)
  pending.resolve(42)
  await pending.promise
  await expect(result).rejects.toThrow("Retrieval channel deadline exceeded")
})

test("caller cancellation is preserved and already-aborted scopes do not start tasks", async () => {
  const controller = new AbortController()
  const reason = new Error("Developer cancelled")
  const started = Promise.withResolvers<AbortSignal>()
  const pending = Promise.withResolvers<number>()
  const result = deadline((signal) => { started.resolve(signal); return pending.promise }, controller.signal)
  const signal = await started.promise
  controller.abort(reason)
  await expect(result).rejects.toBe(reason)
  expect(signal.reason).toBe(reason)
  pending.reject(new Error("Late adapter failure"))
  await expect(pending.promise).rejects.toThrow("Late adapter failure")
  const calls: string[] = []
  await expect(deadline(async () => { calls.push("started"); return 1 }, controller.signal)).rejects.toBe(reason)
  expect(calls).toEqual([])
})

test("successful and failed scopes close their signal without cancelling the caller", async () => {
  const controller = new AbortController()
  const signals: AbortSignal[] = []
  expect(await deadline(async (signal) => { signals.push(signal); return 7 }, controller.signal)).toBe(7)
  await expect(deadline(async (signal) => { signals.push(signal); throw new Error("Failed task") }, controller.signal)).rejects.toThrow("Failed task")
  expect(signals.every((signal) => signal.aborted)).toBe(true)
  expect(controller.signal.aborted).toBe(false)
})
