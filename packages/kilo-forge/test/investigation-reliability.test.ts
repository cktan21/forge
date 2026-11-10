import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { writeFile } from "node:fs/promises"
import { deadline } from "../src/deadline"
import { EnhancementError, failure } from "../src/enhancement"
import type { InvestigationProgress, Turn } from "../src/investigation"
import { conclusion, fixture, model, result } from "./investigation-fixture"

test("symbol inspection reuses a source version while retaining read continuation metadata", async () => {
  await using f = await fixture(async (input) => {
    if (!input.observations.length)
      return result(input, [{ id: "read", name: "forge_read_file", input: { path: "queue.ts", lines: 1 } }])
    if (input.observations.length === 1)
      return result(input, [{ id: "symbol", name: "forge_get_symbol", input: { id: input.sources.at(0)!.id } }])
    expect(input.observations.filter((item) => item.output.includes("const queue"))).toHaveLength(1)
    expect(JSON.parse(input.observations.at(0)!.output)).toMatchObject({ duplicateOf: "symbol", next: 2 })
    return result(input, [{ id: "done", name: "forge_finish", input: conclusion() }])
  })
  const record = await f.api.investigate({ key: randomUUID(), text: "Inspect queue", model })
  expect(record.journal?.at(-1)?.included).toEqual(["symbol"])
  expect(record.observations).toHaveLength(2)
})

test("mixed malformed conclusions and inspection arguments do not discard an independent read", async () => {
  await using f = await fixture(async (input) => {
    if (!input.observations.length)
      return result(input, [
        { id: "finish", name: "forge_finish", input: { unknowns: ["No source inspected yet."] } },
        { id: "bad", name: "forge_lookup", input: { path: 42, PRIVATE_KEY_CANARY: "PRIVATE_VALUE_CANARY" } },
        { id: "read", name: "forge_read_file", input: { path: "queue.ts" } },
      ])
    const source = input.sources.find((item) => item.uri === "queue.ts")
    if (!source) throw new Error("The independent read was not executed")
    expect(JSON.stringify(input.observations)).not.toContain("PRIVATE_")
    return result(input, [{ id: "done", name: "forge_finish", input: conclusion([source.id]) }])
  })
  const record = await f.api.investigate({ key: randomUUID(), text: "Inspect queue", model })
  expect(record.state).toBe("findings_ready")
  expect(record.findings).toHaveLength(1)
  expect(record.journal?.at(0)?.inspections.map((item) => item.state)).toEqual(["skipped", "skipped", "complete"])
  expect(record.observations.find((item) => item.id === "bad")?.sources).toEqual([])
  expect(record.observations.find((item) => item.id === "read")?.sources.at(0)?.uri).toBe("queue.ts")
  expect(f.calls).toHaveLength(2)
})

test("replayed evidence keeps the latest unchanged read only while preserving the tool journal", async () => {
  await using f = await fixture(async (input) => {
    if (input.observations.length < 3)
      return result(input, [
        {
          id: `read-${input.observations.length}`,
          name: "forge_read_file",
          input: { path: "queue.ts" },
        },
      ])
    const full = input.observations.filter((item) => item.output.includes("queue.push"))
    expect(full).toHaveLength(1)
    expect(full.at(0)?.id).toBe("read-2")
    expect(input.observations.at(0)?.output).toContain("read-2")
    return result(input, [{ id: "finish", name: "forge_finish", input: conclusion() }])
  })
  const record = await f.api.investigate({ key: randomUUID(), text: "Inspect queue", model })
  expect(record.observations).toHaveLength(3)
  expect(record.observations.every((item) => item.output.includes("queue.push"))).toBe(true)
  expect(record.journal?.at(-1)?.included).toEqual(["read-2"])
  expect(record.journal?.at(-1)?.omitted).toEqual(["read-0", "read-1"])
})

test("a broad search cannot evict previously inspected implementation from the next turn", async () => {
  await using f = await fixture(async (input) => {
    if (!input.observations.length)
      return result(input, [{ id: "read", name: "forge_read_file", input: { path: "queue.ts" } }])
    if (input.observations.length === 1)
      return result(input, [{ id: "search", name: "forge_search_code", input: { query: "queue" } }])
    expect(input.observations.find((item) => item.id === "read")?.output).toContain("queue.push")
    return result(input, [{ id: "finish", name: "forge_finish", input: conclusion() }])
  })
  await Promise.all(
    Array.from({ length: 30 }, (_, index) =>
      writeFile(`${f.root}/queue-${index}.ts`, `// queue ${"queue ".repeat(1000)}\nexport const queue${index} = []\n`),
    ),
  )
  const record = await f.api.investigate({ key: randomUUID(), text: "Inspect queue", model })
  expect(record.journal?.at(-1)?.included).toContain("read")
})

test("waiting emits lightweight progress without additional persistence writes", async () => {
  const entered = Promise.withResolvers<Turn>()
  const release = Promise.withResolvers<void>()
  const heartbeat = Promise.withResolvers<InvestigationProgress>()
  const controller = new AbortController()
  await using f = await fixture(async (input) => {
    entered.resolve(input)
    await release.promise
    return result(input, [{ id: "finish", name: "forge_finish", input: conclusion() }])
  })
  const key = randomUUID()
  const pending = f.api
    .investigate({
      key,
      text: "Inspect queue",
      model,
      signal: controller.signal,
      update: (frame) => {
        if (frame.elapsed != null && frame.elapsed >= 1000) heartbeat.resolve(frame)
      },
    })
    .catch((err: unknown) => err)
  await entered.promise
  const before = await f.storage.investigation(f.root, "", key)
  try {
    const frame = await deadline(() => heartbeat.promise, undefined, 3000)
    expect(frame.journal).toBeUndefined()
    expect(frame.observations).toBeUndefined()
    expect(frame.turns).toBe(0)
    expect(frame.started).toBe(1)
    expect((await f.storage.investigation(f.root, "", key))?.revision).toBe(before?.revision)
  } finally {
    controller.abort()
    release.resolve()
    await pending
  }
})

test("deadline cancellation preserves its cause and is not stored as a user cancellation", async () => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const controller = new AbortController()
  await using f = await fixture(async (input) => {
    entered.resolve()
    await release.promise
    return result(input, [])
  })
  const key = randomUUID()
  const pending = f.api
    .investigate({ key, text: "Inspect queue", model, signal: controller.signal })
    .catch((err: unknown) => err)
  await entered.promise
  controller.abort(new EnhancementError("Investigation deadline exceeded.", failure("timeout")))
  await pending
  release.resolve()
  await f.api.dispose()
  const record = await f.storage.investigation(f.root, "", key)
  expect(record?.state).toBe("failed")
  expect(record?.failure).toMatchObject({ code: "timeout", stage: "model" })
})

test("an unstructured preamble cannot be labeled a request for user clarification", async () => {
  await using f = await fixture(async (input) => ({ ...result(input, []), note: "I will inspect the backend now." }))
  const record = await f.api.investigate({ key: randomUUID(), text: "Inspect queue", model })
  expect(record.state).toBe("unstructured")
  expect(record.questions).toEqual([])
  expect(record.findings).toEqual([])
  expect(record.summary).toBe("I will inspect the backend now.")
  expect(f.calls).toHaveLength(1)
})

test.each([false, true])("explicit conclusion recovery checks whether evidence changed=%s", async (changed) => {
  await using f = await fixture(async (input) => {
    if (!input.observations.length)
      return result(input, [{ id: "read", name: "forge_read_file", input: { path: "queue.ts" } }])
    if (!input.final)
      return result(input, [{ id: "finish", name: "forge_finish", input: { ...conclusion(), unknowns: [] } }])
    const source = input.sources.find((item) => item.uri === "queue.ts")
    if (!source) throw new Error("Recovered evidence is unavailable")
    return result(input, [{ id: "done", name: "forge_finish", input: conclusion([source.id]) }])
  })
  const key = randomUUID()
  const error = await f.api.investigate({ key, text: "Inspect queue", model }).catch((err: unknown) => err)
  expect(error).toBeInstanceOf(EnhancementError)
  expect(error).toMatchObject({ message: expect.stringContaining("unknowns") })
  const record = await f.storage.investigation(f.root, "", key)
  expect(record?.failure).toMatchObject({ code: "schema", stage: "response" })
  expect(record?.observations).toHaveLength(1)
  if (!record) throw new Error("Failed investigation was not retained")
  if (changed) await writeFile(`${f.root}/queue.ts`, "export const queue = []\n")
  const pending = f.api.investigate({
    key: randomUUID(),
    text: record.original,
    model,
    resume: { id: record.id, revision: record.revision },
  })
  if (changed) {
    expect(await pending.catch((err: unknown) => err)).toBeInstanceOf(Error)
    expect(f.calls).toHaveLength(2)
    return
  }
  const recovered = await pending
  expect(recovered.state).toBe("findings_ready")
  expect(recovered.observations.at(0)?.id).toBe("read")
  expect(f.calls).toHaveLength(3)
  expect(f.calls.at(-1)?.final).toBe(true)
})
