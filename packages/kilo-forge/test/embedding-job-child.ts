import { Database } from "bun:sqlite"
import path from "node:path"
import { Schema } from "effect"
import { decode } from "../src/schema"
import { store } from "../src/store"
import { knowledge } from "../src/knowledge"
import { embeddings } from "../src/embeddings"

const input = decode(
  Schema.Struct({ root: Schema.String, collection: Schema.String, endpoint: Schema.String }),
  JSON.parse(process.env.FORGE_JOB_FIXTURE ?? "{}"),
)
const db = new Database(path.join(input.root, "state.sqlite"))
const storage = store({
  all: async (query) =>
    db.query<Record<string, unknown>, (string | number | null)[]>(query.text).all(...(query.values ?? [])),
  batch: async (queries) =>
    db.transaction(() => {
      for (const query of queries) db.query(query.text).run(...(query.values ?? []))
    })(),
})
const library = knowledge(input.root, storage)
const api = embeddings({
  root: input.root,
  store: storage,
  library,
  configuration: async () => ({ endpoint: input.endpoint, model: "fixture", dimensions: 2 }),
  authorize: async () => undefined,
})
await api.jobs.start(input.collection)
// The parent kills this process while its real embedding HTTP request is held.
await Promise.withResolvers<void>().promise
