import { decode, RequestObservation } from "./schema"
import type { Query } from "./store"

const timestamp = "CAST(strftime('%s','now') AS INTEGER) * 1000"

export function tracking(): Query[] {
  return [
    {
      text: "CREATE TABLE IF NOT EXISTS forge_request_history (workspace TEXT PRIMARY KEY NOT NULL, revision TEXT NOT NULL, since INTEGER NOT NULL, deleted INTEGER NOT NULL, admitted INTEGER NOT NULL)",
    },
    {
      text: `INSERT OR IGNORE INTO forge_request_history(workspace,revision,since,deleted,admitted) SELECT r.workspace,lower(hex(randomblob(16))),${timestamp},max(r.kind = 'purge-epoch' AND r.body <> '"initial"'),sum(r.kind = 'request') FROM (SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM forge_records WHERE workspace = '' AND kind = 'request-history-index' AND id = 'current')) pending CROSS JOIN forge_records r GROUP BY r.workspace`,
    },
    {
      text: "INSERT OR IGNORE INTO forge_records(workspace,kind,id,body,updated) VALUES('','request-history-index','current','1',0)",
    },
    {
      // BEFORE INSERT still sees the old row for legacy INSERT OR REPLACE writers.
      text: `CREATE TRIGGER IF NOT EXISTS forge_request_history_admit BEFORE INSERT ON forge_records WHEN NEW.kind = 'request' AND NOT EXISTS (SELECT 1 FROM forge_records WHERE workspace = NEW.workspace AND kind = NEW.kind AND id = NEW.id) BEGIN
        INSERT INTO forge_request_history(workspace,revision,since,deleted,admitted) SELECT NEW.workspace,lower(hex(randomblob(16))),${timestamp},0,0 WHERE NOT EXISTS (SELECT 1 FROM forge_request_history WHERE workspace = NEW.workspace);
        UPDATE forge_request_history SET admitted = admitted + 1 WHERE workspace = NEW.workspace;
      END`,
    },
    ...(["INSERT", "UPDATE", "DELETE"] as const).map((event): Query => {
      const row = event === "DELETE" ? "OLD" : "NEW"
      const deleted =
        event === "DELETE" ? `${row}.kind = 'request'` : `${row}.kind = 'purge-epoch' AND ${row}.body <> '"initial"'`
      return {
        text: `CREATE TRIGGER IF NOT EXISTS forge_request_history_${event.toLowerCase()} AFTER ${event} ON forge_records WHEN ${row}.kind IN ('request','purge-epoch')${event === "UPDATE" ? " AND NEW.body IS NOT OLD.body" : ""} BEGIN
          INSERT INTO forge_request_history(workspace,revision,since,deleted,admitted) SELECT ${row}.workspace,lower(hex(randomblob(16))),${timestamp},0,0 WHERE NOT EXISTS (SELECT 1 FROM forge_request_history WHERE workspace = ${row}.workspace);
          UPDATE forge_request_history SET revision = lower(hex(randomblob(16))),deleted = max(deleted,${deleted}) WHERE workspace = ${row}.workspace;
        END`,
      }
    }),
  ]
}

export function track(root: string): Query {
  return {
    text: `INSERT INTO forge_request_history(workspace,revision,since,deleted,admitted) SELECT ?,lower(hex(randomblob(16))),${timestamp},0,0 WHERE NOT EXISTS (SELECT 1 FROM forge_request_history WHERE workspace = ?)`,
    values: [root, root],
  }
}

export function observed(row: Record<string, unknown> | undefined) {
  if (!row) throw new Error("Request history observation is unavailable")
  return decode(RequestObservation, {
    revision: row.revision,
    since: row.since,
    before: "unknown",
    deleted: row.deleted === 1,
    admitted: row.admitted,
  })
}
