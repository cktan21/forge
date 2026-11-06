import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { store, type Query } from "@kilocode/forge"
import { setImmediate as immediate } from "node:timers/promises"
import { writer } from "./writer"

async function reader(filename: string) {
  if (typeof Bun !== "undefined") {
    const { Database } = await import("bun:sqlite")
    const db = new Database(filename, { readonly: true, create: false })
    return {
      all: (query: Query) =>
        db.query<Record<string, unknown>, (string | number | null)[]>(query.text).all(...(query.values ?? [])),
      close: () => db.close(),
    }
  }
  const { DatabaseSync } = await import("node:sqlite")
  const db = new DatabaseSync(filename, { readOnly: true })
  return {
    all: (query: Query) => db.prepare(query.text).all(...(query.values ?? [])),
    close: () => db.close(),
  }
}

export const storage = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const databases = yield* db.all<{ name: string; file: string }>("PRAGMA database_list").pipe(Effect.orDie)
  const mode = yield* db.all<{ journal_mode: string }>("PRAGMA journal_mode").pipe(Effect.orDie)
  const filename = databases.find((item) => item.name === "main")?.file
  // WAL readers see the last committed generation without joining the writer's
  // semaphore. Memory/non-WAL databases must retain the shared connection.
  const connection =
    filename && mode.at(0)?.journal_mode === "wal"
      ? yield* Effect.acquireRelease(
          Effect.promise(() => reader(filename)),
          (connection) => Effect.sync(() => connection.close()),
        )
      : undefined
  const worker =
    connection && filename && typeof Bun !== "undefined"
      ? yield* Effect.acquireRelease(
          Effect.promise(() => writer(filename)),
          (worker) => Effect.promise(() => worker.close()),
        )
      : undefined
  const context = yield* Effect.context()
  const run = Effect.runPromiseWith(context)
  // Keep SQL and values separate: SQLite must distinguish placeholders from quoted '?'.
  // The host client also honors the connection lease provided by db.transaction.
  return store({
    all: (query) =>
      connection
        ? Promise.resolve().then(() => connection.all(query))
        : run(db.$client.unsafe<Record<string, unknown>>(query.text, query.values).withoutTransform).then((rows) => [
            ...rows,
          ]),
    // The empty deferred host transaction owns Kilo's connection semaphore,
    // without taking a SQLite read/write lock. Keep that lease until the worker
    // commits or rolls back, including when the calling fiber is interrupted.
    batch: (queries) =>
      worker
        ? run(db.transaction(() => Effect.promise(() => worker.batch(queries)).pipe(Effect.uninterruptible)))
        : run(
            db.transaction(() =>
              Effect.forEach(queries, (query, index) =>
                db.$client
                  .unsafe(query.text, query.values)
                  .withoutTransform.pipe(
                    Effect.andThen(index % 16 === 15 ? Effect.promise(() => immediate()) : Effect.void),
                  ),
              ).pipe(Effect.asVoid),
            ),
          ),
  })
})
