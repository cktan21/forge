import { afterAll, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { store } from "@kilocode/forge/store"
import { knowledge } from "@kilocode/forge/knowledge"
import { register, start } from "../../src/kilocode/forge/trace"
import { tmpdir } from "../fixture/fixture"

const records: unknown[] = []
afterAll(async () => {
  const output = process.env.FORGE_WORKFLOW_HOST_ARTIFACT
  if (output) await Bun.write(output, JSON.stringify({ records }, null, 2))
})

// Supplemental transport boundaries, not substitutes for launcher/UI transition cells.
test.each(["destination", "sharing", "policy"] as const)("in-flight authorization rejects changed %s before local transport", async (change) => {
  await using tmp = await tmpdir()
  const db = new Database(`${tmp.path}/workflow.sqlite`)
  const storage = store({
    all: async (query) => db.query<Record<string, unknown>, (string | number | null)[]>(query.text).all(...query.values ?? []),
    batch: async (queries) => { db.transaction(() => { for (const query of queries) db.query(query.text).run(...query.values ?? []) })() },
  })
  const calls: string[] = []
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    calls.push(await request.text())
    return Response.json({ result: "Local fixed response" })
  } })
  const route = { fingerprint: "before", origins: [server.url.origin] }
  const destination = async () => ({ ...route })
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let held = false
  const authorize = async () => {
    if (!held) return
    entered.resolve()
    await release.promise
  }
  const library = knowledge(tmp.path, storage, { destination })
  const off = register(tmp.path, storage, authorize, destination)
  try {
    const collection = await library.register({ kind: "text", label: "Private session document", location: "", session: "old", content: "TASK25_PRIVATE: epoch lease must remain private to the approved session." })
    await library.approve(collection.id, "old", ["probe"], { probe: route.fingerprint })
    await library.index(collection.id, "old")
    const source = (await storage.knowledge(tmp.path, "old", "probe")).find((item) => item.method === "collection-section")!
    expect(source).toBeDefined()
    const input = { root: tmp.path, session: "old", model: "probe/test", purpose: "coding", system: [], messages: [`[${source.id}]\n${source.text}`] }
    const control = (await start(input))!
    expect((await control.fetch(fetch)(server.url, { method: "POST", body: JSON.stringify(input.messages) })).ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls.at(0)).toContain(source.text)
    const trace = (await start(input))!
    held = true
    const pending = trace.fetch(fetch)(server.url, { method: "POST", body: JSON.stringify(input.messages) }).then(() => undefined, (err: unknown) => err)
    try {
      await entered.promise
      if (change === "destination") route.fingerprint = "after"
      if (change === "sharing") await library.approve(collection.id, "old", [], {})
      if (change === "policy") {
        const policy = await storage.policy(tmp.path, "old")
        await storage.policySave(tmp.path, { ...policy, version: "after", exclude: [source.id] })
      }
      release.resolve()
      expect(await pending).toBeInstanceOf(Error)
      expect(calls).toHaveLength(1)
      const capture = (await storage.request(tmp.path, "old", trace.id))!
      expect(capture.state).toBe("failed")
      expect(capture.attempts).toHaveLength(1)
      expect(capture.attempts?.at(0)?.sent).toEqual([])
      expect(capture.entries.every((item) => item.stage === "assembled")).toBe(true)
      expect(await storage.request(tmp.path, "new", trace.id)).toBeUndefined()
      expect(await storage.request(`${tmp.path}/other-worktree`, "old", trace.id)).toBeUndefined()
      records.push({ change, capture, calls })
      console.error(`FORGE_WORKFLOW_HOST ${JSON.stringify(records.at(-1))}`)
    } finally { release.resolve(); await pending }
  } finally {
    release.resolve()
    off()
    await library.dispose()
    await server.stop(true)
    db.close()
  }
}, 30_000)
