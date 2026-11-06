import { Snapshot, Opportunity, Manifest, Source, Inventory, RequestInfo, Relation, Collection, Policy, ImportInfo, ImportFile, decode, type ImportRun, type ImportHistory, type Match, type View } from "./schema"
import { keywords, hash } from "./util"
import { randomUUID } from "node:crypto"
import { AsyncLocalStorage } from "node:async_hooks"
import { isDeepStrictEqual } from "node:util"
import { pack, unpack } from "./snapshot"
import { checkpoint } from "./cooperate"
import type { Change } from "./schema"
import { ordering } from "./order"
import { Grant } from "./embedding-consent"
import { EmbeddingJob, EmbeddingAttempt, type EmbeddingLedger } from "./schema"
import { consistent } from "./embedding-usage"
import { tracking, track, observed } from "./embedding-observation"
import * as requests from "./request-observation"
import { classification } from "./references"

export type Value = string | number | null
export type Query = { text: string; values?: readonly Value[] }
export type SQL = {
  all(query: Query): Promise<Array<Record<string, unknown>>>
  batch(queries: readonly Query[]): Promise<void>
}

function health(collections: readonly Collection[]) {
  const waiting = collections.filter((item) => item.approved && item.state === "registered" && item.generation !== "unindexed").length
  const indexing = collections.filter((item) => item.state === "indexing").length
  const failed = collections.filter((item) => item.state === "failed").length
  return [
    ...(waiting ? [`${waiting} document collection(s) awaiting refresh. Inspect the knowledge library for details.`] : []),
    ...(indexing ? [`${indexing} document collection(s) indexing in the background. Inspect the knowledge library for progress.`] : []),
    ...(failed ? [`${failed} document collection(s) unavailable after a failed job. Inspect the knowledge library to retry.`] : []),
  ]
}

export function store(sql: SQL) {
  const context = new AsyncLocalStorage<{ root: string; epoch: string }>()
  const listeners = new Map<string, Set<(change: Change) => void>>()
  function changed(root: string, topic: Change["topic"], session = "") {
    const change = { topic, session, revision: randomUUID() }
    for (const listener of listeners.get(root) ?? []) {
      try { listener(change) } catch { console.warn("Forge change subscriber failed") }
    }
  }
  const ready = sql.batch([
    { text: "CREATE TABLE IF NOT EXISTS forge_records (workspace TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY(workspace, kind, id))" },
    { text: "CREATE TABLE IF NOT EXISTS forge_sources (workspace TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(workspace, id))" },
    { text: "CREATE INDEX IF NOT EXISTS forge_sources_page ON forge_sources(workspace, (json_extract(body, '$.method') = 'file' OR json_extract(body, '$.kind') = 'directory') DESC, id)" },
    { text: "CREATE INDEX IF NOT EXISTS forge_sources_collection ON forge_sources(workspace, json_extract(body, '$.detail.collection'), id) WHERE json_extract(body, '$.detail.collection') IS NOT NULL" },
    { text: "CREATE INDEX IF NOT EXISTS forge_sources_document ON forge_sources(workspace, json_extract(body, '$.detail.collection'), json_extract(body, '$.detail.document'), id) WHERE json_extract(body, '$.detail.collection') IS NOT NULL AND json_extract(body, '$.detail.document') IS NOT NULL" },
    { text: "CREATE INDEX IF NOT EXISTS forge_import_runs ON forge_records(workspace, json_extract(body, '$.collection'), json_extract(body, '$.started') DESC, id) WHERE kind = 'import'" },
    { text: "CREATE INDEX IF NOT EXISTS forge_embedding_attempts ON forge_records(workspace, json_extract(body, '$.session')) WHERE kind = 'embedding-attempt'" },
    { text: "CREATE TABLE IF NOT EXISTS forge_relations (workspace TEXT NOT NULL, id TEXT NOT NULL, source TEXT NOT NULL, target TEXT NOT NULL, position INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(workspace, id))" },
    { text: "CREATE INDEX IF NOT EXISTS forge_relations_source ON forge_relations(workspace, source, target)" },
    { text: "CREATE INDEX IF NOT EXISTS forge_relations_target ON forge_relations(workspace, target, source)" },
    { text: "INSERT OR REPLACE INTO forge_relations(workspace,id,source,target,position,body) SELECT r.workspace,json_extract(e.value,'$.id'),json_extract(e.value,'$.from'),json_extract(e.value,'$.to'),CAST(e.key AS INTEGER),e.value FROM forge_records r, json_each(r.body,'$.relations') e WHERE r.kind = 'snapshot' AND r.id = 'current' AND NOT EXISTS (SELECT 1 FROM forge_records m WHERE m.workspace = r.workspace AND m.kind = 'relation-index' AND m.id = 'current')" },
    { text: "INSERT OR IGNORE INTO forge_records(workspace,kind,id,body,updated) SELECT r.workspace,'relation-index','current','1',r.updated FROM forge_records r WHERE r.kind = 'snapshot' AND r.id = 'current' AND NOT EXISTS (SELECT 1 FROM forge_records m WHERE m.workspace = r.workspace AND m.kind = 'relation-index' AND m.id = 'current')" },
    { text: "CREATE VIRTUAL TABLE IF NOT EXISTS forge_search USING fts5(workspace UNINDEXED, id UNINDEXED, path, content, tokenize='porter unicode61')" },
    { text: "CREATE TABLE IF NOT EXISTS forge_fts_rows (rowid INTEGER PRIMARY KEY, workspace TEXT NOT NULL, id TEXT NOT NULL)" },
    { text: "CREATE INDEX IF NOT EXISTS forge_fts_rows_source ON forge_fts_rows(workspace,id)" },
    // Preserve legacy FTS rowids, including duplicates. Mark even an empty database
    // so subsequent opens never traverse FTS metadata to check for migration work.
    { text: "DELETE FROM forge_fts_rows WHERE rowid IN (SELECT r.rowid FROM (SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM forge_records WHERE workspace = '' AND kind = 'search-index' AND id = 'current')) pending CROSS JOIN forge_fts_rows r)" },
    { text: "INSERT OR REPLACE INTO forge_fts_rows(rowid,workspace,id) SELECT f.rowid,f.workspace,f.id FROM (SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM forge_records WHERE workspace = '' AND kind = 'search-index' AND id = 'current')) pending CROSS JOIN forge_search f" },
    { text: "INSERT INTO forge_records(workspace,kind,id,body,updated) SELECT '', 'search-index', 'current', '1', 0 WHERE NOT EXISTS (SELECT 1 FROM forge_records WHERE workspace = '' AND kind = 'search-index' AND id = 'current')" },
    { text: "INSERT OR IGNORE INTO forge_records(workspace,kind,id,body,updated) SELECT r.workspace,'request-info',r.id,json_object('id',r.id,'session',json_extract(r.body,'$.session'),'purpose',json_extract(r.body,'$.purpose'),'model',json_extract(r.body,'$.model'),'observed',json_extract(r.body,'$.observed'),'state',json_extract(r.body,'$.state'),'entries',json_array_length(r.body,'$.entries'),'sent',(SELECT count(*) FROM json_each(r.body,'$.entries') WHERE json_extract(value,'$.stage') = 'sent'),'usage',json(json_extract(r.body,'$.usage'))),r.updated FROM forge_records r WHERE r.kind = 'request' AND NOT EXISTS (SELECT 1 FROM forge_records m WHERE m.workspace = r.workspace AND m.kind = 'request-info' AND m.id = r.id)" },
    ...tracking(),
    ...requests.tracking(),
  ])

  async function records(root: string, kind: string, limit = 100) {
    await ready
    const rows = await sql.all({ text: "SELECT body FROM forge_records WHERE workspace = ? AND kind = ? ORDER BY updated DESC LIMIT ?", values: [root, kind, limit] })
    return rows.map((row) => JSON.parse(String(row.body)) as unknown)
  }

  async function put(root: string, kind: string, key: string, value: unknown) {
    await ready
    await commit(root, [{ text: "INSERT OR REPLACE INTO forge_records(workspace,kind,id,body,updated) VALUES(?,?,?,?,?)", values: [root, kind, key, JSON.stringify(value), Date.now()] }])
  }

  async function get(root: string, kind: string, key: string) {
    await ready
    const row = (await sql.all({ text: "SELECT body FROM forge_records WHERE workspace = ? AND kind = ? AND id = ?", values: [root, kind, key] })).at(0)
    return row ? JSON.parse(String(row.body)) as unknown : undefined
  }

  async function epoch(root: string) {
    return String(await get(root, "purge-epoch", "current") ?? "initial")
  }

  async function access(root: string, session: string, collections: readonly string[]) {
    await ready
    // Observe selected registrations and inherited policy in one statement.
    // Separate stamps let retrieval discard rejected candidates before comparison.
    const rows = await sql.all({
      text: "SELECT kind,id,body FROM forge_records WHERE workspace = ? AND kind = 'policy' AND id IN ('', ?) UNION ALL SELECT kind,id,body FROM forge_records WHERE workspace = ? AND kind IN ('collection', 'embedding-consent') AND id IN (SELECT value FROM json_each(?)) ORDER BY kind,id",
      values: [root, session, root, JSON.stringify([...new Set(collections)])],
    })
    const grants = new Map(rows.filter((row) => row.kind === "embedding-consent").map((row) => [row.id, row.body]))
    return {
      policy: hash(JSON.stringify(rows.filter((row) => row.kind === "policy").map((row) => [row.id, row.body]))),
      collections: Object.fromEntries(rows.filter((row) => row.kind === "collection").map((row) => {
        const grant = grants.get(row.id)
        return [String(row.id), hash(grant == null ? String(row.body) : JSON.stringify([row.body, grant]))]
      })),
    }
  }

  async function guard(root: string) {
    const inherited = context.getStore()
    const state = inherited?.root === root ? inherited : { root, epoch: await epoch(root) }
    const check = async () => {
      if (state.epoch !== await epoch(root)) throw new Error("Forge knowledge was purged during this operation. Start a new request.")
    }
    return {
      check,
      async run<A>(run: () => Promise<A>) {
        await check()
        const value = await context.run(state, run)
        await check()
        return value
      },
    }
  }

  async function commit(root: string, queries: readonly Query[]) {
    const state = context.getStore()
    if (state?.root !== root) return sql.batch(queries)
    // A stale revision violates body NOT NULL and rolls back the entire transaction.
    // Unlike a preceding read, this also fences a purge from another database connection.
    try {
      await sql.batch([{
        text: "INSERT INTO forge_records(workspace,kind,id,body,updated) VALUES(?,?,?,?,?) ON CONFLICT(workspace,kind,id) DO UPDATE SET body = CASE WHEN forge_records.body = excluded.body THEN forge_records.body ELSE NULL END",
        values: [root, "purge-epoch", "current", JSON.stringify(state.epoch), Date.now()],
      }, ...queries])
    } catch (err) {
      if (state.epoch !== await epoch(root)) throw new Error("Forge knowledge was purged during this operation. Start a new request.", { cause: err })
      throw err
    }
  }

  function prune(root: string): Query {
    return { text: "DELETE FROM forge_fts_rows WHERE rowid IN (SELECT rowid FROM forge_fts_rows WHERE workspace = ? AND rowid NOT IN (SELECT id FROM forge_search_docsize))", values: [root] }
  }

  async function insert(root: string, sources: readonly Source[]): Promise<Query[]> {
    // Remove deleted identities before FTS can reuse their rowids.
    const queries: Query[] = [prune(root)]
    const pause = checkpoint()
    // Bound each statement without releasing the publication transaction.
    // One Effect/database operation per source otherwise holds the shared lock
    // for seconds even when individual SQLite inserts are inexpensive.
    for (let offset = 0; offset < sources.length; offset += 200) {
      const chunk = sources.slice(offset, offset + 200)
      queries.push({
        text: "INSERT OR REPLACE INTO forge_sources(workspace,id,body) SELECT ?,json_extract(value,'$.id'),value FROM json_each(?)",
        values: [root, JSON.stringify(chunk)],
      })
      const search = chunk.filter((source) => source.status === "current").map((source) => [
        source.id,
        `${source.uri} ${source.label}`.replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("_", " "),
        source.text.replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("_", " "),
      ])
      if (search.length) queries.push({
        text: "INSERT INTO forge_search(workspace,id,path,content) SELECT ?,json_extract(value,'$[0]'),json_extract(value,'$[1]'),json_extract(value,'$[2]') FROM json_each(?)",
        values: [root, JSON.stringify(search)],
      })
      await pause()
    }
    // docsize exposes the live integer keys without reading FTS document bodies.
    // Only unprojected rows need metadata reads; the surrounding batch is atomic.
    queries.push({
      text: "INSERT INTO forge_fts_rows(rowid,workspace,id) SELECT f.rowid,f.workspace,f.id FROM (SELECT id FROM forge_search_docsize EXCEPT SELECT rowid FROM forge_fts_rows) missing CROSS JOIN forge_search f ON f.rowid = missing.id",
    })
    return queries
  }

  function journal(root: string, value: ImportRun): Query[] {
    return [
      { text: "INSERT OR REPLACE INTO forge_records(workspace,kind,id,body,updated) VALUES(?,?,?,?,?)", values: [root, "import", value.id, JSON.stringify(value), value.updated] },
      { text: "DELETE FROM forge_records WHERE workspace = ? AND kind = 'import' AND json_extract(body, '$.collection') = ? AND id NOT IN (SELECT id FROM forge_records WHERE workspace = ? AND kind = 'import' AND json_extract(body, '$.collection') = ? ORDER BY json_extract(body, '$.started') DESC, id DESC LIMIT 16)", values: [root, value.collection, root, value.collection] },
    ]
  }

  return {
    ready,
    guard,
    access,
    detached<A>(run: () => A) { return context.exit(run) },
    async fenced<A>(root: string, run: () => Promise<A>) { return (await guard(root)).run(run) },
    changed,
    subscribe(root: string, listener: (change: Change) => void) {
      const values = listeners.get(root) ?? new Set<(change: Change) => void>()
      values.add(listener)
      listeners.set(root, values)
      return () => { values.delete(listener); if (!values.size) listeners.delete(root) }
    },
    async registrations(root: string) {
      return (await records(root, "collection", -1)).map((value) => decode(Collection, value))
    },
    async collections(root: string, session = "") {
      return (await this.registrations(root)).filter((item) => !item.session || item.session === session)
    },
    async registry(root: string, opts: { session?: string; query?: string; limit?: number; offset?: number; generation?: string } = {}) {
      await ready
      const rows = await sql.all({
        text: "SELECT id FROM forge_records WHERE workspace = ? AND kind = 'collection' AND (coalesce(json_extract(body, '$.session'), '') = '' OR json_extract(body, '$.session') = ?) AND (instr(lower(json_extract(body, '$.label')), lower(?)) > 0 OR instr(lower(json_extract(body, '$.location')), lower(?)) > 0) ORDER BY id",
        values: [root, opts.session ?? "", opts.query ?? "", opts.query ?? ""],
      })
      const ids = rows.map((row) => String(row.id))
      const generation = hash(JSON.stringify([opts.session ?? "", opts.query ?? "", ids]))
      const limit = Number.isFinite(opts.limit) ? Math.min(100, Math.max(1, Math.floor(opts.limit!))) : 100
      const offset = opts.generation != null && opts.generation !== generation ? 0
        : Math.min(Math.floor(Math.max(0, ids.length - 1) / limit) * limit, Number.isFinite(opts.offset) ? Math.max(0, Math.floor(opts.offset!)) : 0)
      const selected = await sql.all({
        text: "SELECT body FROM forge_records WHERE workspace = ? AND kind = 'collection' AND id IN (SELECT value FROM json_each(?)) ORDER BY id",
        values: [root, JSON.stringify(ids.slice(offset, offset + limit))],
      })
      return {
        collections: selected.map((row) => decode(Collection, JSON.parse(String(row.body)))),
        generation,
        page: { offset, limit, total: ids.length, ...(offset + limit < ids.length ? { next: offset + limit } : {}) },
      }
    },
    async collection(root: string, key: string) {
      const value = await get(root, "collection", key)
      return value ? decode(Collection, value) : undefined
    },
    async embedding(root: string, key: string, session = "") {
      await ready
      const rows = await sql.all({
        text: "SELECT kind,body FROM forge_records WHERE workspace = ? AND id = ? AND kind IN ('collection', 'embedding-consent')",
        values: [root, key],
      })
      const body = rows.find((row) => row.kind === "collection")?.body
      if (typeof body !== "string") throw new Error("Collection is unavailable")
      const collection = decode(Collection, JSON.parse(body))
      if (collection.session && collection.session !== session) throw new Error("Collection is unavailable in this session")
      const grant = rows.find((row) => row.kind === "embedding-consent")?.body
      return { collection, body, grant: typeof grant === "string" ? grant : undefined }
    },
    async embeddingSave(root: string, key: string, session: string, expected: { body: string; grant?: string }, grant: typeof Grant.Type) {
      await ready
      const value = decode(Grant, grant)
      const collection = decode(Collection, JSON.parse(expected.body))
      // Fail atomically through the existing NOT NULL constraint on a stale
      // review. A read followed by an unconditional write can resurrect consent.
      await commit(root, [{
        text: "INSERT OR REPLACE INTO forge_records(workspace,kind,id,body,updated) VALUES(?,'embedding-consent',?,CASE WHEN EXISTS (SELECT 1 FROM forge_records WHERE workspace = ? AND kind = 'collection' AND id = ? AND body = ? AND (json_extract(body,'$.session') = '' OR json_extract(body,'$.session') = ?)) AND (SELECT body FROM forge_records WHERE workspace = ? AND kind = 'embedding-consent' AND id = ?) IS ? THEN ? ELSE NULL END,?)",
        values: [root, key, root, key, expected.body, session, root, key, expected.grant ?? null, JSON.stringify(value), Date.now()],
      }])
      changed(root, "knowledge", collection.session)
    },
    async embeddingLedger(root: string, session = "", after?: string, limit = 50): Promise<EmbeddingLedger> {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Embedding usage limit must be 1-100")
      if (after != null && (!/^[1-9]\d{0,15}$/.test(after) || !Number.isSafeInteger(Number(after))))
        throw new Error("Invalid embedding usage cursor")
      await ready
      await sql.batch([track(root)])
      // Rows and revision share one SQLite statement snapshot, including empty
      // pages. A collector can reject mixed revisions without holding a DB lock.
      const rows = await sql.all({
        text: "WITH page AS (SELECT rowid AS cursor,body FROM forge_records WHERE workspace = ? AND kind = 'embedding-attempt' AND json_extract(body,'$.session') = ?"
          + (after == null ? "" : " AND rowid < ?") + " ORDER BY rowid DESC LIMIT ?) SELECT h.revision,h.since,h.deleted,p.cursor,p.body FROM forge_embedding_history h LEFT JOIN page p ON 1 = 1 WHERE h.workspace = ? ORDER BY p.cursor DESC",
        values: [root, session, ...(after == null ? [] : [Number(after)]), limit + 1, root],
      })
      const entries = rows.filter((row) => row.body != null)
      const page = entries.slice(0, limit)
      return {
        session,
        observation: observed(rows.at(0)),
        entries: page.map((row) => decode(EmbeddingAttempt, JSON.parse(String(row.body)))),
        ...(entries.length > limit ? { next: String(page.at(-1)!.cursor) } : {}),
      }
    },
    async embeddingObservation(root: string) {
      await ready
      return observed((await sql.all({
        text: "SELECT revision,since,deleted FROM forge_embedding_history WHERE workspace = ?",
        values: [root],
      })).at(0))
    },
    async embeddingRetention(root: string, session: string, before: number, keep: number) {
      if (!Number.isSafeInteger(before) || before < 0) throw new Error("Invalid retention cutoff")
      if (!Number.isInteger(keep) || keep < 0 || keep > 1_000_000) throw new Error("Retention keep must be 0-1000000")
      await ready
      await sql.batch([track(root)])
      const rows = await sql.all({
        text: "WITH recent AS (SELECT rowid FROM forge_records WHERE workspace = ? AND kind = 'embedding-attempt' AND json_extract(body,'$.session') = ? ORDER BY rowid DESC LIMIT ?), page AS (SELECT rowid AS cursor,body FROM forge_records WHERE workspace = ? AND kind = 'embedding-attempt' AND json_extract(body,'$.session') = ? AND json_extract(body,'$.finished') < ? AND rowid NOT IN (SELECT rowid FROM recent) ORDER BY rowid ASC LIMIT 101) SELECT h.revision,h.since,h.deleted,p.cursor,p.body FROM forge_embedding_history h LEFT JOIN page p ON 1 = 1 WHERE h.workspace = ? ORDER BY p.cursor ASC",
        values: [root, session, keep, root, session, before, root],
      })
      const entries = rows.filter((row) => row.body != null)
      return {
        session, before, keep, limit: 100 as const, more: entries.length > 100,
        observation: observed(rows.at(0)),
        entries: entries.slice(0, 100).map((row) => decode(EmbeddingAttempt, JSON.parse(String(row.body)))),
      }
    },
    async embeddingPrune(root: string, session: string, revision: string, ids: readonly string[]) {
      if (!ids.length) return
      if (ids.length > 100 || new Set(ids).size !== ids.length) throw new Error("Invalid retention batch")
      await ready
      // The ledger revision also fences purge; the general write fence would
      // create an initial purge epoch and invalidate this reviewed revision.
      await sql.batch([{
        // A stale or missing history row fails NOT NULL inside the deletion
        // transaction, including writes admitted through another connection.
        text: "INSERT INTO forge_embedding_history(workspace,revision,since,deleted) SELECT ?,CASE WHEN EXISTS (SELECT 1 FROM forge_embedding_history WHERE workspace = ? AND revision = ?) THEN ? ELSE NULL END,0,0 ON CONFLICT(workspace) DO NOTHING",
        values: [root, root, revision, revision],
      }, {
        text: "DELETE FROM forge_records WHERE workspace = ? AND kind = 'embedding-attempt' AND id IN (SELECT value FROM json_each(?)) AND json_extract(body,'$.session') = ? AND json_extract(body,'$.finished') IS NOT NULL",
        values: [root, JSON.stringify(ids), session],
      }])
      changed(root, "knowledge", session)
    },
    async embeddingAttemptSave(root: string, input: EmbeddingAttempt, previous?: EmbeddingAttempt) {
      await ready
      const value = decode(EmbeddingAttempt, input)
      if (!value.collections.length || value.collections.length > 100 || new Set(value.collections).size !== value.collections.length)
        throw new Error("Invalid embedding attempt collection scope")
      if (!consistent(value.usage) || value.usage.attempts !== 1 || value.usage.inputs < 1 || value.usage.bytes < 1 ||
        value.usage.pending !== (value.finished == null ? 1 : 0))
        throw new Error("Invalid embedding attempt counters")
      if (previous) {
        if (previous.finished != null || value.id !== previous.id || value.finished == null ||
          value.usage.inputs !== previous.usage.inputs || value.usage.bytes !== previous.usage.bytes ||
          !isDeepStrictEqual({ ...value, usage: undefined, finished: undefined }, { ...previous, usage: undefined, finished: undefined }))
          throw new Error("Invalid embedding attempt outcome")
        // Update, never upsert: a late outcome must not resurrect purged usage.
        await commit(root, [{
          text: "UPDATE forge_records SET body = CASE WHEN body = ? THEN ? ELSE NULL END,updated = ? WHERE workspace = ? AND kind = 'embedding-attempt' AND id = ?",
          values: [JSON.stringify(previous), JSON.stringify(value), value.finished, root, value.id],
        }])
        return
      }
      if (value.finished != null) throw new Error("Embedding attempt must be admitted before completion")
      await commit(root, [{
        text: "INSERT INTO forge_records(workspace,kind,id,body,updated) VALUES(?,'embedding-attempt',?,CASE WHEN (SELECT count(*) FROM forge_records WHERE workspace = ? AND kind = 'collection' AND id IN (SELECT value FROM json_each(?)) AND (json_extract(body,'$.session') = '' OR json_extract(body,'$.session') = ?)) = ? THEN ? ELSE NULL END,?)",
        values: [root, value.id, root, JSON.stringify(value.collections), value.session, value.collections.length, JSON.stringify(value), value.started],
      }])
    },
    async embeddingJobs(root: string, key: string, session = "") {
      await ready
      const rows = await sql.all({
        text: "SELECT body FROM forge_records WHERE workspace = ? AND kind = 'embedding-job' AND json_extract(body,'$.collection') = ? AND json_extract(body,'$.session') = ? ORDER BY json_extract(body,'$.started') DESC, id DESC LIMIT 16",
        values: [root, key, session],
      })
      return rows.map((row) => decode(EmbeddingJob, JSON.parse(String(row.body))))
    },
    async embeddingJobSave(root: string, input: EmbeddingJob, revision?: string) {
      await ready
      const value = decode(EmbeddingJob, input)
      await commit(root, [{
        text: "INSERT OR REPLACE INTO forge_records(workspace,kind,id,body,updated) VALUES(?,'embedding-job',?,CASE WHEN EXISTS (SELECT 1 FROM forge_records WHERE workspace = ? AND kind = 'collection' AND id = ? AND (json_extract(body,'$.session') = '' OR json_extract(body,'$.session') = ?)) AND (SELECT json_extract(body,'$.revision') FROM forge_records WHERE workspace = ? AND kind = 'embedding-job' AND id = ?) IS ? THEN ? ELSE NULL END,?)",
        values: [root, value.id, root, value.collection, value.session, root, value.id, revision ?? null, JSON.stringify(value), value.updated],
      }, {
        text: "DELETE FROM forge_records WHERE workspace = ? AND kind = 'embedding-job' AND json_extract(body,'$.collection') = ? AND json_extract(body,'$.session') = ? AND json_extract(body,'$.state') NOT IN ('queued','running') AND id NOT IN (SELECT id FROM forge_records WHERE workspace = ? AND kind = 'embedding-job' AND json_extract(body,'$.collection') = ? AND json_extract(body,'$.session') = ? ORDER BY json_extract(body,'$.started') DESC,id DESC LIMIT 16)",
        values: [root, value.collection, value.session, root, value.collection, value.session],
      }])
      changed(root, "knowledge", value.session)
    },
    async recoverEmbeddings(root: string) {
      await ready
      const sessions = await sql.all({
        text: "SELECT DISTINCT json_extract(body,'$.session') AS session FROM forge_records WHERE workspace = ? AND kind = 'embedding-job' AND json_extract(body,'$.state') IN ('queued','running')",
        values: [root],
      })
      const now = Date.now()
      await commit(root, [{
        text: "UPDATE forge_records SET body = json_set(body,'$.state','interrupted','$.revision',lower(hex(randomblob(16))),'$.updated',?,'$.finished',?,'$.error','Backend restarted before completion was recorded; review and explicitly retry.'),updated = ? WHERE workspace = ? AND kind = 'embedding-job' AND json_extract(body,'$.state') IN ('queued','running')",
        values: [now, now, now, root],
      }])
      for (const row of sessions) changed(root, "knowledge", String(row.session))
    },
    async import(root: string, value: ImportRun) {
      await commit(root, journal(root, value))
      changed(root, "knowledge", value.session)
    },
    async imports(root: string, key: string, opts: { session?: string; run?: string; offset?: number; limit?: number } = {}): Promise<ImportHistory> {
      await ready
      const rows = await sql.all({
        text: "SELECT json_remove(body, '$.documents') AS body FROM forge_records WHERE workspace = ? AND kind = 'import' AND json_extract(body, '$.collection') = ? AND (json_extract(body, '$.session') = '' OR json_extract(body, '$.session') = ?) ORDER BY json_extract(body, '$.started') DESC, id DESC LIMIT 16",
        values: [root, key, opts.session ?? ""],
      })
      const runs = rows.map((row) => decode(ImportInfo, JSON.parse(String(row.body))))
      const selected = opts.run ? runs.find((run) => run.id === opts.run) : runs.at(0)
      if (opts.run && !selected) throw new Error("Import run is no longer available in this scope")
      const limit = Number.isFinite(opts.limit) ? Math.min(100, Math.max(1, Math.floor(opts.limit!))) : 50
      const offset = Math.min(Math.floor(Math.max(0, (selected?.count ?? 0) - 1) / limit) * limit, Number.isFinite(opts.offset) ? Math.max(0, Math.floor(opts.offset!)) : 0)
      const documents = selected ? await sql.all({
        text: "SELECT value FROM forge_records, json_each(forge_records.body, '$.documents') WHERE workspace = ? AND kind = 'import' AND forge_records.id = ? ORDER BY CAST(json_each.key AS INTEGER) LIMIT ? OFFSET ?",
        values: [root, selected.id, limit, offset],
      }) : []
      return { runs, selected, documents: documents.map((row) => decode(ImportFile, JSON.parse(String(row.value)))), page: { offset, limit, total: selected?.count ?? 0, ...(offset + limit < (selected?.count ?? 0) ? { next: offset + limit } : {}) } }
    },
    async recover(root: string) {
      await ready
      const local = "SELECT id FROM forge_records WHERE workspace = ? AND kind = 'collection' AND json_extract(body, '$.kind') IN ('file', 'folder') AND json_extract(body, '$.approved') = 1 AND json_extract(body, '$.state') IN ('ready', 'registered') AND json_extract(body, '$.generation') <> 'unindexed'"
      const pending = await sql.all({ text: local, values: [root] })
      const rows = await sql.all({
        text: `SELECT DISTINCT coalesce(json_extract(body, '$.session'), '') AS session FROM forge_records WHERE workspace = ? AND kind = 'collection' AND (json_extract(body, '$.state') = 'indexing' OR id IN (${local})) UNION SELECT coalesce(json_extract(body, '$.session'), '') AS session FROM forge_records WHERE workspace = ? AND kind = 'import' AND json_extract(body, '$.state') = 'running'`,
        values: [root, root, root],
      })
      if (!rows.length) return []
      const interrupted = "SELECT id FROM forge_records WHERE workspace = ? AND kind = 'collection' AND json_extract(body, '$.state') = 'indexing'"
      const observed = Date.now()
      const affected = `SELECT rowid FROM forge_fts_rows WHERE workspace = ? AND id IN (SELECT id FROM forge_sources WHERE workspace = ? AND json_extract(body, '$.detail.collection') IN (${interrupted} UNION ${local}))`
      // Invalidate old excerpts and approvals together without materializing document bodies.
      // Resolve indexed workspace/source identities before touching FTS by rowid.
      await sql.batch([
        { text: `DELETE FROM forge_records WHERE workspace = ? AND kind = 'embedding-consent' AND id IN (${interrupted})`, values: [root, root] },
        { text: "UPDATE forge_records SET body = json_set(body, '$.state', 'interrupted', '$.finished', ?, '$.updated', ?), updated = ? WHERE workspace = ? AND kind = 'import' AND json_extract(body, '$.state') = 'running'", values: [observed, observed, observed, root] },
        {
          text: `DELETE FROM forge_search WHERE rowid IN (${affected})`,
          values: [root, root, root, root],
        },
        { text: `DELETE FROM forge_fts_rows WHERE rowid IN (${affected})`, values: [root, root, root, root] },
        { text: `UPDATE forge_sources SET body = json_set(body, '$.status', 'unavailable', '$.detail.providers', '[]') WHERE workspace = ? AND json_extract(body, '$.detail.collection') IN (${interrupted})`, values: [root, root] },
        {
          text: "UPDATE forge_records SET body = json_set(json_remove(body, '$.progress'), '$.state', 'failed', '$.approved', json('false'), '$.providers', json('[]'), '$.grants', json('{}'), '$.observed', ?, '$.warnings', json(?)), updated = ? WHERE workspace = ? AND kind = 'collection' AND json_extract(body, '$.state') = 'indexing'",
          values: [observed, JSON.stringify(["Indexing was interrupted by a backend restart. Approve and refresh this collection to retry."]), observed, root],
        },
        { text: `UPDATE forge_sources SET body = json_set(body, '$.status', 'unavailable') WHERE workspace = ? AND json_extract(body, '$.detail.collection') IN (${local})`, values: [root, root] },
        {
          text: `UPDATE forge_records SET body = json_set(body, '$.state', 'registered', '$.observed', ?, '$.warnings', json(?)), updated = ? WHERE workspace = ? AND kind = 'collection' AND id IN (${local})`,
          values: [observed, JSON.stringify(["Checking local documents after restart. Saved excerpts are unavailable until reconciliation completes."]), observed, root, root],
        },
      ])
      for (const row of rows) changed(root, "knowledge", String(row.session))
      return pending.map((row) => String(row.id))
    },
    async save(root: string, value: Collection, run?: ImportRun) {
      await ready
      await commit(root, [
        ...value.approved ? [] : [{ text: "DELETE FROM forge_records WHERE workspace = ? AND kind = 'embedding-consent' AND id = ?", values: [root, value.id] }],
        { text: "INSERT OR REPLACE INTO forge_records(workspace,kind,id,body,updated) VALUES(?,?,?,?,?)", values: [root, "collection", value.id, JSON.stringify(value), Date.now()] },
        ...run ? journal(root, run) : [],
      ])
      changed(root, "knowledge", value.session)
    },
    content(root: string, key: string, text: string) { return put(root, "content", key, text) },
    async source(root: string, key: string) {
      await ready
      const row = (await sql.all({ text: "SELECT body FROM forge_sources WHERE workspace = ? AND id = ?", values: [root, key] })).at(0)
      return row ? decode(Source, JSON.parse(String(row.body))) : undefined
    },
    async retired(root: string, key: string) { return (await get(root, "retired", key)) === true },
    async contents(root: string, key: string) {
      const value = await get(root, "content", key)
      return typeof value === "string" ? value : undefined
    },
    async knowledge(root: string, session = "", provider?: string, document?: { collection: string; name?: string }) {
      await ready
      const rows = await sql.all({
        text: `SELECT body FROM forge_sources WHERE workspace = ? AND json_extract(body, '$.detail.collection') IS NOT NULL AND (coalesce(json_extract(body, '$.detail.session'), '') = '' OR json_extract(body, '$.detail.session') = ?)${provider == null ? "" : " AND ? IN (SELECT value FROM json_each(coalesce(json_extract(body, '$.detail.providers'), '[]')))"}${document == null ? "" : " AND json_extract(body, '$.detail.collection') = ?"}${document?.name == null ? "" : " AND json_extract(body, '$.detail.document') = ?"}`,
        values: [root, session, ...(provider == null ? [] : [provider]), ...(document == null ? [] : [document.collection]), ...(document?.name == null ? [] : [document.name])],
      })
      return rows.map((row) => decode(Source, JSON.parse(String(row.body))))
    },
    async publish(root: string, collection: Collection, sources: readonly Source[], run?: ImportRun) {
      await ready
      const rows = await sql.all({ text: "SELECT id FROM forge_sources WHERE workspace = ? AND json_extract(body, '$.detail.collection') = ?", values: [root, collection.id] })
      await commit(root, [
        ...collection.approved ? [] : [{ text: "DELETE FROM forge_records WHERE workspace = ? AND kind = 'embedding-consent' AND id = ?", values: [root, collection.id] }],
        {
          text: "DELETE FROM forge_search WHERE workspace = ? AND id IN (SELECT value FROM json_each(?))",
          values: [root, JSON.stringify([...new Set([...rows.map((row) => String(row.id)), ...sources.map((source) => source.id)])])],
        },
        ...rows.flatMap((row): Query[] => [
          { text: "INSERT OR REPLACE INTO forge_records(workspace,kind,id,body,updated) VALUES(?,?,?,?,?)", values: [root, "retired", String(row.id), "true", Date.now()] },
          { text: "DELETE FROM forge_sources WHERE workspace = ? AND id = ?", values: [root, String(row.id)] },
        ]),
        ...(await insert(root, sources)),
        { text: "INSERT OR REPLACE INTO forge_records(workspace,kind,id,body,updated) VALUES(?,?,?,?,?)", values: [root, "collection", collection.id, JSON.stringify(collection), Date.now()] },
        ...run ? journal(root, run) : [],
      ])
      changed(root, "knowledge", collection.session)
    },
    async purge(root: string, key: string) {
      const collection = await this.collection(root, key)
      if (!collection) return
      await this.publish(root, { ...collection, state: "removed" }, [])
      // Request captures and derived caches may contain copied text with different source IDs.
      await sql.batch([
        { text: "INSERT OR REPLACE INTO forge_records(workspace,kind,id,body,updated) VALUES(?,?,?,?,?)", values: [root, "purge-epoch", "current", JSON.stringify(randomUUID()), Date.now()] },
        { text: "DELETE FROM forge_search WHERE workspace = ? AND id IN (SELECT id FROM forge_sources WHERE workspace = ? AND json_extract(body, '$.kind') = 'summary')", values: [root, root] },
        prune(root),
        { text: "DELETE FROM forge_sources WHERE workspace = ? AND json_extract(body, '$.kind') = 'summary'", values: [root] },
        { text: "DELETE FROM forge_records WHERE workspace = ? AND kind = 'external' AND json_extract(body, '$.kind') = 'summary'", values: [root] },
        { text: "DELETE FROM forge_records WHERE workspace = ? AND kind IN ('request', 'request-info', 'cache', 'snapshot', 'inventory', 'inventory-scope', 'embedding-job', 'embedding-attempt')", values: [root] },
        { text: "DELETE FROM forge_relations WHERE workspace = ?", values: [root] },
        { text: "DELETE FROM forge_records WHERE workspace = ? AND kind IN ('content', 'collection', 'embedding-consent') AND id = ?", values: [root, key] },
        { text: "DELETE FROM forge_records WHERE workspace = ? AND kind = 'import' AND json_extract(body, '$.collection') = ?", values: [root, key] },
        {
          text: "UPDATE forge_records SET body = json_set(body, '$.versions', json((SELECT json_group_object(key, value) FROM json_each(forge_records.body, '$.versions') WHERE key IN (SELECT id FROM forge_sources WHERE workspace = ?))), '$.version', ?), updated = ? WHERE workspace = ? AND kind = 'policy' AND EXISTS (SELECT 1 FROM json_each(forge_records.body, '$.versions') WHERE key NOT IN (SELECT id FROM forge_sources WHERE workspace = ?))",
          values: [root, randomUUID(), Date.now(), root, root],
        },
      ])
      changed(root, "invalidate")
    },
    async policy(root: string, session = ""): Promise<Policy> {
      const value = await get(root, "policy", session)
      return value ? decode(Policy, value) : { version: "initial", session, pin: [], exclude: [] }
    },
    async policySave(root: string, value: Policy) {
      await put(root, "policy", value.session, value)
      changed(root, "policy", value.session)
    },
    async consent(root: string, session: string, collections: readonly string[]) {
      return hash(JSON.stringify(await access(root, session, collections)))
    },
    async inventory(root: string, session = ""): Promise<Inventory> {
      await ready
      const persisted = await get(root, "inventory", "current")
      if (persisted) {
        const base = decode(Inventory, persisted)
        const scoped = await get(root, "inventory-scope", session) as Record<string, number> | undefined
        const collections = await this.collections(root, session)
        const counts = { ...base.counts }
        for (const [kind, count] of Object.entries(scoped ?? {})) counts[kind] = (counts[kind] ?? 0) + count
        const imported = collections.reduce((sum, item) => sum + item.chunks, 0)
        if (imported) counts.document = (counts.document ?? 0) + imported
        return {
          ...base, counts,
          warnings: [...base.warnings, ...health(collections)],
          generation: collections.length ? hash(JSON.stringify([base.generation, collections.map((item) => [item.id, item.generation, item.state, item.observed])])) : base.generation,
        }
      }
      const rows = await sql.all({
        text: "SELECT json_extract(body, '$.generation') AS generation, json_extract(body, '$.revision') AS revision, json_extract(body, '$.observed') AS observed, json_extract(body, '$.files') AS files, json_extract(body, '$.partial') AS partial, json_extract(body, '$.warnings') AS warnings FROM forge_records WHERE workspace = ? AND kind = 'snapshot' AND id = 'current'",
        values: [root],
      })
      const counts = await sql.all({
        text: "SELECT json_extract(body, '$.kind') AS kind, count(*) AS count FROM forge_sources WHERE workspace = ? AND (coalesce(json_extract(body, '$.detail.session'), '') = '' OR json_extract(body, '$.detail.session') = ?) GROUP BY json_extract(body, '$.kind')",
        values: [root, session],
      })
      const row = rows.at(0)
      const collections = await this.collections(root, session)
      return {
        root, generation: collections.length ? hash(JSON.stringify([row?.generation, collections.map((item) => [item.id, item.generation, item.state, item.observed])])) : String(row?.generation ?? "unindexed"), revision: String(row?.revision ?? "unknown"),
        observed: Number(row?.observed ?? 0), files: Number(row?.files ?? 0), partial: row ? !!row.partial : true,
        indexed: !!row, counts: Object.fromEntries(counts.map((item) => [String(item.kind), Number(item.count)])),
        warnings: [...(row ? JSON.parse(String(row.warnings)) as string[] : ["No inventory yet. Start indexing to discover available sources."]), ...health(collections)],
      }
    },
    async view(root: string, opts: { session?: string; query?: string; category?: string; focus?: string; document?: string; limit?: number; offset?: number; generation?: string } = {}): Promise<View> {
      await ready
      const inventory = await this.inventory(root, opts.session)
      const groups = await sql.all({
        text: `SELECT ${classification} AS category, count(*) AS count FROM forge_sources WHERE workspace = ? AND (coalesce(json_extract(body, '$.detail.session'), '') = '' OR json_extract(body, '$.detail.session') = ?) AND json_extract(body, '$.method') != 'collection-section' GROUP BY category`,
        values: [root, opts.session ?? ""],
      })
      const changed = opts.generation != null && opts.generation !== inventory.generation
      const limit = Number.isFinite(opts.limit) ? Math.min(200, Math.max(1, Math.floor(opts.limit!))) : 120
      const offset = !changed && Number.isFinite(opts.offset) ? Math.min(999_999, Math.max(0, Math.floor(opts.offset!))) : 0
      const values: Value[] = [opts.query ?? "", root, opts.session ?? ""]
      const search = opts.query ? " AND (instr(lower(json_extract(body, '$.uri')), lower(?)) > 0 OR instr(lower(json_extract(body, '$.label')), lower(?)) > 0 OR instr(lower(json_extract(body, '$.text')), lower(?)) > 0)" : ""
      if (opts.query) values.push(opts.query, opts.query, opts.query)
      const category = opts.category ? ` AND (${classification}) = ?${opts.document ? "" : " AND json_extract(body, '$.method') != 'collection-section'"}` : ""
      if (opts.category) values.push(opts.category)
      const focus = opts.focus ? " AND (id = ? OR id IN (SELECT source FROM forge_relations WHERE workspace = ? AND target = ?) OR id IN (SELECT target FROM forge_relations WHERE workspace = ? AND source = ?))" : ""
      if (opts.focus) values.push(opts.focus, root, opts.focus, root, opts.focus)
      const document = opts.document
        ? " AND json_extract(body, '$.detail.collection') IS NOT NULL AND json_extract(body, '$.detail.collection') = (SELECT json_extract(body, '$.detail.collection') FROM forge_sources WHERE workspace = ? AND id = ?)"
          + " AND json_extract(body, '$.method') = 'collection-section' AND json_extract(body, '$.status') = 'current'"
          + " AND EXISTS (SELECT 1 FROM forge_sources parent WHERE parent.workspace = forge_sources.workspace AND parent.id = ? AND json_extract(parent.body, '$.method') = 'collection-document' AND json_extract(parent.body, '$.status') = 'current' AND json_extract(parent.body, '$.detail.session') = json_extract(forge_sources.body, '$.detail.session') AND json_extract(parent.body, '$.detail.document') = json_extract(forge_sources.body, '$.detail.document') AND json_extract(parent.body, '$.detail.fileHash') = json_extract(forge_sources.body, '$.detail.fileHash') AND parent.id IN (SELECT value FROM json_each(forge_sources.body, '$.evidence')))"
        : ""
      if (opts.document) values.push(root, opts.document, opts.document)
      const order = opts.document ? "CAST(coalesce(json_extract(body, '$.detail.page'), '0') AS INTEGER), CAST(json_extract(body, '$.start') AS INTEGER), CAST(json_extract(body, '$.end') AS INTEGER), id" : "(json_extract(body, '$.method') = 'file' OR json_extract(body, '$.kind') = 'directory') DESC, id"
      values.push(limit + 1, offset)
      const rows = await sql.all({
        text: `SELECT json_set(body, '$.text', substr(json_extract(body, '$.text'), max(1, instr(lower(json_extract(body, '$.text')), lower(?)) - 100), 500)) AS body FROM forge_sources WHERE workspace = ? AND (coalesce(json_extract(body, '$.detail.session'), '') = '' OR json_extract(body, '$.detail.session') = ?)${search}${category}${focus}${document} ORDER BY ${order} LIMIT ? OFFSET ?`,
        values,
      })
      const sources = rows.slice(0, limit).map((row) => decode(Source, JSON.parse(String(row.body))))
      const ids = JSON.stringify(sources.map((item) => item.id))
      const edges = await sql.all({
        text: "SELECT body FROM forge_relations WHERE workspace = ? AND source IN (SELECT value FROM json_each(?)) AND target IN (SELECT value FROM json_each(?)) ORDER BY position",
        values: [root, ids, ids],
      })
      return {
        root, generation: inventory.generation, revision: inventory.revision, observed: inventory.observed,
        files: inventory.files, partial: inventory.partial, sources,
        categories: Object.fromEntries(groups.map((group) => [String(group.category), Number(group.count)])),
        page: { offset, limit, ...(rows.length > limit ? { next: offset + limit } : {}) },
        relations: edges.map((row) => decode(Relation, JSON.parse(String(row.body)))),
        warnings: [...inventory.warnings, ...(changed ? ["Knowledge changed; source browsing restarted at the first page."] : []), ...(rows.length > limit ? [`More sources are available on the next page. Relationships show only endpoints on this page.`] : [])],
      }
    },
    async latest(root: string, session: string, purpose: string) {
      await ready
      const row = (await sql.all({
        text: "SELECT body FROM forge_records WHERE workspace = ? AND kind = 'request-info' AND json_extract(body, '$.session') = ? AND json_extract(body, '$.purpose') = ? ORDER BY json_extract(body, '$.observed') DESC, id DESC LIMIT 1",
        values: [root, session, purpose],
      })).at(0)
      return row ? decode(RequestInfo, JSON.parse(String(row.body))) : undefined
    },
    async externals(root: string, isolated = false) {
      const values = (await records(root, "external", 500)).map((value) => decode(Source, value))
      if (!isolated || !values.length) return values
      // Legacy adapter records can carry registered IDs with stripped metadata.
      // Keep the raw records inspectable, but never publish them over originals.
      const rows = await sql.all({
        text: "SELECT id FROM forge_sources WHERE workspace = ? AND json_extract(body, '$.detail.collection') IS NOT NULL AND id IN (SELECT value FROM json_each(?))",
        values: [root, JSON.stringify(values.map((item) => item.id))],
      })
      const owned = new Set(rows.map((row) => String(row.id)))
      return values.filter((item) => !item.detail.collection && !owned.has(item.id))
    },
    external(root: string, value: Source) { return put(root, "external", value.id, value) },
    async snapshot(root: string) {
      const value = (await records(root, "snapshot", 1)).at(0)
      return value == null ? undefined : unpack(value)
    },
    async replace(snapshot: Snapshot, _previous?: Snapshot) {
      await ready
      const pause = checkpoint()
      const prior = new Map<string, Source>()
      let cursor: string | undefined
      // Keyset pages bound native reads and decoding without retaining imported
      // document bodies that repository publication does not replace.
      while (true) {
        const rows = await sql.all({
          text: "SELECT id,body FROM forge_sources WHERE workspace = ? AND coalesce(json_extract(body, '$.detail.collection'), '') = ''"
            + (cursor == null ? "" : " AND id > ?") + " ORDER BY id LIMIT 200",
          values: [snapshot.root, ...(cursor == null ? [] : [cursor])],
        })
        for (const row of rows) {
          const item = decode(Source, JSON.parse(String(row.body)))
          prior.set(item.id, item)
          await pause()
        }
        if (rows.length < 200) break
        cursor = String(rows.at(-1)!.id)
      }
      const current = new Set(snapshot.sources.map((source) => source.id))
      const queries: Query[] = []
      const removed: string[] = []
      const updated: Source[] = []
      for (const source of prior.values()) {
        await pause()
        if (current.has(source.id)) continue
        removed.push(source.id)
        queries.push({ text: "DELETE FROM forge_sources WHERE workspace = ? AND id = ?", values: [snapshot.root, source.id] })
      }
      for (const source of snapshot.sources) {
        await pause()
        if (isDeepStrictEqual(prior.get(source.id), source)) continue
        removed.push(source.id)
        updated.push(source)
      }
      queries.push(...(await insert(snapshot.root, updated)))
      // FTS workspace/id columns are unindexed: remove changed rows in one scan,
      // before inserting replacements, rather than scanning once per source.
      if (removed.length) queries.unshift({
        text: "DELETE FROM forge_search WHERE workspace = ? AND id IN (SELECT value FROM json_each(?))",
        values: [snapshot.root, JSON.stringify(removed)],
      })
      queries.push({ text: "DELETE FROM forge_search WHERE workspace = ? AND id NOT IN (SELECT id FROM forge_sources WHERE workspace = ?)", values: [snapshot.root, snapshot.root] })
      queries.push(prune(snapshot.root))
      queries.push({ text: "INSERT OR REPLACE INTO forge_records(workspace,kind,id,body,updated) VALUES(?,?,?,?,?)", values: [snapshot.root, "snapshot", "current", await pack(snapshot), Date.now()] })
      queries.push(
        { text: "DELETE FROM forge_relations WHERE workspace = ?", values: [snapshot.root] },
        { text: "INSERT INTO forge_relations(workspace,id,source,target,position,body) SELECT ?,json_extract(value,'$.id'),json_extract(value,'$.from'),json_extract(value,'$.to'),CAST(key AS INTEGER),value FROM json_each(?)", values: [snapshot.root, JSON.stringify(snapshot.relations)] },
        { text: "INSERT OR REPLACE INTO forge_records(workspace,kind,id,body,updated) VALUES(?,?,?,?,?)", values: [snapshot.root, "relation-index", "current", "1", Date.now()] },
      )
      const counts: Record<string, number> = {}
      const scopes = new Map<string, Record<string, number>>()
      for (const item of snapshot.sources.filter((item) => !item.detail.collection)) {
        await pause()
        if (!item.detail.session) { counts[item.kind] = (counts[item.kind] ?? 0) + 1; continue }
        const scoped = scopes.get(item.detail.session) ?? {}
        scoped[item.kind] = (scoped[item.kind] ?? 0) + 1
        scopes.set(item.detail.session, scoped)
      }
      const inventory: Inventory = { root: snapshot.root, generation: snapshot.generation, revision: snapshot.revision, observed: snapshot.observed, files: snapshot.files, partial: snapshot.partial, indexed: true, counts, warnings: snapshot.warnings }
      queries.push(
        { text: "INSERT OR REPLACE INTO forge_records(workspace,kind,id,body,updated) VALUES(?,?,?,?,?)", values: [snapshot.root, "inventory", "current", JSON.stringify(inventory), Date.now()] },
        { text: "DELETE FROM forge_records WHERE workspace = ? AND kind = 'inventory-scope'", values: [snapshot.root] },
        ...[...scopes].map(([session, counts]): Query => ({ text: "INSERT OR REPLACE INTO forge_records(workspace,kind,id,body,updated) VALUES(?,?,?,?,?)", values: [snapshot.root, "inventory-scope", session, JSON.stringify(counts), Date.now()] })),
      )
      const sources = new Map(snapshot.sources.map((source) => [source.id, source]))
      for (const value of await records(snapshot.root, "opportunity", -1)) {
        await pause()
        const item = decode(Opportunity, value)
        if (item.status === "rejected" || item.status === "superseded") continue
        const changed = [...item.evidence, ...item.counterevidence].some((key) => {
          const current = sources.get(key)
          const previous = prior.get(key)
          return !current || current.status !== "current" || !previous || fingerprint(previous) !== fingerprint(current)
        })
        if (changed) queries.push({
          text: "UPDATE forge_records SET body = ?, updated = ? WHERE workspace = ? AND kind = 'opportunity' AND id = ? AND body = ?",
          values: [JSON.stringify({ ...item, status: "stale" }), Date.now(), snapshot.root, item.id, JSON.stringify(value)],
        })
      }
      await commit(snapshot.root, queries)
      changed(snapshot.root, "knowledge")
    },
    async search(root: string, query: string, limit = 50, opts: { session?: string; provider?: string; domains?: boolean; knowledge?: readonly string[]; exclude?: readonly string[] } = {}): Promise<Match[]> {
      await ready
      const words = keywords(query).slice(0, 32)
      if (!words.length) return []
      const matches = words.map((word) => `"${word.replaceAll('"', '""')}"`).join(" OR ")
      const rows = await sql.all({
        text: "SELECT s.body, bm25(forge_search, 0, 0, 2, 1) AS rank FROM forge_search JOIN forge_sources s ON s.workspace = forge_search.workspace AND s.id = forge_search.id WHERE forge_search MATCH ? AND forge_search.workspace = ? AND json_extract(s.body, '$.status') = 'current' AND (coalesce(json_extract(s.body, '$.detail.session'), '') = '' OR json_extract(s.body, '$.detail.session') = ?) AND (json_extract(s.body, '$.detail.collection') IS NULL OR ? IN (SELECT value FROM json_each(coalesce(json_extract(s.body, '$.detail.providers'), '[]')))) AND (? = 1 OR json_extract(s.body, '$.method') != 'domain-index')"
          + (opts.knowledge == null ? "" : " AND (json_extract(s.body, '$.detail.collection') IS NULL OR s.id IN (SELECT value FROM json_each(?)))")
          + (opts.exclude?.length ? " AND s.id NOT IN (SELECT value FROM json_each(?))" : "")
          + ` ORDER BY (json_extract(s.body, '$.uri') = ?) DESC, rank, ${ordering} LIMIT ?`,
        values: [matches, root, opts.session ?? "", opts.provider ?? "", opts.domains === false ? 0 : 1, ...opts.knowledge == null ? [] : [JSON.stringify(opts.knowledge)], ...opts.exclude?.length ? [JSON.stringify(opts.exclude)] : [], query.trim(), Math.min(100, Math.max(1, limit))],
      })
      return rows.map((row, index) => ({ source: JSON.parse(String(row.body)) as Source, score: 1 / (index + 1), reason: "BM25 path and content match" }))
    },
    async opportunities(root: string, limit = 100) {
      return (await records(root, "opportunity", limit)).map((value) => decode(Opportunity, value))
    },
    async decision(root: string, key: string) {
      await ready
      const row = (await sql.all({ text: "SELECT body FROM forge_records WHERE workspace = ? AND kind = 'opportunity' AND id = ?", values: [root, key] })).at(0)
      return row ? decode(Opportunity, JSON.parse(String(row.body))) : undefined
    },
    opportunity(root: string, value: Opportunity) { return put(root, "opportunity", value.id, value) },
    async request(root: string, session: string, key: string) {
      await ready
      const row = (await sql.all({
        text: "SELECT body FROM forge_records WHERE workspace = ? AND kind = 'request' AND id = ? AND json_extract(body, '$.session') = ?",
        values: [root, key, session],
      })).at(0)
      return row ? decode(Manifest, JSON.parse(String(row.body))) : undefined
    },
    async manifests(root: string, opts: { session?: string; purpose?: string; offset?: number; limit?: number } = {}) {
      await ready
      const values: Value[] = [root]
      const filters: string[] = []
      if (opts.session != null) { filters.push("json_extract(body, '$.session') = ?"); values.push(opts.session) }
      if (opts.purpose != null) { filters.push("json_extract(body, '$.purpose') = ?"); values.push(opts.purpose) }
      values.push(Math.min(100, Math.max(1, Math.floor(opts.limit ?? 100))), Math.max(0, Math.floor(opts.offset ?? 0)))
      const rows = await sql.all({
        text: `SELECT body FROM forge_records WHERE workspace = ? AND kind = 'request'${filters.map((filter) => ` AND ${filter}`).join("")} ORDER BY json_extract(body, '$.observed') DESC, id DESC LIMIT ? OFFSET ?`,
        values,
      })
      return rows.map((row) => decode(Manifest, JSON.parse(String(row.body))))
    },
    async requestObservation(root: string) {
      await ready
      await sql.batch([requests.track(root)])
      return requests.observed((await sql.all({ text: "SELECT revision,since,deleted,admitted FROM forge_request_history WHERE workspace = ?", values: [root] })).at(0))
    },
    async manifest(value: Manifest) {
      await ready
      const info: RequestInfo = { id: value.id, revision: hash(JSON.stringify(value)), session: value.session, purpose: value.purpose, model: value.model, observed: value.observed, state: value.state, entries: value.entries.length, sent: value.entries.filter((entry) => entry.stage === "sent").length, usage: value.usage }
      await commit(value.root, [
        { text: "INSERT INTO forge_records(workspace,kind,id,body,updated) VALUES(?,?,?,?,?) ON CONFLICT(workspace,kind,id) DO UPDATE SET body=excluded.body,updated=excluded.updated", values: [value.root, "request", value.id, JSON.stringify(value), Date.now()] },
        { text: "INSERT OR REPLACE INTO forge_records(workspace,kind,id,body,updated) VALUES(?,?,?,?,?)", values: [value.root, "request-info", value.id, JSON.stringify(info), Date.now()] },
        { text: "DELETE FROM forge_records WHERE workspace = ? AND kind = 'request' AND id NOT IN (SELECT id FROM forge_records WHERE workspace = ? AND kind = 'request' ORDER BY updated DESC LIMIT 200)", values: [value.root, value.root] },
        { text: "DELETE FROM forge_records WHERE workspace = ? AND kind = 'request-info' AND id NOT IN (SELECT id FROM forge_records WHERE workspace = ? AND kind = 'request')", values: [value.root, value.root] },
      ])
      changed(value.root, "request", value.session)
    },
    async cached(root: string, key: string) {
      await ready
      const row = (await sql.all({ text: "SELECT body FROM forge_records WHERE workspace = ? AND kind = 'cache' AND id = ?", values: [root, key] })).at(0)
      return row ? JSON.parse(String(row.body)) as unknown : undefined
    },
    cache(root: string, key: string, value: unknown) { return put(root, "cache", key, value) },
  }
}
export type Store = ReturnType<typeof store>

function fingerprint(source: Source) {
  return JSON.stringify(Object.entries(source).filter(([key]) => key !== "observed").sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, key === "detail" ? Object.entries(source.detail).sort(([a], [b]) => a.localeCompare(b)) : value]))
}
