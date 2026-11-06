import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { engine } from "../src/engine"
import { store } from "../src/store"

test("workspace aliases keep repository and registered knowledge in one storage scope", async () => {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "forge-alias-")))
  const physical = path.join(home, "physical")
  const root = path.join(home, "alias")
  await mkdir(physical)
  await symlink(physical, root)
  const db = new Database(":memory:")
  const storage = store({
    all: async (query) => db.query<Record<string, unknown>, (string | number | null)[]>(query.text).all(...query.values ?? []),
    batch: async (queries) => { db.transaction(() => { for (const query of queries) db.query(query.text).run(...query.values ?? []) })() },
  })
  const api = engine({ root, store: storage, provider: async () => "local", complete: async () => { throw new Error("No model calls") } })
  try {
    await Bun.write(path.join(physical, "code.ts"), "export const amber = true")
    await Bun.write(path.join(physical, "manuals", "guide.md"), "Verify amber calibration before release.")
    const collection = await api.register({ kind: "folder", label: "Manual", location: "./manuals", watch: false })
    await api.approve(collection.id, "", ["local"])
    await api.index(collection.id)
    const result = await api.retrieve("amber calibration")
    expect(result.matches.some((item) => item.source.method === "collection-section")).toBe(true)
    expect(result.matches.some((item) => item.source.method === "file" && item.source.uri === "manuals/guide.md")).toBe(false)
    expect((await storage.snapshot(root))?.root).toBe(root)
    expect((await api.status()).inventory.indexed).toBe(true)
    await api.approve(collection.id, "", [])
    const denied = await api.retrieve("amber calibration")
    expect(denied.matches.some((item) => item.source.text.includes("Verify amber"))).toBe(false)
  } finally {
    await api.dispose()
    db.close()
    await rm(home, { recursive: true, force: true })
  }
})
