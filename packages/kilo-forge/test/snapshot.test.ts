import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { pack, unpack } from "../src/snapshot"
import { source, relation } from "../src/parse"
import { store } from "../src/store"
import { gunzipSync } from "node:zlib"

const sources = Array.from({ length: 100 }, (_, index) => source(`${index}.ts`, `export const queue${index} = "${"evidence ".repeat(1800)}"`, "code"))
const snapshot = {
  root: "/compressed", generation: "first", revision: "revision", observed: 1,
  files: sources.length, partial: false, warnings: [], sources,
  relations: [relation(sources.at(0)!.id, sources.at(1)!.id, "imports", [sources.at(0)!.id])],
}

test("compressed snapshots preserve full evidence and accept legacy JSON", async () => {
  const text = await pack(snapshot)
  expect(JSON.parse(text).encoding).toBe("gzip-v1")
  expect(text.length).toBeLessThan(JSON.stringify(snapshot).length / 5)
  expect(await unpack(JSON.parse(text))).toEqual(snapshot)
  expect(await unpack(snapshot)).toEqual(snapshot)
  const small = { ...snapshot, sources: [], relations: [] }
  expect(await pack(small)).toBe(JSON.stringify(small))
})

test("compressed snapshots reject corruption, oversized output, and mismatched headers", async () => {
  const value = JSON.parse(await pack(snapshot))
  for (const broken of [
    { ...value, encoding: "unknown" }, { ...value, bytes: 513 * 1024 * 1024 },
    { ...value, bytes: value.bytes - 1 }, { ...value, bytes: value.bytes + 1 },
    { ...value, data: "broken" }, { ...value, generation: "different" }, { ...value, root: "/other" },
  ]) {
    const failure: unknown = await unpack(broken).then(() => undefined, (err: unknown) => err)
    expect(failure).toBeInstanceOf(Error)
  }
})

test("cooperative serialization preserves exact JSON across source and relationship chunk boundaries", async () => {
  const items = Array.from({ length: 1001 }, (_, index) => source(`${index}.ts`, `"\n\\\u00e9-${index}`, "code"))
  const ordered = { ...snapshot, sources: items, relations: [], warnings: ['"\n\\\u00e9'] }
  expect(await pack(ordered)).toBe(JSON.stringify(ordered))
  const large = {
    ...ordered,
    sources: items.map((item) => ({ ...item, text: `${item.text}${"evidence ".repeat(300)}` })),
    relations: items.map((item) => relation(item.id, items.at(0)!.id, "imports", [item.id])),
  }
  const packed = JSON.parse(await pack(large))
  expect(packed.encoding).toBe("gzip-v1")
  const text = gunzipSync(Buffer.from(packed.data, "base64")).toString("utf8")
  expect(text).toBe(JSON.stringify(large))
  expect(packed.bytes).toBe(Buffer.byteLength(text))
  expect(await unpack(packed)).toEqual(large)
})

test("compressed publication survives reopen and rollback without changing indexed reads", async () => {
  const db = new Database(":memory:")
  const sql = {
    all: async (query: import("../src/store").Query) => db.query<Record<string, unknown>, (string | number | null)[]>(query.text).all(...query.values ?? []),
    batch: async (queries: readonly import("../src/store").Query[]) => {
      db.transaction(() => { for (const query of queries) db.query(query.text).run(...query.values ?? []) })()
    },
  }
  try {
    const api = store(sql)
    await api.replace(snapshot)
    expect((await api.snapshot(snapshot.root))).toEqual(snapshot)
    const reopened = store(sql)
    await reopened.ready
    expect(await reopened.snapshot(snapshot.root)).toEqual(snapshot)
    expect((await reopened.view(snapshot.root, { focus: sources.at(0)!.id })).relations).toEqual(snapshot.relations)
    db.run("CREATE TRIGGER fail_snapshot BEFORE INSERT ON forge_records WHEN NEW.kind = 'snapshot' BEGIN SELECT RAISE(ABORT, 'rollback'); END")
    const failure: unknown = await reopened.replace({ ...snapshot, generation: "failed", sources: snapshot.sources.slice(1) }).then(() => undefined, (err: unknown) => err)
    expect(failure).toBeInstanceOf(Error)
    expect(await reopened.snapshot(snapshot.root)).toEqual(snapshot)
    expect((await reopened.inventory(snapshot.root)).generation).toBe("first")
    db.run("DELETE FROM forge_records WHERE kind = 'inventory'")
    expect(await reopened.inventory(snapshot.root)).toMatchObject({
      generation: snapshot.generation, revision: snapshot.revision, observed: snapshot.observed,
      files: snapshot.files, partial: snapshot.partial, indexed: true, counts: { code: sources.length },
    })
    await reopened.save(snapshot.root, {
      id: "manual", kind: "text", label: "Manual", location: "manual", origin: "interface",
      session: "", include: [], exclude: [], watch: false, approved: true, providers: [],
      state: "ready", observed: 1, generation: "first", files: 0, chunks: 0, warnings: [],
    })
    await reopened.purge(snapshot.root, "manual")
    const purged = store(sql)
    await purged.ready
    expect(await purged.snapshot(snapshot.root)).toBeUndefined()
    expect((await purged.view(snapshot.root)).relations).toEqual([])
    expect((await purged.inventory(snapshot.root)).indexed).toBe(false)
  } finally {
    db.close()
  }
})
