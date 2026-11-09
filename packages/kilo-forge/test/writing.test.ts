import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Schema } from "effect"
import { engine, type Ports } from "../src/engine"
import { store } from "../src/store"
import { decode, usage } from "../src/schema"
import { hash, tokens } from "../src/util"
import { compose, type Write, type Written } from "../src/writing"

function written(input: Write): Written {
  return {
    objective: "Prevent duplicate entries without changing the public API.",
    basis: "The inspected append path does not reject duplicate identifiers. Runtime reproduction remains pending.",
    changes: ["Add a duplicate-identifier guard and a proposed regression test."],
    constraints: ["Preserve the existing public API."],
    verification: ["Proposed: test a repeated identifier and distinct identifiers."],
    evidence: input.record.sources.map((item) => item.id),
    requirements: input.record.requirements.map((item) => item.id),
  }
}

async function fixture(write?: Ports["write"], session = "chat") {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "forge-writing-")))
  await mkdir(path.join(root, ".kilo"))
  await writeFile(path.join(root, ".kilo/forge.jsonc"), '{"investigation":true}')
  await writeFile(path.join(root, "queue.ts"), "const queue: string[] = []\nexport const enqueue = (id: string) => queue.push(id)\n")
  const db = new Database(":memory:")
  const storage = store({
    all: async (query) => db.query<Record<string, unknown>, (string | number | null)[]>(query.text).all(...query.values ?? []),
    batch: async (queries) => { db.transaction(() => { for (const query of queries) db.query(query.text).run(...query.values ?? []) })() },
  })
  const calls: Write[] = []
  const model = { providerID: "fixture", modelID: "model" }
  const api = engine({
    root, store: storage, resolve: async () => model, complete: async () => { throw new Error("Legacy enhancer must not run") },
    turn: async (input) => {
      const observed = input.observations.at(0)
      const source = observed ? decode(Schema.Struct({ source: Schema.Struct({ id: Schema.String }) }), JSON.parse(observed.output)).source : undefined
      return {
        bytes: tokens(JSON.stringify({ system: input.system, input: input.input, observations: input.observations })) + 100,
        usage: usage("fixture/model"),
        calls: source ? [{
          id: "finish", name: "forge_finish", input: {
            intent: "Fix duplicate queue entries.", summary: "Review the findings before writing a prompt.",
            findings: [
              { title: "Guard duplicate identifiers", kind: "defect", support: "observed", explanation: "The append path has no duplicate check.", benefit: "Avoid duplicated work.", evidence: [source.id], counterevidence: [], unknowns: [], action: "Add a guard.", verification: ["Proposed: regression for repeated identifiers."] },
              { title: "UNSELECTED_REFACTOR_CANARY", kind: "improvement", support: "inferred", explanation: "A broader redesign might help.", benefit: "Potential maintainability.", evidence: [source.id], counterevidence: [], unknowns: ["Not necessary for the defect."], action: "Investigate an optional redesign.", verification: ["Compare behavior before changing architecture."] },
            ], questions: [], limitations: ["No tests were executed."],
          },
        }] : [{ id: "read", name: "forge_read_file", input: { path: "queue.ts" } }],
      }
    },
    write: async (input) => {
      calls.push(input)
      if (write) return write(input)
      return { text: JSON.stringify(written(input)), usage: { ...usage("fixture/model"), input: 20, output: 10, measured: true } }
    },
  })
  const investigation = await api.investigate({ key: randomUUID(), text: "Fix queue duplicates. Preserve the public API.", answers: "Keep insertion order.", session, model })
  const input = { key: randomUUID(), investigation: investigation.id, revision: investigation.revision, session, selected: [investigation.findings.at(0)!.id] }
  return { root, api, storage, investigation, input, calls, async [Symbol.asyncDispose]() { await api.dispose(); db.close(); await rm(root, { recursive: true, force: true }) } }
}

test("direction selection is explicit and the writer receives only chosen findings", async () => {
  await using f = await fixture()
  const direction = await f.api.chooseDirection(f.input)
  expect(direction.state).toBe("selected")
  expect(f.calls).toEqual([])
  const input = { id: direction.id, revision: direction.revision, key: randomUUID(), session: "chat" }
  const ready = await f.api.writePrompt(input)
  expect(ready.state).toBe("ready")
  expect(f.calls).toHaveLength(1)
  expect(f.calls.at(0)?.input).not.toContain("UNSELECTED_REFACTOR_CANARY")
  expect(f.calls.at(0)?.input).not.toContain("queue.push(id)")
  expect(ready.prompt).toContain("Preserve the public API.")
  expect(ready.prompt).toContain("Keep insertion order.")
  expect(ready.prompt).toContain("queue.ts:1")
  expect(ready.prompt).not.toContain("<forge-evidence>")
  expect(ready.prompt).not.toContain("queue.push(id)")
  expect(ready.hash).toBe(hash(ready.prompt))
  expect(await f.api.writePrompt(input)).toEqual(ready)
  expect(f.calls).toHaveLength(1)
})

test("direction and prompt revisions reject forged findings and stale inputs", async () => {
  await using f = await fixture()
  await expect(f.api.chooseDirection({ ...f.input, selected: ["made-up"] })).rejects.toThrow("unavailable")
  await expect(f.api.chooseDirection({ ...f.input, revision: randomUUID() })).rejects.toThrow("changed")
  await expect(f.api.chooseDirection({ ...f.input, selected: [] })).rejects.toThrow("Select")
  await expect(f.api.chooseDirection({ ...f.input, feedback: "Change a different subsystem instead" })).rejects.toThrow("Investigate updated feedback")
  const direction = await f.api.chooseDirection(f.input)
  await expect(f.api.writePrompt({ id: direction.id, revision: randomUUID(), key: randomUUID(), session: "chat" })).rejects.toThrow("revision")
  await expect(f.api.preparedPrompt(direction.id, "other")).rejects.toThrow("unavailable")
  expect(f.calls).toEqual([])
})

test("opening an interrupted writer preserves direction and requires an explicit retry", async () => {
  await using f = await fixture()
  const record = await f.api.chooseDirection(f.input)
  await f.storage.preparedSave({ ...record, state: "writing", revision: randomUUID(), attempt: randomUUID(), origin: record.revision }, record.revision)
  const restored = await f.api.preparedPrompt(record.id, "chat")
  expect(restored.state).toBe("interrupted")
  expect(restored.requirements).toEqual(record.requirements)
  expect(f.calls).toEqual([])
  const ready = await f.api.writePrompt({ id: restored.id, revision: restored.revision, key: randomUUID(), session: "chat" })
  expect(ready.state).toBe("ready")
  expect(f.calls).toHaveLength(1)
})

test("writer validation keeps requirements and opposing evidence mandatory", async () => {
  await using f = await fixture()
  const direction = await f.api.chooseDirection(f.input)
  const value = written({ record: direction, input: "", system: "", check: async () => {}, signal: new AbortController().signal })
  expect(() => compose({ ...value, requirements: [] }, direction)).toThrow("requirements")
  expect(() => compose({ ...value, evidence: [] }, direction)).toThrow("evidence")
  expect(() => compose({ ...value, evidence: ["invented"] }, direction)).toThrow("evidence")
  expect(() => compose({ ...value, verification: [] }, direction)).toThrow("verification")
})

test("changed sources block writing without another model call", async () => {
  await using f = await fixture()
  const direction = await f.api.chooseDirection(f.input)
  await writeFile(path.join(f.root, "queue.ts"), "export const enqueue = (id: string) => id")
  await expect(f.api.writePrompt({ id: direction.id, revision: direction.revision, key: randomUUID(), session: "chat" })).rejects.toThrow()
  expect(f.calls).toEqual([])
})

test("human edits get a new digest without losing source restrictions", async () => {
  await using f = await fixture()
  const direction = await f.api.chooseDirection(f.input)
  const ready = await f.api.writePrompt({ id: direction.id, revision: direction.revision, key: randomUUID(), session: "chat" })
  const text = `${ready.prompt}\n\nAlso preserve empty input behavior.`
  const edited = await f.api.editPrompt({ id: ready.id, revision: ready.revision, session: "chat", text })
  expect(edited.prompt).toBe(text)
  expect(edited.hash).toBe(hash(text))
  expect(edited.revision).not.toBe(ready.revision)
  expect(edited.sources).toEqual(ready.sources)
  await expect(f.api.editPrompt({ id: ready.id, revision: ready.revision, session: "chat", text })).rejects.toThrow("changed")
  expect(f.calls).toHaveLength(1)
})

test("malformed writer output fails without falling back to a fabricated prompt", async () => {
  await using f = await fixture(async () => ({ text: "not JSON", usage: usage("fixture") }))
  const direction = await f.api.chooseDirection(f.input)
  await expect(f.api.writePrompt({ id: direction.id, revision: direction.revision, key: randomUUID(), session: "chat" })).rejects.toThrow()
  expect((await f.storage.prepared(f.root, "chat", direction.id))?.state).toBe("failed")
  expect((await f.storage.prepared(f.root, "chat", direction.id))?.prompt).toBe("")
  expect(f.calls).toHaveLength(1)
})

test("coding handoff retains evidence restrictions across subsequent requests", async () => {
  await using f = await fixture()
  const direction = await f.api.chooseDirection(f.input)
  const ready = await f.api.writePrompt({ id: direction.id, revision: direction.revision, key: randomUUID(), session: "chat" })
  const model = ready.model
  expect(await f.api.handoff("chat", model)).toEqual([])
  await f.api.bindPrompt({
    binding: { id: ready.id, revision: ready.revision, hash: ready.hash, session: ready.session },
    text: ready.prompt, session: "chat", model,
  })
  expect(await f.api.handoff("chat", model)).toEqual([...ready.dependencies])
  await expect(f.api.handoff("chat", { providerID: "other", modelID: "model" })).rejects.toThrow("provider")
  expect(await f.api.handoff("other", model)).toEqual([])
  await writeFile(path.join(f.root, "queue.ts"), "export const enqueue = () => []")
  await expect(f.api.handoff("chat", model)).rejects.toThrow()
  expect(await f.api.codingContext("chat", model)).toEqual([...ready.dependencies])
  await rm(path.join(f.root, "queue.ts"))
  expect(await f.api.codingContext("chat", model)).toEqual([...ready.dependencies])
  await writeFile(path.join(f.root, ".gitignore"), "queue.ts\n")
  await expect(f.api.codingContext("chat", model)).rejects.toThrow("ignored")
})

test("workspace drafts bind explicitly and idempotently to a chat without moving private preparations", async () => {
  await using f = await fixture(undefined, "")
  const direction = await f.api.chooseDirection(f.input)
  const ready = await f.api.writePrompt({ id: direction.id, revision: direction.revision, key: randomUUID() })
  const input = {
    binding: { id: ready.id, revision: ready.revision, hash: ready.hash, session: "" },
    text: ready.prompt, session: "chat", model: ready.model,
  }
  const bound = await f.api.bindPrompt(input)
  expect(bound.session).toBe("chat")
  expect(bound.scope).toBe("")
  expect(bound.revision).not.toBe(ready.revision)
  expect(await f.api.bindPrompt(input)).toEqual(bound)
  expect(await f.api.handoff("chat", ready.model)).toEqual([...ready.dependencies])
  await expect(f.api.bindPrompt({
    ...input, session: "other", binding: { id: bound.id, revision: bound.revision, hash: bound.hash, session: "chat" },
  })).rejects.toThrow("different session")
})

test("purged preparation identities cannot be reused to bypass session provenance", async () => {
  await using f = await fixture()
  const direction = await f.api.chooseDirection(f.input)
  const ready = await f.api.writePrompt({ id: direction.id, revision: direction.revision, key: randomUUID(), session: "chat" })
  await f.api.bindPrompt({
    binding: { id: ready.id, revision: ready.revision, hash: ready.hash, session: "chat" },
    text: ready.prompt, session: "chat", model: ready.model,
  })
  const item = await f.api.register({ kind: "text", label: "Purge target", location: "", content: "Temporary source" })
  await f.api.purge(item.id)
  await expect(f.api.handoff("chat", ready.model)).rejects.toThrow("unavailable")
  await expect(f.api.codingContext("chat", ready.model)).rejects.toThrow("unavailable")
  await expect(f.storage.preparedSave({ ...ready, revision: randomUUID() })).rejects.toThrow()
})

test("explicit edits survive rewriting and further investigation without promoting unchanged AI text", async () => {
  await using f = await fixture()
  const direction = await f.api.chooseDirection(f.input)
  const ready = await f.api.writePrompt({ id: direction.id, revision: direction.revision, key: randomUUID(), session: "chat" })
  const edited = await f.api.editPrompt({
    id: ready.id, revision: ready.revision, session: "chat",
    text: `${ready.prompt}\nUser requirement: keep empty input behavior unchanged.`,
  })
  expect(edited.edits).toEqual([{ before: "", after: "User requirement: keep empty input behavior unchanged." }])
  const previous = { id: edited.id, revision: edited.revision, session: "chat" }
  const selected = await f.api.chooseDirection({ ...f.input, key: randomUUID(), previous })
  const rewritten = await f.api.writePrompt({ id: selected.id, revision: selected.revision, key: randomUUID(), session: "chat" })
  expect(rewritten.prompt).toContain("keep empty input behavior unchanged")
  const amendment = selected.requirements.find((item) => item.label === "Explicit user edits")!
  expect(amendment.text).not.toContain("The inspected append path")
  const next = await f.api.investigate({
    key: randomUUID(), text: f.investigation.original, session: "chat", model: ready.model,
    previous, feedback: "Check the callers too.",
  })
  expect(next.edits).toEqual(edited.edits)
  expect(next.dependencies).toEqual(edited.dependencies)
  const final = await f.api.chooseDirection({
    key: randomUUID(), investigation: next.id, revision: next.revision, session: "chat", selected: [next.findings.at(0)!.id],
  })
  expect(final.requirements.some((item) => item.text.includes("keep empty input behavior unchanged"))).toBe(true)
})
