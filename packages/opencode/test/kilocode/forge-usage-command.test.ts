import { expect, test } from "bun:test"
import { rejects } from "node:assert/strict"
import { mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { collect, maintain, save } from "../../src/kilocode/cli/cmd/forge-usage"
import { account } from "@kilocode/forge/embedding-usage"

test("CLI collector uses authenticated read-only SDK pages and reports bounded coverage", async () => {
  const password = process.env.KILO_SERVER_PASSWORD
  const username = process.env.KILO_SERVER_USERNAME
  process.env.KILO_SERVER_PASSWORD = "export-local-secret"
  process.env.KILO_SERVER_USERNAME = "export-user"
  const requests: Request[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      requests.push(request)
      const url = new URL(request.url)
      expect(request.method).toBe("GET")
      expect(url.pathname).toBe("/forge/embeddings/usage")
      expect(url.searchParams.get("session")).toBe("session")
      expect(url.searchParams.get("directory")).toBe("/workspace with spaces")
      expect(request.headers.get("authorization")).toBe(
        `Basic ${Buffer.from("export-user:export-local-secret").toString("base64")}`,
      )
      return Response.json({
        session: "session",
        observation: { revision: "a".repeat(32), since: 1, before: "unknown", deleted: false },
        entries: [
          {
            id: url.searchParams.get("after") ?? "first",
            session: "session",
            collections: ["collection"],
            target: { fingerprint: "target", model: "fixture", dimensions: 2 },
            purpose: "query",
            started: 1,
            usage: account(undefined, { state: "attempt", inputs: 1, bytes: 50 }),
          },
        ],
        ...(url.searchParams.has("after") ? {} : { next: "10" }),
      })
    },
  })
  try {
    const value = await collect({
      url: server.url.origin,
      directory: "/workspace with spaces",
      session: "session",
      max: 1,
    })
    expect(value).toMatchObject({ traversal: "limited", next: "10", cost: null, directory: "/workspace with spaces" })
    expect(value.groups.at(0)!.unknown).toEqual({ prompt: 1, total: 1 })
    expect(value.consistency).toBe("revision-checked")
    expect(value.observation).toEqual({ revision: "a".repeat(32), since: 1, before: "unknown", deleted: false })
    expect(JSON.stringify(value)).not.toContain("export-local-secret")
    const next = await collect({
      url: server.url.origin,
      directory: "/workspace with spaces",
      session: "session",
      after: value.next,
    })
    expect(next.traversal).toBe("exhausted")
    expect(requests).toHaveLength(2)
  } finally {
    await server.stop(true)
    if (password == null) delete process.env.KILO_SERVER_PASSWORD
    else process.env.KILO_SERVER_PASSWORD = password
    if (username == null) delete process.env.KILO_SERVER_USERNAME
    else process.env.KILO_SERVER_USERNAME = username
  }
})

test("CLI rejects redirects and non-success responses without exporting a page", async () => {
  let redirected = 0
  let status = 302
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      if (new URL(request.url).pathname === "/other") redirected++
      return new Response("not usage", { status, headers: { location: "/other" } })
    },
  })
  try {
    await rejects(collect({ url: server.url.origin, directory: "/workspace", session: "" }))
    expect(redirected).toBe(0)
    status = 403
    await rejects(collect({ url: server.url.origin, directory: "/workspace", session: "" }), /HTTP 403/)
  } finally {
    await server.stop(true)
  }
})

test("CLI cancels held reads and validates destinations before networking", async () => {
  const entered = Promise.withResolvers<void>()
  const released = Promise.withResolvers<void>()
  let calls = 0
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async () => {
      calls++
      entered.resolve()
      await released.promise
      return Response.json({ session: "", entries: [] })
    },
  })
  try {
    for (const url of [
      "file:///tmp/data",
      "http://example.com",
      "http://user:secret@127.0.0.1",
      `${server.url}?key=secret`,
      `${server.url}path`,
      "invalid secret",
    ])
      await rejects(collect({ url, directory: "/workspace", session: "" }))
    for (const timeout of [0, 301, 1.5])
      await rejects(collect({ url: server.url.origin, directory: "/workspace", session: "", timeout }))
    expect(calls).toBe(0)
    const controller = new AbortController()
    const pending = collect({ url: server.url.origin, directory: "/workspace", session: "" }, controller.signal)
    const rejected = rejects(pending)
    await entered.promise
    controller.abort(new Error("cancel test"))
    await rejected
    expect(calls).toBe(1)
  } finally {
    released.resolve()
    await server.stop(true)
  }
})

test("export publication is owner-only, atomic and never overwrites a file or symlink", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-export-"))
  const path = join(root, "usage.json")
  try {
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, index) => save(path, JSON.stringify({ index }))),
    )
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    const original = await readFile(path, "utf8")
    expect(JSON.parse(original).index).toBeNumber()
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    await rejects(save(path, "overwritten"))
    expect(await readFile(path, "utf8")).toBe(original)
    await symlink(path, join(root, "linked"))
    await rejects(save(join(root, "linked"), "overwritten"))
    expect(await readFile(path, "utf8")).toBe(original)
    const controller = new AbortController()
    controller.abort()
    await rejects(save(join(root, "cancelled"), "partial", controller.signal))
    await writeFile(join(root, "directory"), "not a directory")
    await rejects(save(join(root, "directory", "usage.json"), "partial"))
    expect((await readdir(root)).sort()).toEqual(["directory", "linked", "usage.json"])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("CLI read deadline interrupts a stalled backend", async () => {
  const released = Promise.withResolvers<void>()
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async () => {
      await released.promise
      return Response.json({ session: "", entries: [] })
    },
  })
  try {
    await rejects(collect({ url: server.url.origin, directory: "/workspace", session: "", timeout: 1 }))
  } finally {
    released.resolve()
    await server.stop(true)
  }
})

test("CLI retention requires explicit preview identity and DELETE confirmation without implicit pruning", async () => {
  const calls: { route: string; body: unknown }[] = []
  const revision = "a".repeat(64)
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      expect(request.method).toBe("POST")
      expect(url.searchParams.get("directory")).toBe("/workspace")
      calls.push({ route: url.pathname, body: await request.json() })
      return Response.json(
        url.pathname.endsWith("/prune")
          ? { deleted: 1, more: false }
          : {
              session: "chat",
              before: 100,
              keep: 10,
              selected: 1,
              limit: 100,
              more: false,
              revision,
              observation: { revision: "b".repeat(32), since: 1, before: "unknown", deleted: false },
            },
      )
    },
  })
  try {
    const args = { url: server.url.origin, directory: "/workspace", session: "chat", before: 100, keep: 10 }
    for (const invalid of [
      { ...args, before: undefined },
      { ...args, keep: undefined },
      { ...args, before: -1 },
      { ...args, keep: 1_000_001 },
      { ...args, revision },
      { ...args, confirm: "DELETE" },
    ])
      await rejects(maintain(invalid))
    expect(calls).toEqual([])
    const preview = await maintain(args)
    expect(preview).toMatchObject({ selected: 1, revision })
    expect(calls).toEqual([{ route: "/forge/embeddings/retention", body: { session: "chat", before: 100, keep: 10 } }])
    expect(await maintain({ ...args, revision, confirm: "DELETE" })).toEqual({
      directory: "/workspace",
      session: "chat",
      deleted: 1,
      more: false,
    })
    expect(calls.at(1)).toEqual({
      route: "/forge/embeddings/prune",
      body: { session: "chat", before: 100, keep: 10, revision, confirmation: "DELETE" },
    })
  } finally {
    await server.stop(true)
  }
})
