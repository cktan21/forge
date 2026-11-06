import { decode, EmbeddingObservation } from "./schema"
import type { Query } from "./store"

const timestamp = "CAST(strftime('%s','now') AS INTEGER) * 1000"
const kinds = "'embedding-attempt','collection','policy','embedding-consent','purge-epoch'"

export function tracking(): Query[] {
  return [
    {
      text: "CREATE TABLE IF NOT EXISTS forge_embedding_history (workspace TEXT PRIMARY KEY NOT NULL, revision TEXT NOT NULL, since INTEGER NOT NULL, deleted INTEGER NOT NULL)",
    },
    {
      text: `INSERT OR IGNORE INTO forge_embedding_history(workspace,revision,since,deleted) SELECT r.workspace,lower(hex(randomblob(16))),${timestamp},max(r.kind = 'purge-epoch' AND r.body <> '"initial"') FROM (SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM forge_records WHERE workspace = '' AND kind = 'embedding-history-index' AND id = 'current')) pending CROSS JOIN forge_records r GROUP BY r.workspace`,
    },
    {
      text: "INSERT OR IGNORE INTO forge_records(workspace,kind,id,body,updated) VALUES('','embedding-history-index','current','1',0)",
    },
    ...(["INSERT", "UPDATE", "DELETE"] as const).map((event): Query => {
      const row = event === "DELETE" ? "OLD" : "NEW"
      const deleted =
        event === "DELETE"
          ? `${row}.kind = 'embedding-attempt'`
          : `${row}.kind = 'purge-epoch' AND ${row}.body <> '"initial"'`
      return {
        // Triggers cover other connections and legacy writers in the same database.
        // INSERT ... SELECT avoids inheriting a caller's OR REPLACE conflict policy.
        text: `CREATE TRIGGER IF NOT EXISTS forge_embedding_history_${event.toLowerCase()} AFTER ${event} ON forge_records WHEN ${row}.kind IN (${kinds})${event === "UPDATE" ? " AND NEW.body IS NOT OLD.body" : ""} BEGIN
          INSERT INTO forge_embedding_history(workspace,revision,since,deleted) SELECT ${row}.workspace,lower(hex(randomblob(16))),${timestamp},0 WHERE NOT EXISTS (SELECT 1 FROM forge_embedding_history WHERE workspace = ${row}.workspace);
          UPDATE forge_embedding_history SET revision = lower(hex(randomblob(16))),deleted = max(deleted,${deleted}) WHERE workspace = ${row}.workspace;
        END`,
      }
    }),
  ]
}

export function track(root: string): Query {
  return {
    text: `INSERT INTO forge_embedding_history(workspace,revision,since,deleted) SELECT ?,lower(hex(randomblob(16))),${timestamp},0 WHERE NOT EXISTS (SELECT 1 FROM forge_embedding_history WHERE workspace = ?)`,
    values: [root, root],
  }
}

export function observed(row: Record<string, unknown> | undefined) {
  if (!row) throw new Error("Embedding usage observation is unavailable")
  return decode(EmbeddingObservation, {
    revision: row.revision,
    since: row.since,
    before: "unknown",
    deleted: row.deleted === 1,
  })
}
