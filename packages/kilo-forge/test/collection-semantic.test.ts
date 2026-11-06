import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { rejects } from "node:assert/strict"
import { Schema } from "effect"
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { collectionSemantic } from "../src/collection-semantic"
import { knowledge } from "../src/knowledge"
import { store } from "../src/store"
import { decode, EmbeddingCoverage } from "../src/schema"
import { embeddingConsent } from "../src/embedding-consent"
import { engine, type Ports } from "../src/engine"
import { usage } from "../src/schema"
import { embeddingHttp } from "../src/embedding-http"

async function connect(fixture: Awaited<ReturnType<typeof setup>>, ports: Partial<Ports> = {}) {
  await mkdir(path.join(fixture.root, ".kilo"), { recursive: true })
  await Bun.write(
    path.join(fixture.root, ".kilo/forge.jsonc"),
    JSON.stringify({
      exclude: ["docs/**", ".kilo/**", "*.sqlite*"],
      candidates: 1,
      budget: 2000,
    }),
  )
  return engine({
    root: fixture.root,
    store: fixture.storage,
    provider: async () => "coding",
    collectionSemantic: (input) => fixture.secured.retrieve(input),
    complete: async () => {
      throw new Error("Lookup must not call a coding model")
    },
    ...ports,
  })
}

async function approve(fixture: Awaited<ReturnType<typeof setup>>, session = "") {
  fixture.state.allowed = true
  await fixture.consent.approve(
    fixture.collection.id,
    (await fixture.consent.review(fixture.collection.id, session)).revision,
    session,
  )
  await fixture.secured.index(fixture.collection.id, { session })
}

async function setup(session = "") {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "forge-collection-vectors-")))
  await mkdir(path.join(root, "docs"))
  await Bun.write(
    path.join(root, "docs/lease.md"),
    "# Lease\n\nRelease ownership only after the signed receipt arrives.",
  )
  await Bun.write(path.join(root, "docs/audit.md"), "# Audit\n\nRetain the immutable dispatch journal for inspection.")
  const state = {
    db: new Database(path.join(root, "catalog.sqlite")),
    allowed: false,
    sends: [] as string[][],
    response: undefined as ((texts: string[]) => Promise<number[][]>) | undefined,
    permission: undefined as (() => Promise<void>) | undefined,
  }
  const storage = store({
    all: async (query) =>
      state.db.query<Record<string, unknown>, (string | number | null)[]>(query.text).all(...(query.values ?? [])),
    batch: async (queries) => {
      state.db.transaction(() => {
        for (const query of queries) state.db.query(query.text).run(...(query.values ?? []))
      })()
    },
  })
  const library = knowledge(root, storage)
  const collection = await library.register({
    kind: "folder",
    label: "Operations",
    location: path.join(root, "docs"),
    session,
  })
  await library.approve(collection.id, session, ["coding"])
  await library.index(collection.id, session)
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const payload = decode(
        Schema.Struct({
          input: Schema.Array(Schema.String),
          model: Schema.Literal("fixture-v1"),
          dimensions: Schema.Literal(2),
          encoding_format: Schema.Literal("float"),
        }),
        await request.json(),
      )
      const texts = [...payload.input]
      state.sends.push(texts)
      // Deliberately deterministic transport fixture, not a semantic model.
      const vectors = state.response
        ? await state.response(texts)
        : texts.map((text) => (text.includes("Lease") || text === "retire locks" ? [1, 0] : [0, 1]))
      return Response.json({ data: vectors.map((embedding, index) => ({ embedding, index })) })
    },
  })
  const transport = embeddingHttp({ endpoint: `${server.url}v1/embeddings`, model: "fixture-v1", dimensions: 2 })
  const options = {
    root,
    store: storage,
    library,
    target: { ...transport.target },
    authorize: async () => {
      await state.permission?.()
      if (!state.allowed) throw new Error("Embedding destination has not been approved")
    },
    embed: (texts: string[], signal?: AbortSignal) => transport.embed(texts, signal),
  }
  const consent = embeddingConsent({
    root,
    store: storage,
    target: async () => options.target,
    authorize: async (_collection, _session, target) => {
      if (!state.allowed) throw new Error("Local permission denied")
      if (target) await state.permission?.()
    },
  })
  return {
    root,
    state,
    storage,
    library,
    collection,
    options,
    endpoint: transport.endpoint,
    consent,
    secured: collectionSemantic({ ...options, authorize: (input, signal) => consent.authorize(input, signal) }),
    adapter: collectionSemantic(options),
    async close() {
      await server.stop(true)
      await library.dispose()
      state.db.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}

test("coverage inspects missing, reusable, stale and outdated originals without embedding or writing", async () => {
  const fixture = await setup()
  try {
    fixture.state.allowed = true
    await rejects(fixture.secured.coverage(fixture.collection.id), /has not been approved/)
    await fixture.consent.approve(fixture.collection.id, (await fixture.consent.review(fixture.collection.id)).revision)
    const before = fixture.state.db.query("SELECT * FROM forge_records ORDER BY kind,id").all()
    const missing = decode(EmbeddingCoverage, await fixture.secured.coverage(fixture.collection.id))
    expect(missing).toMatchObject({
      collection: fixture.collection.id,
      session: "",
      target: fixture.options.target,
      sections: 2,
      reusable: 0,
      missing: 2,
      outdated: 0,
      stale: 0,
      excluded: 0,
    })
    expect(missing.finished).toBeGreaterThanOrEqual(missing.started)
    expect(fixture.state.db.query("SELECT * FROM forge_records ORDER BY kind,id").all()).toEqual(before)
    expect(fixture.state.sends).toEqual([])
    await fixture.secured.index(fixture.collection.id)
    expect(await fixture.secured.coverage(fixture.collection.id)).toMatchObject({ reusable: 2, missing: 0, stale: 0 })
    await Bun.write(path.join(fixture.root, "docs/lease.md"), "# Lease\n\nRequire two signed receipts.")
    expect(await fixture.secured.coverage(fixture.collection.id)).toMatchObject({ reusable: 1, outdated: 0, stale: 1 })
    await fixture.library.index(fixture.collection.id)
    expect(await fixture.secured.coverage(fixture.collection.id)).toMatchObject({
      sections: 2,
      reusable: 1,
      missing: 0,
      outdated: 1,
      stale: 0,
      excluded: 0,
    })
    await rm(path.join(fixture.root, "docs/audit.md"))
    expect(await fixture.secured.coverage(fixture.collection.id)).toMatchObject({ reusable: 0, outdated: 1, stale: 1 })
    expect(fixture.state.sends).toHaveLength(1)
    await fixture.consent.revoke(fixture.collection.id)
    await rejects(fixture.secured.coverage(fixture.collection.id), /has not been approved/)
  } finally {
    await fixture.close()
  }
})

test("coverage partitions workspace and session exclusions before original reads", async () => {
  const fixture = await setup("private")
  try {
    await approve(fixture, "private")
    const sections = (await fixture.storage.knowledge(fixture.root, "private")).filter(
      (source) => source.method === "collection-section",
    )
    await fixture.storage.policySave(fixture.root, {
      session: "",
      version: "global",
      pin: [],
      exclude: [sections.at(0)!.id],
    })
    await fixture.storage.policySave(fixture.root, {
      session: "private",
      version: "local",
      pin: [],
      exclude: [sections.at(1)!.id],
    })
    await rm(path.join(fixture.root, "docs"), { recursive: true })
    expect(await fixture.secured.coverage(fixture.collection.id, { session: "private" })).toMatchObject({
      session: "private",
      sections: 2,
      reusable: 0,
      missing: 0,
      outdated: 0,
      stale: 0,
      excluded: 2,
    })
    await rejects(fixture.secured.coverage(fixture.collection.id, { session: "other" }), /session/)
    expect(fixture.state.sends).toHaveLength(1)
  } finally {
    await fixture.close()
  }
})

test("coverage rejects live denials, changed destinations and malformed vector caches", async () => {
  const fixture = await setup()
  try {
    await approve(fixture)
    fixture.state.allowed = false
    await rejects(fixture.secured.coverage(fixture.collection.id), /permission denied/)
    fixture.state.allowed = true
    fixture.options.target.model = "other"
    await rejects(fixture.secured.coverage(fixture.collection.id), /destination changed/)
    fixture.options.target.model = "fixture-v1"
    await fixture.storage.cache(
      fixture.root,
      `collection-vectors:${fixture.secured.identity}:${fixture.collection.id}`,
      {
        version: "forge-collection-vectors-v1",
        rows: [{ id: "invalid", revision: "invalid", vector: [0, 0] }],
      },
    )
    await rejects(fixture.secured.coverage(fixture.collection.id), /zero magnitude/)
    expect(fixture.state.sends).toHaveLength(1)
  } finally {
    await fixture.close()
  }
})

for (const mutation of ["policy", "grant", "file", "records", "cache"] as const) {
  test(`coverage rejects ${mutation} changes during its validation interval`, async () => {
    const fixture = await setup()
    try {
      await approve(fixture)
      let checks = 0
      fixture.state.permission = async () => {
        if (++checks !== 2) return
        if (mutation === "policy")
          await fixture.storage.policySave(fixture.root, {
            session: "",
            version: "changed",
            pin: [],
            exclude: ["other"],
          })
        if (mutation === "grant") await fixture.consent.revoke(fixture.collection.id)
        if (mutation === "file") await Bun.write(path.join(fixture.root, "docs/lease.md"), "Changed original")
        if (mutation === "records") {
          fixture.state.db
            .query(
              "UPDATE forge_sources SET body = json_set(body, '$.observed', 1) WHERE json_extract(body, '$.method') = 'collection-section'",
            )
            .run()
        }
        if (mutation === "cache")
          await fixture.storage.cache(
            fixture.root,
            `collection-vectors:${fixture.secured.identity}:${fixture.collection.id}`,
            {
              version: "forge-collection-vectors-v1",
              rows: [],
            },
          )
      }
      await rejects(fixture.secured.coverage(fixture.collection.id), /changed|approved/)
      expect(fixture.state.sends).toHaveLength(1)
    } finally {
      await fixture.close()
    }
  })
}

test("coverage cancellation releases a noncooperative permission check without writes or sends", async () => {
  const fixture = await setup()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  try {
    await approve(fixture)
    fixture.state.permission = async () => {
      entered.resolve()
      await release.promise
    }
    const controller = new AbortController()
    const pending = fixture.secured.coverage(fixture.collection.id, { signal: controller.signal })
    const outcome = rejects(pending, /Stopped/)
    await entered.promise
    controller.abort(new Error("Stopped"))
    await outcome
    await rejects(fixture.secured.coverage(fixture.collection.id, { signal: controller.signal }), /Stopped/)
    fixture.state.permission = undefined
    expect(await fixture.secured.coverage(fixture.collection.id)).toMatchObject({ reusable: 2 })
    expect(fixture.state.sends).toHaveLength(1)
  } finally {
    release.resolve()
    await fixture.close()
  }
})

test("coverage marks stored stale and unavailable sections without counting them as missing vectors", async () => {
  const fixture = await setup()
  try {
    await approve(fixture)
    const sections = (await fixture.storage.knowledge(fixture.root)).filter(
      (source) => source.method === "collection-section",
    )
    for (const [index, status] of ["stale", "unavailable"].entries()) {
      fixture.state.db
        .query("UPDATE forge_sources SET body = json_set(body, '$.status', ?) WHERE id = ?")
        .run(status, sections.at(index)!.id)
    }
    expect(await fixture.secured.coverage(fixture.collection.id)).toMatchObject({
      sections: 2,
      reusable: 0,
      missing: 0,
      outdated: 0,
      stale: 2,
      excluded: 0,
    })
    expect(fixture.state.sends).toHaveLength(1)
  } finally {
    await fixture.close()
  }
})

test("engine owns pending coverage reads and disposal releases blocked configuration", async () => {
  const fixture = await setup()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const api = await connect(fixture, {
    collectionSemantic: undefined,
    embeddings: {
      configuration: async () => {
        entered.resolve()
        await release.promise
        return { endpoint: fixture.endpoint, model: "fixture-v1", dimensions: 2 }
      },
      authorize: async () => {},
    },
  })
  try {
    const pending = rejects(api.embeddings!.coverage(fixture.collection.id), /closed|disposed/i)
    await entered.promise
    await api.dispose()
    await pending
    await rejects(api.embeddings!.coverage(fixture.collection.id), /closed/i)
    expect(fixture.state.sends).toEqual([])
  } finally {
    release.resolve()
    await api.dispose()
    await fixture.close()
  }
})

test("collection semantic indexing requires a separate grant and returns stored original citations", async () => {
  const fixture = await setup()
  try {
    expect(fixture.state.sends).toEqual([])
    await rejects(fixture.adapter.index(fixture.collection.id), /has not been approved/)
    expect(fixture.state.sends).toEqual([])
    fixture.state.allowed = true
    expect(await fixture.adapter.index(fixture.collection.id)).toEqual({ sections: 2, embedded: 2, reused: 0 })
    const result = await fixture.adapter.search("retire locks", [fixture.collection.id], { limit: 1 })
    expect(result).toHaveLength(1)
    expect(result.at(0)?.source.detail.document).toBe("lease.md")
    expect(result.at(0)?.source).toEqual(await fixture.storage.source(fixture.root, result.at(0)!.source.id))
    expect(result.at(0)?.source.text).toContain("signed receipt")
    expect(result.at(0)?.score).toBe(1)
    expect(fixture.state.sends).toHaveLength(2)
    fixture.state.allowed = false
    await rejects(fixture.adapter.search("retire locks", [fixture.collection.id]), /has not been approved/)
    expect(fixture.state.sends).toHaveLength(2)
  } finally {
    await fixture.close()
  }
})

test("collection vectors survive database reopen and unchanged refresh without re-embedding", async () => {
  const fixture = await setup()
  try {
    fixture.state.allowed = true
    await fixture.adapter.index(fixture.collection.id)
    fixture.state.db.close()
    fixture.state.db = new Database(path.join(fixture.root, "catalog.sqlite"))
    await fixture.library.index(fixture.collection.id)
    const reopened = collectionSemantic(fixture.options)
    expect(await reopened.index(fixture.collection.id)).toEqual({ sections: 2, embedded: 0, reused: 2 })
    expect(fixture.state.sends).toHaveLength(1)
    await Bun.write(
      path.join(fixture.root, "docs/lease.md"),
      "# Lease\n\nRelease ownership after two signed receipts arrive.",
    )
    await rejects(reopened.search("retire locks", [fixture.collection.id]), /original changed/)
    expect(fixture.state.sends).toHaveLength(1)
    await fixture.library.index(fixture.collection.id)
    expect(await reopened.index(fixture.collection.id)).toEqual({ sections: 2, embedded: 1, reused: 1 })
    expect(fixture.state.sends.at(-1)).toHaveLength(1)
    expect(fixture.state.sends.at(-1)?.at(0)).toContain("two signed receipts")
    const result = await reopened.search("retire locks", [fixture.collection.id], { limit: 1 })
    expect(result.at(0)?.source.text).toContain("two signed receipts")
  } finally {
    await fixture.close()
  }
})

test("session ownership and persisted exclusions apply before embedding and result limits", async () => {
  const fixture = await setup("private")
  try {
    fixture.state.allowed = true
    await rejects(fixture.adapter.index(fixture.collection.id, { session: "other" }))
    expect(fixture.state.sends).toEqual([])
    await fixture.adapter.index(fixture.collection.id, { session: "private" })
    const originals = await fixture.storage.knowledge(fixture.root, "private")
    const lease = originals.find((item) => item.method === "collection-section" && item.detail.document === "lease.md")!
    await fixture.storage.policySave(fixture.root, {
      session: "",
      version: "exclude-lease",
      pin: [],
      exclude: [lease.id],
    })
    const result = await fixture.adapter.search("retire locks", [fixture.collection.id], {
      session: "private",
      limit: 1,
    })
    expect(result).toHaveLength(1)
    expect(result.at(0)?.source.detail.document).toBe("audit.md")
    expect(await fixture.adapter.index(fixture.collection.id, { session: "private" })).toEqual({
      sections: 1,
      embedded: 0,
      reused: 1,
    })
    expect(fixture.state.sends).toHaveLength(2)
    await fixture.library.stop(fixture.collection.id, "private")
    await rejects(fixture.adapter.search("retire locks", [fixture.collection.id], { session: "private" }), /not ready/)
    expect(fixture.state.sends).toHaveLength(2)
  } finally {
    await fixture.close()
  }
})

test("model and destination changes cannot reuse a differently bound collection index", async () => {
  const fixture = await setup()
  try {
    fixture.state.allowed = true
    await fixture.adapter.index(fixture.collection.id)
    for (const target of [
      { ...fixture.options.target, model: "fixture-v2" },
      { ...fixture.options.target, fingerprint: "another-destination" },
    ]) {
      const adapter = collectionSemantic({ ...fixture.options, target })
      expect(adapter.identity).not.toBe(fixture.adapter.identity)
      expect(await adapter.search("retire locks", [fixture.collection.id])).toEqual([])
      expect(await adapter.index(fixture.collection.id)).toEqual({ sections: 2, embedded: 2, reused: 0 })
    }
    expect(fixture.state.sends).toHaveLength(3)
  } finally {
    await fixture.close()
  }
})

for (const mutation of ["policy", "file", "pause", "grant", "purge"] as const) {
  test(`collection semantic ${mutation} changes during query embedding reject late results`, async () => {
    const fixture = await setup()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    try {
      fixture.state.allowed = true
      await fixture.adapter.index(fixture.collection.id)
      fixture.state.response = async () => {
        entered.resolve()
        await release.promise
        return [[1, 0]]
      }
      const pending = fixture.adapter.search("retire locks", [fixture.collection.id])
      const outcome = pending.then(
        () => "accepted",
        () => "rejected",
      )
      await entered.promise
      if (mutation === "policy")
        await fixture.storage.policySave(fixture.root, {
          session: "",
          version: "changed",
          pin: [],
          exclude: ["another-source"],
        })
      if (mutation === "file") await Bun.write(path.join(fixture.root, "docs/lease.md"), "Changed original")
      if (mutation === "pause") await fixture.library.stop(fixture.collection.id)
      if (mutation === "grant") fixture.state.allowed = false
      if (mutation === "purge") await fixture.library.purge(fixture.collection.id)
      release.resolve()
      expect(await outcome).toBe("rejected")
    } finally {
      release.resolve()
      await fixture.close()
    }
  })
}

test("cancellation releases a held embedding and does not publish its late index", async () => {
  const fixture = await setup()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  try {
    fixture.state.allowed = true
    fixture.state.response = async (texts) => {
      entered.resolve()
      await release.promise
      return texts.map(() => [1, 0])
    }
    const controller = new AbortController()
    // A host transport may ignore cancellation. The adapter must still release
    // its caller and must not publish the eventual response.
    const adapter = collectionSemantic({ ...fixture.options, embed: (texts) => fixture.options.embed(texts) })
    const pending = adapter.index(fixture.collection.id, { signal: controller.signal })
    const outcome = pending.then(
      () => "accepted",
      () => "cancelled",
    )
    await entered.promise
    controller.abort(new Error("Task stopped"))
    expect(await outcome).toBe("cancelled")
    expect(await fixture.adapter.search("retire locks", [fixture.collection.id])).toEqual([])
    expect(fixture.state.sends).toHaveLength(1)
    release.resolve()
    fixture.state.response = undefined
    expect(await fixture.adapter.index(fixture.collection.id)).toEqual({ sections: 2, embedded: 2, reused: 0 })
    const aborted = AbortSignal.abort(new Error("Already stopped"))
    await rejects(fixture.adapter.search("never sent", [fixture.collection.id], { signal: aborted }), /Already stopped/)
    expect(fixture.state.sends).toHaveLength(2)
  } finally {
    release.resolve()
    await fixture.close()
  }
})

for (const vector of [[], [0, 0], [1], [1, 2, 3]]) {
  test(`malformed embedding ${JSON.stringify(vector)} cannot publish a collection index`, async () => {
    const fixture = await setup()
    try {
      fixture.state.allowed = true
      fixture.state.response = async (texts) => texts.map(() => vector)
      await rejects(fixture.adapter.index(fixture.collection.id))
      expect(await fixture.adapter.search("retire locks", [fixture.collection.id])).toEqual([])
      expect(fixture.state.sends).toHaveLength(1)
    } finally {
      await fixture.close()
    }
  })
}

test("an invalid later batch leaves the previous published vector generation intact", async () => {
  const fixture = await setup()
  try {
    fixture.state.allowed = true
    await fixture.adapter.index(fixture.collection.id)
    const saved = fixture.state.db
      .query<{ body: string }, []>("SELECT body FROM forge_records WHERE kind = 'cache'")
      .all()
    for (let index = 0; index < 17; index++) {
      await Bun.write(
        path.join(fixture.root, `docs/extra-${index}.md`),
        `# Procedure ${index}\n\nPreserve the signed dispatch receipt ${index}.`,
      )
    }
    await fixture.library.index(fixture.collection.id)
    let batches = 0
    fixture.state.response = async (texts) => (++batches === 2 ? [] : texts.map(() => [1, 0]))
    await rejects(fixture.adapter.index(fixture.collection.id), /does not match requested inputs/)
    expect(batches).toBe(2)
    expect(
      fixture.state.db.query<{ body: string }, []>("SELECT body FROM forge_records WHERE kind = 'cache'").all(),
    ).toEqual(saved)
    fixture.state.response = undefined
    expect(await fixture.adapter.index(fixture.collection.id)).toEqual({ sections: 19, embedded: 17, reused: 2 })
  } finally {
    await fixture.close()
  }
})

test("purge during index embedding cannot resurrect vectors after its fence closes", async () => {
  const fixture = await setup()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  try {
    fixture.state.allowed = true
    fixture.state.response = async (texts) => {
      entered.resolve()
      await release.promise
      return texts.map(() => [1, 0])
    }
    const pending = fixture.adapter.index(fixture.collection.id)
    const outcome = pending.then(
      () => "accepted",
      () => "rejected",
    )
    await entered.promise
    await fixture.library.purge(fixture.collection.id)
    release.resolve()
    expect(await outcome).toBe("rejected")
    expect(
      fixture.state.db
        .query<{ count: number }, []>("SELECT count(*) AS count FROM forge_records WHERE kind = 'cache'")
        .get()?.count,
    ).toBe(0)
  } finally {
    release.resolve()
    await fixture.close()
  }
})

test("file changes while destination permission waits prevent document egress", async () => {
  const fixture = await setup()
  try {
    fixture.state.allowed = true
    fixture.state.permission = async () => {
      await Bun.write(path.join(fixture.root, "docs/lease.md"), "Modified while permission was pending")
    }
    await rejects(fixture.adapter.index(fixture.collection.id), /original changed/)
    expect(fixture.state.sends).toEqual([])
  } finally {
    await fixture.close()
  }
})

test("checking a later collection cannot invalidate an earlier collection's accepted results", async () => {
  const fixture = await setup()
  try {
    fixture.state.allowed = true
    const other = await fixture.library.register({
      kind: "text",
      label: "Additional",
      location: "",
      content: "Keep the approved dispatch ledger.",
    })
    await fixture.library.approve(other.id)
    await fixture.library.index(other.id)
    await fixture.adapter.index(fixture.collection.id)
    await fixture.adapter.index(other.id)
    let checks = 0
    const adapter = collectionSemantic({
      ...fixture.options,
      authorize: async ({ collection }) => {
        if (collection.id === other.id && ++checks === 3) await fixture.library.stop(fixture.collection.id)
      },
    })
    await rejects(adapter.search("retire locks", [fixture.collection.id, other.id]), /changed/)
    expect(checks).toBe(3)
  } finally {
    await fixture.close()
  }
})

test("durable embedding consent survives reopen, is separate from coding grants, and can be revoked offline", async () => {
  const fixture = await setup()
  try {
    fixture.state.allowed = true
    const review = await fixture.consent.review(fixture.collection.id)
    expect(review.approved).toBe(false)
    await rejects(fixture.secured.index(fixture.collection.id), /has not been approved/)
    expect(fixture.state.sends).toEqual([])
    await fixture.consent.approve(fixture.collection.id, review.revision)
    expect((await fixture.consent.review(fixture.collection.id)).approved).toBe(true)
    await fixture.secured.index(fixture.collection.id)
    fixture.state.db.close()
    fixture.state.db = new Database(path.join(fixture.root, "catalog.sqlite"))
    expect((await fixture.consent.review(fixture.collection.id)).approved).toBe(true)
    expect(
      (await fixture.secured.search("retire locks", [fixture.collection.id], { limit: 1 })).at(0)?.source.detail
        .document,
    ).toBe("lease.md")
    const offline = embeddingConsent({
      root: fixture.root,
      store: fixture.storage,
      target: async () => {
        throw new Error("Provider unavailable")
      },
      authorize: async () => {},
    })
    await offline.revoke(fixture.collection.id)
    await rejects(fixture.secured.search("retire locks", [fixture.collection.id]), /has not been approved/)
    expect(fixture.state.sends).toHaveLength(2)
    expect((await fixture.library.get(fixture.collection.id)).providers).toEqual(["coding"])
  } finally {
    await fixture.close()
  }
})

for (const mutation of ["destination", "model", "dimensions", "collection", "revoke"] as const) {
  test(`stale embedding confirmation cannot approve after ${mutation} changes`, async () => {
    const fixture = await setup()
    try {
      fixture.state.allowed = true
      const review = await fixture.consent.review(fixture.collection.id)
      if (mutation === "destination") fixture.options.target.fingerprint = "different destination"
      if (mutation === "model") fixture.options.target.model = "different model"
      if (mutation === "dimensions") fixture.options.target.dimensions = 3
      if (mutation === "collection") await fixture.library.stop(fixture.collection.id)
      if (mutation === "revoke") await fixture.consent.revoke(fixture.collection.id)
      await rejects(fixture.consent.approve(fixture.collection.id, review.revision))
      expect((await fixture.consent.review(fixture.collection.id)).approved).toBe(false)
      expect(fixture.state.sends).toEqual([])
    } finally {
      await fixture.close()
    }
  })
}

for (const mutation of ["revoke", "pause", "purge", "target"] as const) {
  test(`pending embedding approval cannot overwrite ${mutation}`, async () => {
    const fixture = await setup()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    try {
      fixture.state.allowed = true
      const review = await fixture.consent.review(fixture.collection.id)
      fixture.state.permission = async () => {
        entered.resolve()
        await release.promise
      }
      const pending = fixture.consent.approve(fixture.collection.id, review.revision)
      const outcome = pending.then(
        () => "accepted",
        () => "rejected",
      )
      await entered.promise
      if (mutation === "revoke") await fixture.consent.revoke(fixture.collection.id)
      if (mutation === "pause") await fixture.library.stop(fixture.collection.id)
      if (mutation === "purge") await fixture.library.purge(fixture.collection.id)
      if (mutation === "target") fixture.options.target.model = "changed"
      release.resolve()
      expect(await outcome).toBe("rejected")
      expect(fixture.state.sends).toEqual([])
      if (mutation !== "purge") expect((await fixture.consent.review(fixture.collection.id)).approved).toBe(false)
    } finally {
      release.resolve()
      await fixture.close()
    }
  })
}

for (const mutation of ["pause", "remove", "recover", "reapprove"] as const) {
  test(`${mutation} clears embedding grants and local approval cannot recreate them`, async () => {
    const fixture = await setup()
    try {
      fixture.state.allowed = true
      await fixture.consent.approve(
        fixture.collection.id,
        (await fixture.consent.review(fixture.collection.id)).revision,
      )
      if (mutation === "pause") await fixture.library.stop(fixture.collection.id)
      if (mutation === "remove") await fixture.library.stop(fixture.collection.id, "", true)
      if (mutation === "reapprove") await fixture.library.approve(fixture.collection.id, "", ["coding"])
      if (mutation === "recover") {
        const current = await fixture.library.get(fixture.collection.id)
        await fixture.storage.save(fixture.root, { ...current, state: "indexing" })
        await fixture.storage.recover(fixture.root)
      }
      expect((await fixture.storage.embedding(fixture.root, fixture.collection.id)).grant).toBeUndefined()
      if (mutation !== "remove") {
        await fixture.library.approve(fixture.collection.id)
        await fixture.library.index(fixture.collection.id)
        await rejects(fixture.secured.index(fixture.collection.id), /has not been approved/)
      }
      expect(fixture.state.sends).toEqual([])
    } finally {
      await fixture.close()
    }
  })
}

test("private embedding grants cannot be read, approved, or revoked from another session or workspace", async () => {
  const fixture = await setup("private")
  try {
    fixture.state.allowed = true
    const review = await fixture.consent.review(fixture.collection.id, "private")
    await rejects(fixture.consent.review(fixture.collection.id, "other"), /session/)
    await rejects(fixture.consent.approve(fixture.collection.id, review.revision, "other"), /session/)
    await fixture.consent.approve(fixture.collection.id, review.revision, "private")
    await rejects(fixture.consent.revoke(fixture.collection.id, "other"), /session/)
    await rejects(fixture.storage.embedding(`${fixture.root}/other`, fixture.collection.id, "private"), /unavailable/)
    expect((await fixture.consent.review(fixture.collection.id, "private")).approved).toBe(true)
  } finally {
    await fixture.close()
  }
})

test("revoking and reapproving during query embedding invalidates the original request", async () => {
  const fixture = await setup()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  try {
    fixture.state.allowed = true
    await fixture.consent.approve(fixture.collection.id, (await fixture.consent.review(fixture.collection.id)).revision)
    await fixture.secured.index(fixture.collection.id)
    fixture.state.response = async () => {
      entered.resolve()
      await release.promise
      return [[1, 0]]
    }
    const pending = fixture.secured.search("retire locks", [fixture.collection.id])
    const outcome = pending.then(
      () => "accepted",
      () => "rejected",
    )
    await entered.promise
    await fixture.consent.revoke(fixture.collection.id)
    await fixture.consent.approve(fixture.collection.id, (await fixture.consent.review(fixture.collection.id)).revision)
    release.resolve()
    expect(await outcome).toBe("rejected")
    fixture.state.response = undefined
    expect(await fixture.secured.search("retire locks", [fixture.collection.id])).toHaveLength(2)
  } finally {
    release.resolve()
    await fixture.close()
  }
})

test("persisted embedding grants do not override live permissions or target changes", async () => {
  const fixture = await setup()
  try {
    fixture.state.allowed = true
    await fixture.consent.approve(fixture.collection.id, (await fixture.consent.review(fixture.collection.id)).revision)
    await fixture.secured.index(fixture.collection.id)
    fixture.state.allowed = false
    await rejects(fixture.secured.search("retire locks", [fixture.collection.id]), /permission denied/)
    fixture.state.allowed = true
    fixture.options.target.model = "replacement model"
    await rejects(fixture.secured.search("retire locks", [fixture.collection.id]), /destination changed/)
    expect(fixture.state.sends).toHaveLength(1)
  } finally {
    await fixture.close()
  }
})

test("unchanged local refresh preserves embedding approval and cached vectors", async () => {
  const fixture = await setup()
  try {
    fixture.state.allowed = true
    await fixture.consent.approve(fixture.collection.id, (await fixture.consent.review(fixture.collection.id)).revision)
    await fixture.secured.index(fixture.collection.id)
    const previous = (await fixture.storage.embedding(fixture.root, fixture.collection.id)).grant
    await fixture.library.index(fixture.collection.id)
    expect((await fixture.storage.embedding(fixture.root, fixture.collection.id)).grant).toBe(previous)
    expect(await fixture.secured.index(fixture.collection.id)).toEqual({ sections: 2, embedded: 0, reused: 2 })
    expect(fixture.state.sends).toHaveLength(1)
  } finally {
    await fixture.close()
  }
})

test("workspace embedding grant changes notify all sessions even when approved from a chat", async () => {
  const fixture = await setup()
  const events: string[] = []
  const off = fixture.storage.subscribe(fixture.root, (change) => events.push(change.session))
  try {
    fixture.state.allowed = true
    const review = await fixture.consent.review(fixture.collection.id, "chat")
    await fixture.consent.approve(fixture.collection.id, review.revision, "chat")
    await fixture.consent.revoke(fixture.collection.id, "chat")
    expect(events).toEqual(["", ""])
  } finally {
    off()
    await fixture.close()
  }
})

test("engine lookup ranks collection vectors independently of repository readiness and persists original channel history", async () => {
  const fixture = await setup()
  const api = await connect(fixture, { readiness: () => ({ state: "disabled", searchable: false }) })
  try {
    await approve(fixture)
    const lookup = await api.lookup({ query: "retire locks", session: "chat", tool: "forge_search_docs" })
    expect(lookup.result.matches).toHaveLength(1)
    const original = lookup.result.matches.at(0)!.source
    expect(original.detail.document).toBe("lease.md")
    expect(await fixture.storage.source(fixture.root, original.id)).toEqual(original)
    expect(lookup.result.audit?.channels?.find((item) => item.name === "semantic")?.state).toBe("disabled")
    expect(lookup.result.audit?.channels?.find((item) => item.name === "collection-semantic")).toMatchObject({
      state: "completed",
      candidates: 1,
      withheld: 0,
    })
    expect(lookup.result.audit?.candidates.at(0)?.channels).toContainEqual({
      name: "collection-semantic",
      rank: 1,
      score: 1,
      reason: "Collection semantic index",
    })
    fixture.state.db.close()
    fixture.state.db = new Database(path.join(fixture.root, "catalog.sqlite"))
    const capture = await api.request(lookup.request, "chat")
    expect(capture?.retrieval?.channels.find((item) => item.name === "collection-semantic")?.state).toBe("completed")
    expect(capture?.selection).toEqual(lookup.result.audit)
    expect(await api.request(lookup.request, "other")).toBeUndefined()
    expect(JSON.stringify(capture?.selection)).not.toContain("signed receipt")
    expect(fixture.state.sends).toHaveLength(2)
  } finally {
    await api.dispose()
    await fixture.close()
  }
})

for (const mode of ["no-grant", "revoked", "other-session", "other-provider", "denied", "unindexed"] as const) {
  test(`engine collection semantics avoids query transmission for ${mode}`, async () => {
    const session = mode === "other-session" ? "private" : ""
    const fixture = await setup(session)
    const api = await connect(fixture, {
      ...(mode === "other-provider" ? { provider: async () => "other" } : {}),
      ...(mode === "denied"
        ? {
            authorize: async () => {
              throw new Error("Denied")
            },
          }
        : {}),
    })
    try {
      if (mode !== "no-grant" && mode !== "unindexed") await approve(fixture, session)
      if (mode === "revoked") await fixture.consent.revoke(fixture.collection.id)
      if (mode === "unindexed") {
        fixture.state.allowed = true
        await fixture.consent.approve(
          fixture.collection.id,
          (await fixture.consent.review(fixture.collection.id)).revision,
        )
      }
      const sends = fixture.state.sends.length
      const result = await api.retrieve("retire locks", { session: "chat" })
      expect(result.matches).toEqual([])
      expect(fixture.state.sends).toHaveLength(sends)
      expect(result.audit?.channels?.find((item) => item.name === "collection-semantic")).toMatchObject({
        state: "completed",
        candidates: 0,
      })
    } finally {
      await api.dispose()
      await fixture.close()
    }
  })
}

test("engine request exclusions precede the collection vector top-one limit", async () => {
  const fixture = await setup()
  const api = await connect(fixture)
  try {
    await approve(fixture)
    const original = (await fixture.storage.knowledge(fixture.root)).find(
      (item) => item.method === "collection-section" && item.detail.document === "lease.md",
    )!
    const result = await api.retrieve("retire locks", { session: "chat", exclude: [original.id] })
    expect(result.matches).toHaveLength(1)
    expect(result.matches.at(0)?.source.detail.document).toBe("audit.md")
    expect(result.audit?.channels?.find((item) => item.name === "collection-semantic")?.candidates).toBe(1)
  } finally {
    await api.dispose()
    await fixture.close()
  }
})

for (const mode of ["text", "locator", "metadata", "mutation", "score", "unknown"] as const) {
  test(`engine collection channel rejects ${mode} replacement before admission`, async () => {
    const fixture = await setup()
    const api = await connect(fixture, {
      collectionSemantic: async (input) => {
        const item = input.sources.find((item) => item.detail.document === "lease.md")!
        const original = structuredClone(item)
        if (mode === "mutation") Object.assign(item, { text: "Untrusted replacement" })
        return [
          {
            source: {
              ...item,
              ...(mode === "text" ? { text: "Untrusted replacement" } : {}),
              ...(mode === "locator" ? { start: 999 } : {}),
              ...(mode === "metadata" ? { detail: {} } : {}),
              ...(mode === "unknown" ? { id: "unknown" } : {}),
            },
            score: mode === "score" ? NaN : 100,
            reason: "Untrusted reason",
          },
          { source: original, score: 0.5, reason: "Untrusted reason" },
        ]
      },
    })
    try {
      const result = await api.retrieve("retire locks", { session: "chat" })
      expect(result.matches).toHaveLength(1)
      expect(result.matches.at(0)?.source.text).toContain("signed receipt")
      expect(JSON.stringify(result)).not.toContain("Untrusted")
      expect(result.audit?.channels?.find((item) => item.name === "collection-semantic")).toMatchObject({
        candidates: 1,
        withheld: 1,
      })
    } finally {
      await api.dispose()
      await fixture.close()
    }
  })
}

test("engine discards completed collection results when another channel revokes consent", async () => {
  const fixture = await setup()
  const entered = Promise.withResolvers<void>()
  const api = await connect(fixture, {
    collectionSemantic: async (input) => {
      const matches = await fixture.secured.retrieve(input)
      entered.resolve()
      return matches
    },
    memory: async () => {
      await entered.promise
      await fixture.consent.revoke(fixture.collection.id)
      return []
    },
  })
  try {
    await approve(fixture)
    const lookup = await api.lookup({ query: "retire locks", session: "chat", tool: "forge_search_docs" })
    expect(lookup.result.matches).toEqual([])
    expect(lookup.result.audit?.channels?.find((item) => item.name === "collection-semantic")).toMatchObject({
      state: "failed",
      candidates: 0,
      withheld: 1,
    })
    expect(
      (await api.request(lookup.request, "chat"))?.retrieval?.channels.find(
        (item) => item.name === "collection-semantic",
      )?.state,
    ).toBe("failed")
  } finally {
    entered.resolve()
    await api.dispose()
    await fixture.close()
  }
})

test("engine continues lexical retrieval when collection embedding fails", async () => {
  const fixture = await setup()
  const api = await connect(fixture)
  try {
    await approve(fixture)
    fixture.state.response = async () => []
    const lookup = await api.lookup({ query: "signed receipt", session: "chat", tool: "forge_search_docs" })
    expect(lookup.result.matches.some((item) => item.source.text.includes("signed receipt"))).toBe(true)
    expect(lookup.result.audit?.channels?.find((item) => item.name === "collection-semantic")?.state).toBe("failed")
    expect(
      (await api.request(lookup.request, "chat"))?.retrieval?.channels.find(
        (item) => item.name === "collection-semantic",
      )?.state,
    ).toBe("failed")
  } finally {
    await api.dispose()
    await fixture.close()
  }
})

test("engine cancellation abandons held collection work and fresh lookup can finish before release", async () => {
  const fixture = await setup()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const api = await connect(fixture)
  try {
    await approve(fixture)
    fixture.state.response = async (texts) => {
      if (texts.at(0) === "held query") {
        entered.resolve()
        await release.promise
      }
      return [[1, 0]]
    }
    const controller = new AbortController()
    const pending = api.lookup({
      query: "held query",
      session: "chat",
      tool: "forge_search_docs",
      signal: controller.signal,
    })
    const outcome = pending.then(
      () => "accepted",
      () => "cancelled",
    )
    await entered.promise
    controller.abort(new Error("Stopped"))
    expect(await outcome).toBe("cancelled")
    const lookup = await api.lookup({ query: "retire locks", session: "chat", tool: "forge_search_docs" })
    expect(lookup.result.matches.at(0)?.source.detail.document).toBe("lease.md")
    const failed = (await fixture.storage.manifests(fixture.root, { session: "chat" })).find(
      (item) => item.id !== lookup.request,
    )!
    expect(failed.retrieval?.state).toBe("cancelled")
    expect(failed.retrieval?.channels.find((item) => item.name === "collection-semantic")?.state).toBe("abandoned")
  } finally {
    release.resolve()
    await api.dispose()
    await fixture.close()
  }
})

test("prepared context includes collection originals and retains semantic attribution", async () => {
  const fixture = await setup()
  const prompts: string[] = []
  const api = await connect(fixture, {
    complete: async (input) => {
      prompts.push(input.prompt)
      return {
        text: JSON.stringify({
          objective: "Retire locks",
          reuse: [],
          inspect: [],
          changes: [],
          constraints: [],
          hypotheses: [],
          questions: [],
          acceptance: [],
          verification: [],
          evidence: [],
        }),
        usage: usage("fixture"),
      }
    },
  })
  try {
    await approve(fixture)
    const proposal = await api.enhance({ text: "retire locks", session: "chat" })
    expect(prompts).toHaveLength(1)
    expect(prompts.at(0)).toContain("signed receipt")
    expect(proposal.context.matches.at(0)?.source.detail.document).toBe("lease.md")
    const captured = await api.request(proposal.id, "chat")
    expect(captured?.selection).toEqual(proposal.context.audit)
    expect(captured?.selection?.channels?.find((item) => item.name === "collection-semantic")?.candidates).toBe(1)
  } finally {
    await api.dispose()
    await fixture.close()
  }
})

test("consent revoked after channel validation cannot be accepted under a later access snapshot", async () => {
  const fixture = await setup()
  let reads = 0
  const api = await connect(fixture, {
    store: {
      ...fixture.storage,
      access: async (root, session, collections) => {
        const stamp = await fixture.storage.access(root, session, collections)
        if (++reads === 2) await fixture.consent.revoke(fixture.collection.id)
        return stamp
      },
    },
  })
  try {
    await approve(fixture)
    await rejects(api.retrieve("retire locks", { session: "chat" }), /semantic consent changed/)
  } finally {
    await api.dispose()
    await fixture.close()
  }
})

for (const mode of ["dispose", "disabled", "changed", "refresh"] as const) {
  test(`composed engine embeddings respect ${mode} while owning lifecycle work`, async () => {
    const fixture = await setup()
    let enabled = true
    let model = "fixture-v1"
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const api = await connect(fixture, {
      collectionSemantic: undefined,
      embeddings: {
        configuration: async () =>
          enabled
            ? {
                endpoint: fixture.endpoint,
                model,
                dimensions: 2,
              }
            : undefined,
        authorize: async () => {},
      },
    })
    try {
      const embedding = api.embeddings!
      await embedding.approve(fixture.collection.id, (await embedding.review(fixture.collection.id)).revision)
      if (mode === "dispose") {
        fixture.state.response = async (texts) => {
          entered.resolve()
          await release.promise
          return texts.map(() => [1, 0])
        }
        const pending = embedding.index(fixture.collection.id).then(
          () => "accepted",
          () => "cancelled",
        )
        await entered.promise
        await api.dispose()
        expect(await pending).toBe("cancelled")
        await rejects(embedding.review(fixture.collection.id), /closed/)
        fixture.state.allowed = true
        expect(await fixture.adapter.search("retire locks", [fixture.collection.id])).toEqual([])
        return
      }
      expect(await embedding.index(fixture.collection.id)).toEqual({ sections: 2, embedded: 2, reused: 0 })
      if (mode === "disabled") {
        enabled = false
        expect((await api.retrieve("retire locks", { provider: "coding" })).matches).toEqual([])
        await embedding.revoke(fixture.collection.id)
        enabled = true
        expect((await embedding.review(fixture.collection.id)).approved).toBe(false)
      }
      if (mode === "changed") {
        const review = await embedding.review(fixture.collection.id)
        model = "different"
        await rejects(embedding.approve(fixture.collection.id, review.revision), /review changed/)
        expect((await api.retrieve("retire locks", { provider: "coding" })).matches).toEqual([])
        await rejects(embedding.index(fixture.collection.id), /has not been approved/)
      }
      if (mode === "refresh") {
        expect(await embedding.index(fixture.collection.id)).toEqual({ sections: 2, embedded: 0, reused: 2 })
        expect((await api.retrieve("retire locks", { provider: "coding" })).matches.at(0)?.source.detail.document).toBe(
          "lease.md",
        )
      }
      expect(fixture.state.sends).toHaveLength(mode === "refresh" ? 2 : 1)
    } finally {
      release.resolve()
      await api.dispose()
      await fixture.close()
    }
  })
}
