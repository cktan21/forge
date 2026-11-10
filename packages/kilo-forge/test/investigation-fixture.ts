import { Database } from "bun:sqlite"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Schema } from "effect"
import { engine, type Ports } from "../src/engine"
import { store } from "../src/store"
import type { Call, Turn } from "../src/investigation"
import { tokens } from "../src/util"
import { decode, usage } from "../src/schema"

export const model = { providerID: "local", modelID: "fixture" }

export function result(input: Turn, calls: Call[]) {
  return {
    calls,
    bytes: tokens(JSON.stringify({ system: input.system, input: input.input, observations: input.observations })) + 500,
    usage: { ...usage("local/fixture"), input: 10, output: 5, measured: true },
  }
}

export function conclusion(evidence: string[] = []) {
  return {
    intent: "Prevent duplicate queue entries",
    summary: "The queue needs a scoped deduplication change.",
    findings: evidence.length
      ? [
          {
            title: "Repeated enqueue is not guarded",
            kind: "defect",
            support: "observed",
            explanation: "Enqueue appends without checking the identifier.",
            benefit: "Prevent duplicate work.",
            evidence,
            counterevidence: [],
            unknowns: [],
            action: "Guard duplicate identifiers.",
            verification: ["Add a regression for repeated enqueue."],
          },
        ]
      : [],
    questions: [],
    limitations: ["Runtime tests have not been executed."],
  }
}

export async function fixture(turn?: Ports["turn"], opts: Partial<Ports> = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "forge-investigate-")))
  await mkdir(path.join(root, ".kilo"))
  await writeFile(path.join(root, ".kilo/forge.jsonc"), '{"investigation":true}')
  await writeFile(
    path.join(root, "queue.ts"),
    "const queue: string[] = []\nexport function enqueue(id: string) { queue.push(id) }\n",
  )
  await writeFile(
    path.join(root, "caller.ts"),
    'import { enqueue } from "./queue"\nexport function retry(id: string) { enqueue(id) }\n',
  )
  const db = new Database(":memory:")
  const storage = store({
    all: async (query) =>
      db.query<Record<string, unknown>, (string | number | null)[]>(query.text).all(...(query.values ?? [])),
    batch: async (queries) => {
      db.transaction(() => {
        for (const query of queries) db.query(query.text).run(...(query.values ?? []))
      })()
    },
  })
  const calls: Turn[] = []
  const ports: Ports = {
    ...opts,
    root,
    store: storage,
    resolve: async () => model,
    destination: async () => ({ fingerprint: "local-route", origins: [] }),
    complete: async () => {
      throw new Error("Legacy rewrite must not run")
    },
    turn: async (input) => {
      calls.push(input)
      if (turn) return turn(input)
      if (calls.length === 1)
        return result(input, [{ id: "search", name: "forge_search_code", input: { query: "enqueue queue" } }])
      if (calls.length === 2)
        return result(input, [{ id: "read", name: "forge_read_file", input: { path: "queue.ts" } }])
      const source = decode(
        Schema.Struct({ source: Schema.Struct({ id: Schema.String }) }),
        JSON.parse(input.observations.at(-1)!.output),
      ).source
      return result(input, [{ id: "finish", name: "forge_finish", input: conclusion([source.id]) }])
    },
  }
  const api = engine(ports)
  return {
    root,
    storage,
    api,
    ports,
    calls,
    async [Symbol.asyncDispose]() {
      await api.dispose()
      db.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}
