import { Database } from "bun:sqlite"
import type { Query } from "@kilocode/forge"

let db: Database | undefined

onmessage = (event: MessageEvent<{ id: number; file?: string; queries?: readonly Query[]; start?: boolean; finish?: boolean; rollback?: boolean; close?: boolean }>) => {
  const message = event.data
  try {
    if (message.file) {
      if (db) throw new Error("Forge writer is already open")
      db = new Database(message.file, { create: false, readwrite: true })
      db.run("PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL; PRAGMA cache_size=-64000; PRAGMA foreign_keys=ON")
      postMessage({ id: message.id })
      return
    }
    if (message.close) {
      db?.close()
      db = undefined
      postMessage({ id: message.id })
      return
    }
    if (!db) throw new Error("Forge writer is not open")
    if (message.rollback) {
      if (db.inTransaction) db.run("ROLLBACK")
      postMessage({ id: message.id })
      return
    }
    try {
      if (message.start) db.run("BEGIN IMMEDIATE")
      if (!db.inTransaction) throw new Error("Forge publication transaction is not open")
      for (const query of message.queries ?? []) {
        const statement = db.prepare(query.text)
        try { statement.run(...query.values ?? []) } finally { statement.finalize() }
      }
      if (message.finish) db.run("COMMIT")
    } catch (err) {
      if (db.inTransaction) db.run("ROLLBACK")
      throw err
    }
    postMessage({ id: message.id })
  } catch (err) {
    postMessage({ id: message.id, error: err instanceof Error ? err.message : String(err) })
  }
}
