import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Schema } from "effect"
import { engine, fingerprint, type Ports } from "../src/engine"
import { source } from "../src/parse"
import { store } from "../src/store"
import { actions, findings, limits, type Call, type Turn, type InvestigationProgress } from "../src/investigation"
import { tokens } from "../src/util"
import { decode, usage } from "../src/schema"
import { structured } from "../src/structured"
import { EnhancementError } from "../src/enhancement"
import { Written } from "../src/writing"

const model = { providerID: "local", modelID: "fixture" }
function result(input: Turn, calls: Call[]) {
  return {
    calls, bytes: tokens(JSON.stringify({ system: input.system, input: input.input, observations: input.observations })) + 500,
    usage: { ...usage("local/fixture"), input: 10, output: 5, measured: true },
  }
}
function conclusion(evidence: string[] = []) {
  return {
    intent: "Prevent duplicate queue entries",
    summary: "The queue needs a scoped deduplication change.",
    findings: evidence.length ? [{
      title: "Repeated enqueue is not guarded", kind: "defect", support: "observed",
      explanation: "Enqueue appends without checking the identifier.", benefit: "Prevent duplicate work.",
      evidence, counterevidence: [], unknowns: [], action: "Guard duplicate identifiers.",
      verification: ["Add a regression for repeated enqueue."],
    }] : [],
    questions: [], limitations: ["Runtime tests have not been executed."],
  }
}
async function fixture(turn?: Ports["turn"], opts: Partial<Ports> = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "forge-investigate-")))
  await mkdir(path.join(root, ".kilo"))
  await writeFile(path.join(root, ".kilo/forge.jsonc"), '{"investigation":true}')
  await writeFile(path.join(root, "queue.ts"), "const queue: string[] = []\nexport function enqueue(id: string) { queue.push(id) }\n")
  await writeFile(path.join(root, "caller.ts"), 'import { enqueue } from "./queue"\nexport function retry(id: string) { enqueue(id) }\n')
  const db = new Database(":memory:")
  const storage = store({
    all: async (query) => db.query<Record<string, unknown>, (string | number | null)[]>(query.text).all(...query.values ?? []),
    batch: async (queries) => { db.transaction(() => { for (const query of queries) db.query(query.text).run(...query.values ?? []) })() },
  })
  const calls: Turn[] = []
  const ports: Ports = {
    ...opts, root, store: storage, resolve: async () => model, destination: async () => ({ fingerprint: "local-route", origins: [] }),
    complete: async () => { throw new Error("Legacy rewrite must not run") },
    turn: async (input) => {
      calls.push(input)
      if (turn) return turn(input)
      if (calls.length === 1) return result(input, [{ id: "search", name: "forge_search_code", input: { query: "enqueue queue" } }])
      if (calls.length === 2) return result(input, [{ id: "read", name: "forge_read_file", input: { path: "queue.ts" } }])
      const source = decode(Schema.Struct({ source: Schema.Struct({ id: Schema.String }) }), JSON.parse(input.observations.at(-1)!.output)).source
      return result(input, [{ id: "finish", name: "forge_finish", input: conclusion([source.id]) }])
    },
  }
  const api = engine(ports)
  return { root, storage, api, ports, calls, async [Symbol.asyncDispose]() { await api.dispose(); db.close(); await rm(root, { recursive: true, force: true }) } }
}

test("actual engine investigates through search and direct reads before publishing supported findings", async () => {
  const recalled: string[] = []
  await using f = await fixture(undefined, { memory: async (query) => { recalled.push(query); return [] } })
  const input = { key: randomUUID(), text: "Help me fix duplicate queue items", session: "chat", model }
  const record = await f.api.investigate(input)
  expect(record.state).toBe("findings_ready")
  expect(record.findings).toHaveLength(1)
  expect(record.observations.map((item) => item.tool)).toEqual(["forge_search_code", "forge_read_file"])
  expect(record.turns).toBe(3)
  expect(record.calls).toBe(2)
  expect(record.usage.input).toBe(30)
  expect(record.usage.measured).toBe(true)
  expect(record.original).toBe(input.text)
  expect(recalled).toEqual([])
  expect(await Bun.file(path.join(f.root, "queue.ts")).text()).toContain("queue.push(id)")
  expect(await f.api.investigation(record.id, "chat")).toEqual(record)
  expect(await f.api.investigate(input)).toEqual(record)
  expect(f.calls).toHaveLength(3)
  expect(record.journal?.map((item) => item.number)).toEqual([1, 2, 3])
  expect(record.observations.map((item) => item.turn)).toEqual([1, 2])
  expect(record.journal?.at(0)?.inspections.at(0)?.activity?.counts?.search).toBeGreaterThan(0)
  expect(record.journal?.at(0)?.inspections.at(0)?.activity?.entries.some((item) => item.action === "Scan complete")).toBe(true)
  expect(record.journal?.at(2)?.summary).toContain("Validated 1 findings")
  expect(record.journal?.at(2)?.included).toEqual(["search", "read"])
  await expect(f.api.investigate({ ...input, text: "Different request" })).rejects.toThrow("different input")
  await expect(f.api.investigation(record.id, "another")).rejects.toThrow("unavailable")
})

test("documentation investigation chooses an owning dependency and follows an unresolved question", async () => {
  const queries: string[] = []
  await using f = await fixture(async (input) => {
    const dep = input.sources.find((item) => item.kind === "dependency")
    if (!dep) return result(input, [{ id: "local", name: "forge_search_docs", input: { query: "queue dependency" } }])
    const docs = input.sources.filter((item) => item.method === "context7")
    if (!docs.length) return result(input, [{ id: "docs", name: "forge_search_docs", input: { query: "queue retries", dependency: dep.id } }])
    if (docs.some((item) => item.text.includes("Key lifetime is unspecified")) && !docs.some((item) => item.text.includes("Key expires"))) {
      return result(input, [{ id: "followup", name: "forge_search_docs", input: { query: "queue key lifetime", dependency: dep.id } }])
    }
    return result(input, [{ id: "finish", name: "forge_finish", input: { ...conclusion(), summary: "Documentation clarified the key lifetime; implementation still needs checking." } }])
  }, { docs: async (input) => {
    queries.push(input.query)
    expect(input.dependencies).toHaveLength(1)
    expect(input.explicit).toBe(true)
    const dep = input.dependencies.at(0)!
    return [source(`mcp:docs:queue:${queries.length}`, queries.length === 1 ? "Key lifetime is unspecified." : "Key expires after one day.", "document", {
      method: "context7", evidence: [dep.id],
      detail: { server: "docs", session: input.session ?? "", provider: input.provider ?? "", dependencies: JSON.stringify({ [dep.id]: fingerprint(dep) }) },
    })]
  } })
  await writeFile(path.join(f.root, ".kilo/forge.jsonc"), '{"investigation":true,"documents":{"server":"docs"}}')
  await writeFile(path.join(f.root, "package.json"), '{"dependencies":{"queue":"1.0.0"}}')
  const record = await f.api.investigate({ key: randomUUID(), text: "Investigate queue retries and key lifetime", model, session: "chat" })
  expect(record.state).toBe("findings_ready")
  expect(queries).toEqual(["queue retries", "queue key lifetime"])
  expect(record.observations).toHaveLength(3)
  expect(record.findings).toEqual([])
})

test("already-fixed and insufficient-evidence conclusions need not invent a change", async () => {
  await using f = await fixture(async (input) => result(input, [{ id: "finish", name: "forge_finish", input: {
    ...conclusion(), summary: "No defect is established by the available evidence.",
  } }]))
  const record = await f.api.investigate({ key: randomUUID(), text: "Check whether a fix is needed", model })
  expect(record.findings).toEqual([])
  expect(record.state).toBe("findings_ready")
  expect(record.observations).toEqual([])
})

test("consequential missing intent produces a needs-input result without a presumed fix", async () => {
  await using f = await fixture(async (input) => result(input, [{ id: "finish", name: "forge_finish", input: {
    ...conclusion(), questions: [{ id: "retention", question: "Which retention policy applies?", impact: "Permanent deletion changes customer data retention.", options: ["Keep all records", "Apply an approved retention policy"], optional: false }],
  } }]))
  const record = await f.api.investigate({ key: randomUUID(), text: "Clean up old customer records", model })
  expect(record.state).toBe("needs_input")
  expect(record.findings).toEqual([])
})

test("tools and findings reject unauthorized actions, guessed citations and uninspected certainty", async () => {
  for (const call of [
    { id: "bad", name: "bash", input: { command: "touch changed" } },
    { id: "bad", name: "forge_read_file", input: { path: "../secret.ts" } },
    { id: "bad", name: "forge_finish", input: conclusion(["a".repeat(24)]) },
  ]) {
    await using f = await fixture(async (input) => result(input, [call as Call]))
    const key = randomUUID()
    await expect(f.api.investigate({ key, text: "Inspect queue", model })).rejects.toThrow()
    expect((await f.storage.investigation(f.root, "", key))?.state).toBe("failed")
    expect(f.calls).toHaveLength(1)
  }
  expect(() => findings(conclusion(["a".repeat(24)]), [])).toThrow("not observed")
})

test("text-only output fails with a safe diagnostic before executing", async () => {
  await using f = await fixture(async (input) => result(input, []))
  const key = randomUUID()
  const error = await f.api.investigate({ key, text: "Inspect queue", model }).catch((err: unknown) => err)
  expect(error).toBeInstanceOf(EnhancementError)
  if (!(error instanceof EnhancementError)) throw new Error("Expected a safe diagnostic")
  expect(error.message).toContain("no investigation tool calls")
  expect(error.message).not.toContain("PRIVATE_")
  expect((await f.storage.investigation(f.root, "", key))?.observations).toEqual([])
  expect((await f.storage.investigation(f.root, "", key))?.journal?.at(0)?.state).toBe("failed")
  expect(f.calls).toHaveLength(1)
})

test("failure snapshots clear source-bearing activity when evidence access changed", async () => {
  const frames: InvestigationProgress[] = []
  await using f = await fixture(async (input) => {
    if (!input.observations.length) return result(input, [{ id: "read", name: "forge_read_file", input: { path: "queue.ts" } }])
    await writeFile(path.join(f.root, "queue.ts"), "export const changed = true\n")
    return result(input, [{ id: "finish", name: "forge_finish", input: conclusion() }])
  })
  const error = await f.api.investigate({ key: randomUUID(), text: "Inspect queue", model, update: (frame) => frames.push(frame) }).catch((err: unknown) => err)
  expect(error).toBeInstanceOf(Error)
  expect(error).toMatchObject({ message: expect.stringContaining("changed") })
  expect(frames.some((frame) => frame.observations?.length)).toBe(true)
  expect(frames.at(-1)?.journal).toEqual([])
  expect(frames.at(-1)?.observations).toEqual([])
})

test("invalid findings expose only known schema paths, never model values or unknown keys", () => {
  for (const value of [
    { ...conclusion(), questions: [{ id: "question", question: "PRIVATE_PROMPT_CANARY", impact: "Scope", options: ["First", "Second"] }] },
    { ...conclusion(), PRIVATE_KEY_CANARY: "PRIVATE_VALUE_CANARY" },
    { ...conclusion(), findings: [{ ...conclusion(["a".repeat(24)]).findings.at(0), title: 42 }] },
  ]) {
    try {
      findings(value, [])
      throw new Error("Expected invalid findings to fail")
    } catch (err) {
      expect(err).toBeInstanceOf(EnhancementError)
      if (!(err instanceof EnhancementError)) throw err
      expect(err.message).toContain("Invalid findings or clarification format")
      expect(err.message).not.toContain("PRIVATE_")
      expect(err.failure.code).toBe("schema")
    }
  }
})

test("three independent reads run within the total budget without a model retry", async () => {
  await using f = await fixture(async (input) => {
    if (!input.observations.length) return result(input, Array.from({ length: 3 }, (_, index) => ({
      id: `call-${index}`, name: "forge_read_file", input: { path: "queue.ts" },
    })))
    const source = decode(Schema.Struct({ source: Schema.Struct({ id: Schema.String }) }), JSON.parse(input.observations.at(-1)!.output)).source
    return result(input, [{ id: "finish", name: "forge_finish", input: conclusion([source.id]) }])
  })
  const record = await f.api.investigate({ key: randomUUID(), text: "Inspect queue", model })
  expect(record.state).toBe("findings_ready")
  expect(record.calls).toBe(3)
  expect(record.observations.map((item) => item.id)).toEqual(["call-0", "call-1", "call-2"])
  expect(f.calls).toHaveLength(2)
  expect(record.journal?.map((item) => item.requested)).toEqual([3, 1])
  expect(record.journal?.at(0)?.inspections.map((item) => item.state)).toEqual(["complete", "complete", "complete"])
  expect(record.observations.map((item) => item.turn)).toEqual([1, 1, 1])
})

test("turn snapshots retain public updates and tool activity without replaying them into model context", async () => {
  const frames: InvestigationProgress[] = []
  await using f = await fixture(async (input) => {
    expect(JSON.stringify(input)).not.toContain("PUBLIC_UPDATE_CANARY")
    return {
      ...result(input, input.observations.length
        ? [{ id: "finish", name: "forge_finish", input: conclusion() }]
        : [{ id: "read", name: "forge_read_file", input: { path: "queue.ts" } }]),
      note: "PUBLIC_UPDATE_CANARY: Check the queue implementation. password=private-canary",
      reasoning: 7,
    }
  })
  const record = await f.api.investigate({ key: randomUUID(), text: "Inspect queue", model, update: (frame) => frames.push(frame) })
  expect(frames.at(0)?.journal?.at(0)?.state).toBe("model")
  expect(frames.some((frame) => frame.journal?.at(0)?.inspections.at(0)?.state === "running")).toBe(true)
  expect(frames.some((frame) => frame.observations?.at(0)?.turn === 1)).toBe(true)
  expect(record.journal?.at(0)?.note).toContain("PUBLIC_UPDATE_CANARY")
  expect(JSON.stringify(record.journal)).not.toContain("private-canary")
  expect(record.journal?.at(0)?.reasoning).toBe(7)
  expect(record.journal?.at(1)?.included).toEqual(["read"])
  expect(record.journal?.at(1)?.omitted).toEqual([])
  expect(await f.api.investigation(record.id)).toEqual(record)
})

test("turn history distinguishes replayed excerpts from metadata-only earlier results", async () => {
  await using f = await fixture(async (input) => result(input, input.observations.length < 2
    ? [{ id: `read-${input.observations.length}`, name: "forge_read_file", input: { path: "queue.ts", start: input.observations.length * 100 + 1, lines: 100 } }]
    : [{ id: "finish", name: "forge_finish", input: conclusion() }]))
  await writeFile(path.join(f.root, "queue.ts"), Array.from({ length: 200 }, () => `// ${"x".repeat(140)}`).join("\n"))
  const record = await f.api.investigate({ key: randomUUID(), text: "Inspect queue", model })
  expect(record.journal?.at(-1)?.included).toEqual(["read-1"])
  expect(record.journal?.at(-1)?.omitted).toEqual(["read-0"])
  expect(record.observations).toHaveLength(2)
  expect(f.calls.at(-1)?.observations.at(0)?.output).toContain("Earlier output omitted")
})

test("tool purposes provide public updates without becoming replayed model instructions", async () => {
  const purpose = "Compare queue behavior before recommending a fix."
  await using f = await fixture(async (input) => result(input, input.observations.length
    ? [{ id: "finish", name: "forge_finish", input: conclusion() }]
    : [{ id: "read", name: "forge_read_file", input: { path: "queue.ts", purpose } }]))
  const record = await f.api.investigate({ key: randomUUID(), text: "Inspect queue", model })
  expect(record.journal?.at(0)?.note).toBe(purpose)
  expect(record.journal?.at(0)?.inspections.at(0)?.input).toContain(purpose)
  expect(record.observations.at(0)?.input).toEqual({ path: "queue.ts", purpose })
  expect(f.calls.at(1)?.observations.at(0)?.input).toEqual({ path: "queue.ts" })
  expect(record.journal?.at(-1)?.note).toBe(conclusion().summary)
  expect(f.calls).toHaveLength(2)
})

test.each(["forge_get_symbol", "forge_relationships"] as const)("source inspection %s accepts an ID returned by a direct read", async (tool) => {
  await using f = await fixture(async (input) => {
    if (!input.observations.length) return result(input, [{ id: "read", name: "forge_read_file", input: { path: "queue.ts" } }])
    const source = decode(Schema.Struct({ source: Schema.Struct({ id: Schema.String }) }), JSON.parse(input.observations.at(0)!.output)).source
    if (input.observations.length === 1) return result(input, [{ id: "inspect", name: tool, input: { id: source.id } }])
    return result(input, [{ id: "finish", name: "forge_finish", input: conclusion([source.id]) }])
  })
  const record = await f.api.investigate({ key: randomUUID(), text: "Inspect queue", model })
  expect(record.state).toBe("findings_ready")
  expect(record.observations.map((item) => item.tool)).toEqual(["forge_read_file", tool])
  expect(record.observations.at(1)?.sources.some((item) => item.uri === "queue.ts")).toBe(true)
})

test.each([
  { name: "forge_read_file", input: { path: "PRIVATE_PATH_CANARY.ts" } },
  { name: "forge_read_file", input: { path: "queue.ts", start: 999 } },
  { name: "forge_get_symbol", input: { id: "a".repeat(24) } },
] satisfies Pick<Call, "name" | "input">[])("unavailable inspections return content-free tool feedback within the same attempt", async (call) => {
  await using f = await fixture(async (input) => {
    if (!input.observations.length) return result(input, [{ id: "missing", ...call }])
    if (input.observations.length === 1) return result(input, [{ id: "read", name: "forge_read_file", input: { path: "queue.ts" } }])
    const source = decode(Schema.Struct({ source: Schema.Struct({ id: Schema.String }) }), JSON.parse(input.observations.at(-1)!.output)).source
    return result(input, [{ id: "finish", name: "forge_finish", input: conclusion([source.id]) }])
  })
  const record = await f.api.investigate({ key: randomUUID(), text: "Inspect queue", model })
  expect(record.state).toBe("findings_ready")
  expect(record.calls).toBe(2)
  expect(record.observations.at(0)?.sources).toEqual([])
  expect(record.observations.at(0)?.output).toContain("No content was returned")
  expect(record.observations.at(0)?.output).not.toContain("PRIVATE_")
})

test("read permission failures do not become recoverable tool feedback", async () => {
  await using f = await fixture(async (input) => result(input, [{ id: "read", name: "forge_read_file", input: { path: "queue.ts" } }]), {
    permit: async (input) => {
      if (input.tool === "read") throw Object.assign(new Error("Read denied"), { code: "EACCES" })
    },
  })
  const key = randomUUID()
  const error = await f.api.investigate({ key, text: "Inspect queue", model }).catch((err: unknown) => err)
  expect(error).toBeInstanceOf(Error)
  expect((await f.storage.investigation(f.root, "", key))?.observations).toEqual([])
  expect(f.calls).toHaveLength(1)
})

test("a terminal conclusion skips sibling reads and only uses earlier evidence", async () => {
  await using f = await fixture(async (input) => {
    if (!input.observations.length) return result(input, [{ id: "read", name: "forge_read_file", input: { path: "queue.ts" } }])
    const source = decode(Schema.Struct({ source: Schema.Struct({ id: Schema.String }) }), JSON.parse(input.observations.at(-1)!.output)).source
    return result(input, [
      { id: "skipped", name: "forge_read_file", input: { path: "unread.ts" } },
      { id: "finish", name: "forge_finish", input: conclusion([source.id]) },
    ])
  })
  const record = await f.api.investigate({ key: randomUUID(), text: "Inspect queue", model })
  expect(record.state).toBe("findings_ready")
  expect(record.calls).toBe(1)
  expect(record.observations.map((item) => item.id)).toEqual(["read"])
  expect(record.limitations.join(" ")).toContain("not executed")
  expect(f.calls).toHaveLength(2)
})

test("sibling reads cannot supply unobserved evidence or resolve competing conclusions", async () => {
  for (const calls of [
    [
      { id: "read", name: "forge_read_file", input: { path: "queue.ts" } },
      { id: "finish", name: "forge_finish", input: conclusion(["a".repeat(24)]) },
    ],
    [
      { id: "first", name: "forge_finish", input: conclusion() },
      { id: "second", name: "forge_finish", input: { ...conclusion(), summary: "A different conclusion that must not be silently chosen." } },
    ],
  ] satisfies Call[][]) {
    await using f = await fixture(async (input) => result(input, calls))
    const key = randomUUID()
    const error = await f.api.investigate({ key, text: "Inspect queue", model }).catch((err: unknown) => err)
    expect(error).toBeInstanceOf(EnhancementError)
    expect((await f.storage.investigation(f.root, "", key))?.observations).toEqual([])
    expect((await f.storage.investigation(f.root, "", key))?.findings).toEqual([])
  }
})

test("identical terminal results produce one review without another model call", async () => {
  const value = conclusion()
  await using f = await fixture(async (input) => result(input, [
    { id: "first", name: "forge_finish", input: value },
    { id: "second", name: "forge_finish", input: Object.fromEntries(Object.entries(value).reverse()) },
  ]))
  const record = await f.api.investigate({ key: randomUUID(), text: "Inspect queue", model })
  expect(record.state).toBe("findings_ready")
  expect(record.calls).toBe(0)
  expect(record.limitations.join(" ")).toContain("Repeated identical conclusions")
  expect(f.calls).toHaveLength(1)
})

test("a batch beyond the remaining tool budget admits no partial work", async () => {
  await using f = await fixture(async (input) => result(input, Array.from({ length: limits.calls + 1 }, (_, index) => ({
    id: `call-${index}`, name: "forge_read_file", input: { path: "queue.ts" },
  }))))
  const record = await f.api.investigate({ key: randomUUID(), text: "Inspect queue", model })
  expect(record.state).toBe("limited")
  expect(record.calls).toBe(0)
  expect(record.observations).toEqual([])
  expect(f.calls).toHaveLength(1)
})

test("cumulative accounting reserves a conclusion turn including adapter overhead", async () => {
  await using f = await fixture(async (input) => ({
    ...result(input, input.final
      ? [{ id: "finish", name: "forge_finish", input: conclusion() }]
      : [{ id: randomUUID(), name: "forge_read_file", input: { path: "queue.ts" } }]),
    bytes: 90_000,
  }))
  const record = await f.api.investigate({ key: randomUUID(), text: "Inspect queue", model })
  expect(record.state).toBe("findings_ready")
  expect(f.calls.map((item) => item.final)).toEqual([false, false, true])
  expect(record.bytes).toBe(270_000)
  expect(record.bytes).toBeLessThan(limits.cumulative)
})

test("direct source reads cannot bypass context exclusions or registered document approval", async () => {
  await using f = await fixture()
  const snapshot = await f.api.refresh()
  const source = snapshot.sources.find((item) => item.uri === "queue.ts" && item.method === "file")!
  await f.api.configure({ ...await f.api.policy("chat"), exclude: [source.id] })
  await expect(f.api.read({ path: "queue.ts" }, "chat")).rejects.toThrow("excluded")
  await writeFile(path.join(f.root, "private.md"), "Private registered document")
  await f.api.register({ kind: "file", label: "Private", location: path.join(f.root, "private.md"), session: "other" })
  await expect(f.api.read({ path: "private.md" }, "chat")).rejects.toThrow("Registered paths")
})

test("changed original evidence invalidates saved findings even though their text is unchanged", async () => {
  await using f = await fixture()
  const record = await f.api.investigate({ key: randomUUID(), text: "Fix duplicate enqueue", model })
  await writeFile(path.join(f.root, "queue.ts"), "export function enqueue(id: string) { return id }\n")
  await expect(f.api.investigation(record.id)).rejects.toThrow()
})

test("investigation persistence uses revision checks and keeps session scopes separate", async () => {
  await using f = await fixture()
  const record = await f.api.investigate({ key: randomUUID(), text: "Fix queue", session: "chat", model })
  await expect(f.storage.investigationSave({ ...record, summary: "Forged overwrite" }, randomUUID())).rejects.toThrow()
  expect((await f.storage.investigation(f.root, "chat", record.id))?.summary).toBe(record.summary)
  expect(await f.storage.investigation(f.root, "other", record.id)).toBeUndefined()
  await expect(f.storage.investigationSave(record)).rejects.toThrow()
})

test("cancellation prevents late model calls and findings", async () => {
  const entered = Promise.withResolvers<Turn>()
  const release = Promise.withResolvers<void>()
  await using f = await fixture(async (input) => { entered.resolve(input); await release.promise; return result(input, [{ id: "finish", name: "forge_finish", input: conclusion() }]) })
  const controller = new AbortController()
  const key = randomUUID()
  const pending = f.api.investigate({ key, text: "Inspect queue", model, signal: controller.signal })
  const failure = pending.catch((err: unknown) => err)
  const turn = await entered.promise
  await expect(f.api.investigate({ key: randomUUID(), text: "A concurrent request", model })).rejects.toThrow("draft scope")
  controller.abort(new Error("Developer cancelled"))
  expect(await failure).toBeInstanceOf(Error)
  expect(turn.signal.aborted).toBe(true)
  release.resolve()
  await f.api.dispose()
  const record = await f.storage.investigation(f.root, "", key)
  expect(record?.state).toBe("cancelled")
  expect(record?.findings).toEqual([])
  expect(f.calls).toHaveLength(1)
})

test("opening an interrupted investigation does not restart paid work", async () => {
  await using f = await fixture()
  const record = await f.api.investigate({ key: randomUUID(), text: "Inspect queue", model })
  await f.storage.investigationSave({ ...record, state: "investigating", revision: randomUUID() }, record.revision)
  const restored = await f.api.investigation(record.id)
  expect(restored.state).toBe("interrupted")
  expect(restored.findings).toEqual([])
  expect(restored.original).toBe(record.original)
  expect(f.calls).toHaveLength(3)
})

test("turn exhaustion restricts the last turn to finishing and admits no extra read", async () => {
  let count = 0
  await using f = await fixture(async (input) => result(input, [{ id: `read-${count++}`, name: "forge_read_file", input: { path: "queue.ts" } }]))
  const record = await f.api.investigate({ key: randomUUID(), text: "Inspect queue", model })
  expect(record.state).toBe("limited")
  expect(record.turns).toBe(limits.turns)
  expect(record.calls).toBe(limits.turns - 1)
  expect(f.calls.at(-1)?.final).toBe(true)
})

test("new investigation is opt-in and leaves the legacy completion path separate", async () => {
  await using f = await fixture()
  await writeFile(path.join(f.root, ".kilo/forge.jsonc"), "{}")
  await expect(f.api.investigate({ key: randomUUID(), text: "Inspect queue", model })).rejects.toThrow("Enable investigation")
  expect(f.calls).toEqual([])
})

test("provider tool schemas preserve numeric read bounds without ambiguous intersections", () => {
  const schema = structured(Schema.toStandardJSONSchemaV1(Schema.toStandardSchemaV1(actions.forge_read_file))["~standard"].jsonSchema.input({ target: "draft-07" }))
  const serialized = JSON.stringify(schema)
  expect(serialized).not.toContain("allOf")
  expect(serialized).toContain('"minimum":1')
  expect(serialized).toContain('"maximum":160')
  expect(() => structured({ minimum: 2, allOf: [{ minimum: 1 }] })).toThrow("constraints")
  expect(() => structured({ allOf: [{ minimum: Infinity }] })).toThrow("constraints")
})

test("provider text patterns preserve complete paths and multiline prose with full-string decoders", () => {
  for (const schema of [actions.forge_read_file, actions.forge_finish, Written]) {
    const converted = structured(Schema.toStandardJSONSchemaV1(Schema.toStandardSchemaV1(schema))["~standard"].jsonSchema.input({ target: "draft-07" }))
    const patterns = new Set<string>()
    JSON.stringify(converted, (key, value: unknown) => {
      if (key === "pattern" && typeof value === "string") patterns.add(value)
      return value
    })
    expect(patterns.has("\\S")).toBe(false)
    expect(patterns.has("^[\\s\\S]*\\S[\\s\\S]*$")).toBe(true)
  }
  const input = { type: "string", allOf: [{ pattern: "\\S" }, { maxLength: 4000 }] }
  const converted = decode(Schema.Struct({ pattern: Schema.String, maxLength: Schema.Number }), structured(input))
  expect(converted.maxLength).toBe(4000)
  expect(input.allOf.at(0)?.pattern).toBe("\\S")
  const pattern = new RegExp(converted.pattern)
  for (const text of ["", " ", "\n\t", "\u00a0", "p", "packages/example/src/backend.ts", "first line\nsecond line", " \nKeep scope.\n "]) {
    expect(pattern.test(text)).toBe(/\S/.test(text))
    if (/\S/.test(text)) expect(pattern.exec(text)?.at(0)).toBe(text)
  }
})
