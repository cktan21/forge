import { expect, test } from "bun:test"
import { setImmediate as immediate } from "node:timers/promises"
import { generation } from "../src/generation"
import { associations, relation, source } from "../src/parse"

test("cooperative generation preserves captured legacy hashes and ordering semantics", async () => {
  const sources = [
    source("queue.ts", "export const queue = 1\n", "code", { detail: { z: "last", a: "first" } }),
    source("notes.md", "# Queue\nNotes", "document"),
  ]
  const edges = [relation(sources.at(1)!.id, sources.at(0)!.id, "references", [sources.at(0)!.id])]
  expect(await generation(sources, edges, false)).toBe("06e6adc6fa5e5b16943091937753b040542fdf800056425419c5f466a49e6013")
  expect(await generation(sources, edges, true)).toBe("b32456eaf55020572f3d428360536383d57a5aa83abcf0a7dcd5eedbbfd06d75")
  expect(await generation([], [], false)).toBe("82cde6fe0ad92de5f9dbd456bb4b56926264806294100ba671ab29a94ecc47fe")
  expect(await generation(sources.toReversed().map((item) => ({ ...item, observed: 0, detail: Object.fromEntries(Object.entries(item.detail).reverse()) })), edges, false))
    .toBe(await generation(sources, edges, false))
  expect(await generation([{ ...sources.at(0)!, text: "changed" }], edges, false)).not.toBe(await generation(sources, edges, false))
})

test("large generation yields to timers and rejects cancellation without returning a version", async () => {
  const sources = Array.from({ length: 10_000 }, (_, index) => source(`${index}.ts`, "x".repeat(1000), "code"))
  const controller = new AbortController()
  const started = generation(sources, [], false, controller.signal)
  const failure = started.then(() => undefined, (err: unknown) => err)
  await immediate()
  controller.abort(new Error("stop generation"))
  expect(String(await failure)).toContain("stop generation")
  const aborted = await generation([], [], false, controller.signal).then(() => undefined, (err: unknown) => err)
  expect(String(aborted)).toContain("stop generation")
})

test("bounded document associations retain document-first and original code order", async () => {
  const docs = [source("a.md", "worker queue", "document"), source("b.md", "queue worker", "document")]
  const codes = Array.from({ length: 1500 }, (_, index) => source(`src/${index}/queue.ts`, "code", "code"))
  const edges = await associations([...docs, ...codes])
  expect(edges).toHaveLength(2000)
  expect(edges.at(0)?.from).toBe(docs.at(0)?.id)
  expect(edges.at(1499)?.to).toBe(codes.at(1499)?.id)
  expect(edges.at(1500)?.from).toBe(docs.at(1)?.id)
  expect(edges.at(-1)?.to).toBe(codes.at(499)?.id)
  const controller = new AbortController()
  controller.abort(new Error("stop associations"))
  expect(String(await associations([...docs, ...codes], controller.signal).then(() => undefined, (err: unknown) => err))).toContain("stop associations")
})
