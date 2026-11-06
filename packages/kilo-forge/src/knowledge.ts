import { constants, watch, type FSWatcher } from "node:fs"
import { lstat, mkdir, open, opendir, realpath } from "node:fs/promises"
import { createHash, randomUUID } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import path from "node:path"
import ignore from "ignore"
import type { Collection, Destination, ImportFile, ImportRun, Preview, Registration, Source } from "./schema"
import type { Store } from "./store"
import type { Settings } from "./config"
import { chunks, extract, maximum, version, type Extractor } from "./extract"
import { download } from "./download"
import { hash, id, inside, message } from "./util"
import { briefs } from "./briefs"
import { wait } from "./wait"
import { stamp } from "./extraction"
import { references } from "./references"

const blocked = /(?:^|\/)(?:\.git|node_modules|vendor|dist|build|\.cache|\.trae|__pycache__|\.env(?:\.[^/]*)?|[^/]*\.(?:key|pem|p12|pfx)|credentials(?:\.[^/]*)?|secrets?(?:\.[^/]*)?)(?:\/|$)/i
const formats = /\.(?:mdx?|rst|txt|pdf|docx|html?)$/i
const creation = "The workspace references directory does not exist yet. Confirm ADD to create it and index documents placed there."

type Runtime = {
  jobs: Map<string, { owner: symbol; controller: AbortController; promise: Promise<Collection> }>
  locks: Map<string, Promise<void>>
  watchers: Map<string, { owner: symbol; watcher: FSWatcher }>
  timers: Map<string, ReturnType<typeof setTimeout>>
  queue: Promise<void>
  recovery?: Promise<void>
  pending?: Set<string>
  live: Map<string, Collection>
}
const runtimes = new WeakMap<Store, Map<string, Runtime>>()

export function knowledge(root: string, store: Store, opts: { references?: string; docx?: Extractor; extract?: Extractor; download?: typeof download; destination?: (provider: string) => Promise<Destination>; authorize?: (item: Collection, session: string, providers: readonly string[]) => Promise<void>; warn?: (text: string) => void } = {}) {
  const directory = opts.references ?? references(root)
  const roots = runtimes.get(store) ?? new Map<string, Runtime>()
  runtimes.set(store, roots)
  const runtime: Runtime = roots.get(root) ?? { jobs: new Map(), locks: new Map(), watchers: new Map(), timers: new Map(), queue: Promise.resolve(), live: new Map() }
  roots.set(root, runtime)
  const jobs = runtime.jobs
  const watchers = runtime.watchers
  const timers = runtime.timers
  const owner = Symbol("knowledge")
  let closed = false

  function ready() {
    return runtime.recovery ??= store.recover(root).then((keys) => { runtime.pending = new Set(keys) })
  }

  async function lock<A>(key: string, run: () => Promise<A>) {
    const previous = runtime.locks.get(key)
    const done = Promise.withResolvers<void>()
    runtime.locks.set(key, done.promise)
    await previous
    try {
      if (closed) throw new Error("Knowledge registry is closed")
      return await run()
    } finally {
      done.resolve()
      if (runtime.locks.get(key) === done.promise) runtime.locks.delete(key)
    }
  }

  async function find(key: string, session = "") {
    await ready()
    const item = runtime.live.get(key) ?? await store.collection(root, key)
    return item && (!item.session || item.session === session) ? item : undefined
  }

  async function get(key: string, session = "") {
    const item = await find(key, session)
    if (!item) throw new Error("Knowledge collection is not available in this session")
    return item
  }

  function resolve(location: string) {
    const name = path.normalize(location)
    const relative = !path.isAbsolute(name) && (name === "references" || name.startsWith(`references${path.sep}`))
    return path.resolve(relative ? path.dirname(directory) : root, name)
  }

  async function describe(input: Registration, origin: Collection["origin"] = "interface", key?: string, empty = false): Promise<Collection> {
    const resolved = ["file", "folder"].includes(input.kind) ? await realpath(resolve(input.location)).catch((err: NodeJS.ErrnoException) => {
      if (empty && input.kind === "folder" && resolve(input.location) === directory && err.code === "ENOENT") return undefined
      if (origin !== "config" || !["ENOENT", "ENOTDIR", "EACCES"].includes(err.code ?? "")) throw err
      return undefined
    }) : input.location
    const location = resolved ?? resolve(input.location)
    if (["file", "folder"].includes(input.kind) && blocked.test(location.split(path.sep).join("/"))) throw new Error("Secret and generated paths cannot be registered")
    if (input.kind === "file" && !formats.test(location)) throw new Error("Unsupported document format")
    if (input.kind === "url") {
      const url = new URL(location)
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("A public HTTP(S) URL without credentials is required")
    }
    if (input.kind === "upload" && (!formats.test(location) || path.basename(location) !== location)) throw new Error("Upload requires a supported plain filename")
    return {
      id: key ?? id(root, input.kind, input.session ?? "", location, input.kind === "text" || input.kind === "upload" ? hash(input.content ?? "") : ""),
      kind: input.kind, label: input.label, location, session: input.session ?? "", origin,
      include: input.include ?? ["**/*"], exclude: input.exclude ?? [], watch: input.watch ?? false,
      approved: false, providers: [], state: resolved == null && !empty ? "failed" : "registered", observed: Date.now(), generation: "unindexed", files: 0, chunks: 0,
      warnings: resolved == null ? [empty ? creation : "Configured path is unavailable. Restore access, then approve and refresh documents."] : [],
    }
  }

  async function register(input: Registration, origin: Collection["origin"] = "interface", key?: string) {
    await ready()
    if ((await store.collections(root, input.session)).length >= 100) throw new Error("At most 100 collections may be registered in this workspace scope")
    if (origin === "interface" && input.kind === "folder" && resolve(input.location) === directory) {
      const info = await lstat(directory).catch((err: NodeJS.ErrnoException) => { if (err.code === "ENOENT") return undefined; throw err })
      if (!info) {
        const item = await describe(input, origin, key, true)
        await opts.authorize?.(item, item.session, [])
        await mkdir(directory).catch((err: NodeJS.ErrnoException) => { if (err.code !== "EEXIST") throw err })
      }
      const current = await lstat(directory)
      if (!current.isDirectory() || current.isSymbolicLink()) throw new Error("References must be a real directory under the workspace root")
    }
    const item = await describe(input, origin, key)
    const location = item.location
    if (input.kind === "file" || input.kind === "folder" || input.kind === "url") {
      const duplicate = (await store.collections(root, input.session)).find((item) => item.kind === input.kind && item.session === (input.session ?? "") && item.location === location)
      if (duplicate) {
        if (origin === "config" && duplicate.id !== key) {
          const warning = `Configuration ${key} references this existing registration. Its original scope, exclusions, and approval remain authoritative.`
          if (!duplicate.warnings.includes(warning)) await store.save(root, { ...duplicate, warnings: [...duplicate.warnings, warning] })
        }
        return duplicate
      }
    }
    const identity = item.id
    const previous = await store.collection(root, identity)
    if (previous) return previous
    if (input.kind === "text" || input.kind === "upload") {
      if (!input.content?.trim()) throw new Error("Document content is required")
      const size = input.kind === "upload" ? Buffer.from(input.content, "base64").byteLength : Buffer.byteLength(input.content)
      if (size > maximum) throw new Error("Document exceeds the 20 MiB limit")
      await store.content(root, identity, input.content)
    }
    await store.save(root, item)
    return item
  }

  async function read(location: string, base: string, limit = maximum) {
    const canonical = await realpath(location)
    if (!inside(base, canonical) || canonical !== location) throw new Error("Document path escaped its approved root or became a symbolic link")
    const file = await open(location, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const info = await file.stat()
      if (!info.isFile() || info.size > limit) throw new Error(`Document is not a file or exceeds the ${limit} byte read limit`)
      const bytes = new Uint8Array(info.size + 1)
      let offset = 0
      while (offset < bytes.length) {
        const result = await file.read(bytes, offset, bytes.length - offset, offset)
        if (!result.bytesRead) break
        offset += result.bytesRead
      }
      if (offset !== info.size || await realpath(location) !== canonical) throw new Error("Document changed while reading")
      return bytes.slice(0, offset)
    } finally {
      await file.close()
    }
  }

  async function preview(input: Registration, abort?: AbortSignal): Promise<Preview> {
    const signal = AbortSignal.any([abort ?? new AbortController().signal, AbortSignal.timeout(30_000)])
    signal.throwIfAborted()
    const item = await describe(input, "interface", undefined, true)
    await wait(async () => opts.authorize?.(item, item.session, []), signal)
    const result: { location: string; files: number; bytes: number; excluded: number; partial: boolean; samples: Array<{ name: string; bytes: number; text: string }>; warnings: string[] } = {
      location: item.location, files: 0, bytes: 0, excluded: 0, partial: false, samples: [], warnings: [...item.warnings],
    }
    if (item.warnings.includes(creation)) return result
    const warn = (text: string) => { if (result.warnings.length < 20) result.warnings.push(text) }
    const limit = 2 * 1024 * 1024
    let sampled = 0
    let visited = 0
    const include = item.include.map((pattern) => new Bun.Glob(pattern))
    const exclude = ignore().add(item.exclude)
    async function allowed(location: string, kind: Collection["kind"]) {
      try { await opts.authorize?.({ ...item, location, kind }, item.session, []); return true } catch {
        result.excluded++
        warn("Some entries were withheld by Kilo permissions.")
        return false
      }
    }
    async function sample(name: string, size: number, load: () => Promise<Uint8Array>) {
      signal.throwIfAborted()
      result.files++
      result.bytes += size
      if (result.samples.length >= 5 || size > limit || sampled + size > 8 * 1024 * 1024) {
        result.partial = true
        warn("Extraction preview is limited to five documents, 2 MiB per document, and 8 MiB total. Counts include unsampled eligible files.")
        return
      }
      sampled += size
      // Reserve the sample before extraction so failures cannot cause unbounded parser attempts.
      const entry = { name, bytes: size, text: "" }
      result.samples.push(entry)
      try {
        const bytes = await load()
        signal.throwIfAborted()
        const pages = await (opts.extract ? opts.extract(name, bytes, signal) : extract(name, bytes, signal, opts.docx))
        entry.text = chunks(item, name, bytes, pages).map((source) => source.text).join("\n").slice(0, 1500)
        if (!entry.text) warn(`${name}: no extractable text`)
      } catch (err) { signal.throwIfAborted(); warn(`${name}: ${message(err)}`.slice(0, 500)) }
    }
    async function visit(dir: string, rules: Array<{ base: string; matcher: ReturnType<typeof ignore> }>, depth = 0) {
      signal.throwIfAborted()
      if (depth > 20 || visited >= 2000 || result.files >= 1000) { result.partial = true; return }
      if (await realpath(dir) !== dir) { result.excluded++; return }
      const matcher = ignore()
      for (const name of [".gitignore", ".kilocodeignore"]) {
        const file = path.join(dir, name)
        const info = await lstat(file).catch((err: NodeJS.ErrnoException) => { if (err.code === "ENOENT") return undefined; throw err })
        if (!info) continue
        if (!(await allowed(file, "file"))) throw new Error("Cannot preview this folder because its ignore policy is denied")
        matcher.add(new TextDecoder().decode(await read(file, item.location, 100_000)))
      }
      const inherited = [...rules, { base: dir, matcher }]
      const entries = await opendir(dir)
      for await (const entry of entries) {
        signal.throwIfAborted()
        if (++visited > 2000 || result.files >= 1000) { result.partial = true; break }
        const absolute = path.join(dir, entry.name)
        const relative = path.relative(item.location, absolute).split(path.sep).join("/")
        if (entry.isSymbolicLink() || blocked.test(relative) || exclude.ignores(`${relative}${entry.isDirectory() ? "/" : ""}`)
          || inherited.some((rule) => rule.matcher.ignores(`${path.relative(rule.base, absolute).split(path.sep).join("/")}${entry.isDirectory() ? "/" : ""}`))) { result.excluded++; continue }
        if (entry.isDirectory()) {
          if (await allowed(absolute, "folder")) await visit(absolute, inherited, depth + 1)
          continue
        }
        if (!entry.isFile() || !formats.test(entry.name) || !include.some((pattern) => pattern.match(relative))) { result.excluded++; continue }
        if (!(await allowed(absolute, "file"))) continue
        const info = await lstat(absolute)
        if (!info.isFile()) { result.excluded++; continue }
        await sample(relative, info.size, () => read(absolute, item.location, limit))
      }
    }
    if (item.kind === "folder") await visit(item.location, [])
    if (item.kind === "file") {
      const info = await lstat(item.location)
      if (!info.isFile()) throw new Error("Preview requires a regular document file")
      await sample(path.basename(item.location), info.size, () => read(item.location, path.dirname(item.location), limit))
    }
    if (item.kind === "url") {
      const response = await wait(() => (opts.download ?? download)(item.location, signal), signal)
      await sample(response.name, response.bytes.length, async () => response.bytes)
    }
    if (item.kind === "text" || item.kind === "upload") {
      if (!input.content?.trim()) throw new Error("Document content is required")
      if (input.content.length > 28_000_000) throw new Error("Document exceeds the upload limit")
      const bytes = item.kind === "text" ? new TextEncoder().encode(input.content) : new Uint8Array(Buffer.from(input.content, "base64"))
      if (bytes.length > maximum) throw new Error("Document exceeds the 20 MiB limit")
      await sample(item.kind === "text" ? "note.md" : item.location, bytes.length, async () => bytes)
    }
    signal.throwIfAborted()
    if (result.partial) warn("This is a bounded sample, not a complete inventory. Full indexing can encounter additional exclusions or errors.")
    return result
  }

  async function index(key: string, session = "") {
    await get(key, session)
    if (jobs.has(key)) return jobs.get(key)!.promise
    if (closed) throw new Error("Knowledge registry is closed")
    const checking = runtime.pending?.delete(key) ?? false
    const controller = new AbortController()
    const previous = runtime.queue
    const done = Promise.withResolvers<void>()
    runtime.queue = done.promise
    const promise = lock(key, async () => {
      await previous
      const started = Date.now()
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)])
      signal.throwIfAborted()
      const item = await get(key, session)
      if (!item.approved || ["paused", "removed"].includes(item.state)) throw new Error("Approve this collection before indexing")
      const deadline = started + 30_000
      const sources: Source[] = []
      const warnings: string[] = []
      const prior = (await store.knowledge(root, session)).filter((source) => source.detail.collection === key)
      const run = randomUUID()
      const documents: ImportFile[] = []
      let withheld = 0
      let files = 0
      let total = 0
      let updated = 0
      let notified = 0
      let extracted = 0
      let reused = 0
      let empty = 0
      let failed = 0
      let active = ""
      let stage: NonNullable<Collection["progress"]>["stage"] = "discover"
      let visited = 0
      const result = (state: NonNullable<Collection["result"]>["state"]) => ({ started, finished: Date.now(), state, files, bytes: total, extracted, reused, empty, failed })
      function record(state: ImportRun["state"], generation?: string): ImportRun {
        const updated = Date.now()
        return { id: run, collection: key, session: item.session, started, updated, state, stage, generation, ...(state === "running" ? {} : { finished: updated }), count: documents.length, withheld, documents: documents.map((document) => ({ ...document })) }
      }
      await store.save(root, { ...item, state: "indexing", observed: started, warnings: [], progress: { stage, files, bytes: total, chunks: 0, updated: started, document: "", started, deadline } }, record("running"))
      async function progress(next: NonNullable<Collection["progress"]>["stage"], document = "") {
        active = document
        stage = next
        if (stage !== "publish" && Date.now() - updated < 250) return
        signal.throwIfAborted()
        updated = Date.now()
        await store.save(root, { ...item, state: "indexing", observed: updated, warnings: [], progress: { stage, document, files, bytes: total, chunks: sources.length, updated, started, deadline } }, record("running"))
      }
      async function tracking<A>(operation: () => Promise<A>, label = stage as string, atomic = false, cleanup = false): Promise<A> {
        return wait(operation, cleanup ? undefined : signal, (message) => {
          const updated = Date.now()
          const previous = runtime.live.get(key)?.progress?.stage
          runtime.live.set(key, { ...item, state: "indexing", observed: updated, warnings: [`${label}: ${message}`], progress: { stage, document: active, files, bytes: total, chunks: sources.length, updated, started, deadline } })
          if (previous === stage && updated - notified < 250 && !signal.aborted) return
          notified = updated
          store.changed(root, "knowledge", item.session)
        }, atomic)
      }
      const include = item.include.map((pattern) => new Bun.Glob(pattern))
      const exclude = ignore().add(item.exclude)
      async function add(name: string, bytes: Uint8Array) {
        signal.throwIfAborted()
        if (++files > 1000 || (total += bytes.byteLength) > 100 * 1024 * 1024) throw new Error("Collection exceeds its 1000 file or 100 MiB limit")
        await progress("extract", name)
        const fingerprint = createHash("sha256").update(bytes).digest("hex")
        const saved = prior.filter((source) => source.detail.document === name)
        const digest = saved.length ? await stamp(saved, signal) : undefined
        const reuse = saved.length > 0 && saved.filter((source) => source.method === "collection-document").length === 1 &&
          saved.every((source) => source.detail.fileHash === fingerprint && source.detail.extractor === version(name) && source.detail.extraction === digest)
        if (reuse) {
          reused++
          if (!saved.some((source) => source.text.trim())) { empty++; warnings.push(`${name}: no extractable text`) }
          sources.push(...briefs(saved.map((source) => ({ ...source, status: "current" as const, detail: { ...source.detail, providers: JSON.stringify(item.providers) } }))))
        }
        if (!reuse) {
          const pages = await tracking(() => opts.extract ? opts.extract(name, bytes, signal) : extract(name, bytes, signal, opts.docx))
          extracted++
          if (!pages.some((page) => page.text.trim())) { empty++; warnings.push(`${name}: no extractable text`) }
          const parsed = chunks(item, name, bytes, pages)
          const digest = await stamp(parsed, signal)
          sources.push(...parsed.map((source) => ({ ...source, detail: { ...source.detail, extraction: digest } })))
        }
        if (sources.length > 10_000) throw new Error("Collection exceeds its 10000 chunk limit")
        return reuse
      }
      async function ingest(name: string, load: () => Promise<Uint8Array>) {
        if (documents.length >= 1000) throw new Error("Collection exceeds its 1000 attempted document limit")
        const document = { name, state: "processing" as ImportFile["state"], bytes: 0, chunks: 0 }
        documents.push(document)
        const before = sources.length
        try {
          const bytes = await tracking(load, "Reading document")
          document.bytes = bytes.byteLength
          const reused = await add(name, bytes)
          document.chunks = sources.length - before
          document.state = !sources.slice(before).some((source) => source.text.trim()) ? "empty" : reused ? "reused" : "extracted"
        } catch (err) {
          document.state = signal.aborted ? "cancelled" : "failed"
          signal.throwIfAborted()
          failed++
          throw err
        }
      }
      async function visit(dir: string, rules: Array<{ base: string; matcher: ReturnType<typeof ignore> }>, depth = 0) {
        signal.throwIfAborted()
        if (depth > 20) throw new Error("Collection discovery exceeds the 20 level directory depth limit. Register a narrower folder.")
        await progress("discover", `${visited} entries visited`)
        if (await realpath(dir) !== dir) throw new Error("Document folder became a symbolic link")
        await tracking(async () => opts.authorize?.({ ...item, location: dir, kind: "folder" }, session, []))
        const matcher = ignore()
        for (const name of [".gitignore", ".kilocodeignore"]) {
          const file = path.join(dir, name)
          const info = await lstat(file).catch((err: NodeJS.ErrnoException) => { if (err.code === "ENOENT") return undefined; throw err })
          if (!info) continue
          await tracking(async () => opts.authorize?.({ ...item, location: file, kind: "file" }, session, []))
          matcher.add(new TextDecoder().decode(await read(file, item.location, 100_000)))
        }
        const inherited = [...rules, { base: dir, matcher }]
        const entries = await opendir(dir)
        for await (const entry of entries) {
          signal.throwIfAborted()
          if (++visited > 20_000) throw new Error("Collection discovery exceeds the 20000 entry limit. Register a narrower folder or exclude unrelated subtrees.")
          await progress("discover", `${visited} entries visited`)
          const absolute = path.join(dir, entry.name)
          const relative = path.relative(item.location, absolute).split(path.sep).join("/")
          if (entry.isSymbolicLink() || blocked.test(relative) || exclude.ignores(`${relative}${entry.isDirectory() ? "/" : ""}`)) continue
          if (inherited.some((rule) => rule.matcher.ignores(`${path.relative(rule.base, absolute).split(path.sep).join("/")}${entry.isDirectory() ? "/" : ""}`))) continue
          if (entry.isDirectory()) {
            const permitted = await tracking(() => Promise.resolve().then(() => opts.authorize?.({ ...item, location: absolute, kind: "folder" }, session, [])).then(() => true, () => false))
            if (!permitted) { withheld++; warnings.push("Some entries were withheld by Kilo permissions."); continue }
            await visit(absolute, inherited, depth + 1)
            continue
          }
          if (!entry.isFile() || !formats.test(entry.name) || !include.some((pattern) => pattern.match(relative))) continue
          const permitted = await tracking(() => Promise.resolve().then(() => opts.authorize?.({ ...item, location: absolute, kind: "file" }, session, [])).then(() => true, () => false))
          if (!permitted) { withheld++; warnings.push("Some entries were withheld by Kilo permissions."); continue }
          if (documents.length >= 1000 || files >= 1000 || total >= 100 * 1024 * 1024 || sources.length >= 10_000) throw new Error("Collection indexing limit reached")
          await ingest(relative, () => read(absolute, item.location)).catch((err) => { signal.throwIfAborted(); warnings.push(`${relative}: ${message(err)}`) })
        }
      }
      try {
        await tracking(async () => opts.authorize?.(item, session, []))
        if (item.kind === "folder") await visit(item.location, [])
        if (item.kind === "file") await ingest(path.basename(item.location), () => read(item.location, path.dirname(item.location)))
        if (item.kind === "url") {
          const result = await tracking(() => (opts.download ?? download)(item.location, signal), "Downloading document")
          await ingest(result.name, async () => result.bytes)
        }
        if (item.kind === "text" || item.kind === "upload") {
          const content = await store.contents(root, key)
          if (content == null) throw new Error("Stored document content is unavailable")
          await ingest(item.kind === "text" ? "note.md" : item.location, async () => item.kind === "text" ? new TextEncoder().encode(content) : new Uint8Array(Buffer.from(content, "base64")))
        }
        signal.throwIfAborted()
        if (sources.length > 10_000) throw new Error("Collection exceeds its 10000 chunk limit")
        const current = await get(key, session)
        if (!current.approved || ["paused", "removed"].includes(current.state)) throw new Error("Collection was revoked while indexing")
        // Extraction, directory iteration, and SQLite reuse need not return the same order.
        const generation = hash(JSON.stringify(sources.toSorted((a, b) => a.id.localeCompare(b.id)).map((source) => [source.id, source.hash])))
        await progress("publish")
        const value: Collection = { ...item, state: "ready", files, chunks: sources.length, generation, warnings, observed: Date.now(), progress: undefined, result: result("published") }
        await tracking(() => store.publish(root, value, sources, record("published", generation)), "Publishing documents", true)
        signal.throwIfAborted()
        subscribe(value)
        return value
      } catch (err) {
        const current = await store.collection(root, key)
        if (current && !["paused", "removed"].includes(current.state)) {
          await tracking(() => store.publish(root, { ...current, ...(checking ? { approved: false, providers: [], grants: {} } : {}), state: "failed", progress: undefined, result: result("failed"), observed: Date.now(), warnings: [message(err)] }, prior.map((source) => ({ ...source, status: "unavailable", detail: { ...source.detail, ...(checking ? { providers: "[]" } : {}) } })), record(signal.aborted ? "cancelled" : "failed")), signal.aborted ? "Cancellation pending: invalidating evidence after commit/rollback" : "Recording failed publication", true, true)
        }
        if (current && ["paused", "removed"].includes(current.state)) await store.import(root, record(signal.aborted ? "cancelled" : "failed"))
        throw err
      }
    }).finally(() => {
      if (jobs.get(key)?.controller === controller) {
        jobs.delete(key)
        runtime.live.delete(key)
        store.changed(root, "knowledge", session)
      }
      done.resolve()
    })
    jobs.set(key, { owner, controller, promise })
    return promise
  }

  function subscribe(item: Collection) {
    if (!item.watch || watchers.has(item.id) || !["file", "folder"].includes(item.kind) || closed) return
    try {
      const watcher = watch(item.location, { recursive: item.kind === "folder", persistent: false }, () => {
        clearTimeout(timers.get(item.id))
        const timer = setTimeout(() => store.detached(() => { void index(item.id, item.session).catch((err) => opts.warn?.(`Knowledge refresh failed: ${message(err)}`)) }), 1000)
        timer.unref?.()
        timers.set(item.id, timer)
      })
      watcher.on("error", (err) => { opts.warn?.(`Knowledge watcher failed: ${message(err)}`); watcher.close(); watchers.delete(item.id) })
      watchers.set(item.id, { owner, watcher })
    } catch (err) {
      opts.warn?.(`Knowledge watcher unavailable; refresh explicitly: ${message(err)}`)
    }
  }

  async function stop(key: string, session = "", remove = false) {
    const item = await get(key, session)
    watchers.get(key)?.watcher.close()
    watchers.delete(key)
    clearTimeout(timers.get(key))
    timers.delete(key)
    const sources = (await store.knowledge(root, session)).filter((source) => source.detail.collection === key)
    const value: Collection = { ...item, approved: false, state: remove ? "removed" : "paused", providers: [], grants: {}, observed: Date.now(), progress: undefined }
    await store.publish(root, value, sources.map((source) => ({ ...source, status: "unavailable", detail: { ...source.detail, providers: "[]" } })))
    return value
  }

  async function change<A>(key: string, session: string, run: () => Promise<A>) {
    await get(key, session)
    jobs.get(key)?.controller.abort(new Error("Collection indexing cancelled by a lifecycle change"))
    return lock(key, run)
  }

  return {
    register, index, get, find, preview, ready,
    live: (item: Collection) => runtime.live.get(item.id) ?? item,
    async settle(session = "", signal?: AbortSignal) {
      signal?.throwIfAborted()
      const active = (await store.collections(root, session)).flatMap((item) => {
        const job = jobs.get(item.id)
        if (job) return [job.promise]
        return item.approved && item.state === "registered" && runtime.pending?.has(item.id) ? [index(item.id, session)] : []
      })
      const done = Promise.withResolvers<void>()
      const abort = () => done.reject(signal?.reason ?? new Error("Knowledge reconciliation cancelled"))
      signal?.addEventListener("abort", abort, { once: true })
      void Promise.allSettled(active).then(() => done.resolve())
      try { signal?.throwIfAborted(); await done.promise } finally { signal?.removeEventListener("abort", abort) }
    },
    async approve(key: string, session = "", providers: string[] = [], grants: Record<string, string> = {}) {
      return change(key, session, async () => {
        for (const provider of providers) {
          if (opts.destination && grants[provider] !== (await opts.destination(provider)).fingerprint) throw new Error("Sharing destination changed. Reload and approve its current routing fingerprint.")
        }
        const item = await stop(key, session)
        const value: Collection = { ...item, approved: true, providers: [...new Set(providers)], grants: Object.fromEntries(providers.flatMap((provider) => grants[provider] ? [[provider, grants[provider]]] : [])), state: "registered", observed: Date.now() }
        await store.save(root, value)
        return value
      })
    },
    async fresh(source: Source, session = "", provider?: string, signal?: AbortSignal) {
      signal?.throwIfAborted()
      const item = await find(source.detail.collection!, session)
      signal?.throwIfAborted()
      if (!item || !item.approved || item.state !== "ready" || source.status !== "current") return false
      if (provider != null && !item.providers.includes(provider)) return false
      if (provider != null && opts.destination) {
        const destination = await opts.destination(provider).catch((err) => { opts.warn?.(`Sharing destination unavailable: ${message(err)}`); return undefined })
        signal?.throwIfAborted()
        if (!destination || item.grants?.[provider] !== destination.fingerprint) return false
      }
      if (item.kind === "file" || item.kind === "folder") {
        const file = item.kind === "folder" ? path.join(item.location, source.detail.document!) : item.location
        const base = item.kind === "folder" ? item.location : path.dirname(item.location)
        const permitted = await Promise.resolve().then(() => opts.authorize?.({ ...item, location: file, kind: "file" }, session, provider ? [provider] : [])).then(() => true, () => false)
        signal?.throwIfAborted()
        if (!permitted) return false
        const bytes = await read(file, base).catch(() => undefined)
        signal?.throwIfAborted()
        if (!bytes || createHash("sha256").update(bytes).digest("hex") !== source.detail.fileHash) return false
      }
      if (item.kind === "url" && Date.now() - item.observed >= 24 * 60 * 60 * 1000) return false
      // Matching original bytes does not validate the cached extraction or the
      // selected copy. Re-read the whole document after asynchronous permissions.
      if (!source.detail.document || !source.detail.extraction) return false
      const records = await store.knowledge(root, session, undefined, { collection: item.id, name: source.detail.document })
      signal?.throwIfAborted()
      const saved = records.find((record) => record.id === source.id)
      if (!saved || !isDeepStrictEqual({ ...source, observed: 0 }, { ...saved, observed: 0 })) return false
      if (records.filter((record) => record.method === "collection-document").length !== 1) return false
      const digest = await stamp(records, signal)
      if (records.some((record) => record.status !== "current" || record.detail.session !== item.session ||
        record.detail.fileHash !== source.detail.fileHash || record.detail.extractor !== version(source.detail.document!) ||
        record.detail.extraction !== digest)) return false
      // Permission prompts, destination resolution and file reads can outlive
      // a collection lifecycle change. Never approve using the captured record.
      const current = await find(item.id, session)
      signal?.throwIfAborted()
      return current != null && JSON.stringify(current) === JSON.stringify(item)
    },
    async stop(key: string, session = "", remove = false) {
      return change(key, session, () => stop(key, session, remove))
    },
    async purge(key: string, session = "") {
      return change(key, session, async () => { await stop(key, session, true); await store.purge(root, key) })
    },
    // Inspection may discover configuration and revoke obsolete approval, but never
    // reads document contents, starts collection jobs, or installs watchers.
    async discover(cfg: Settings, session = "") {
      await ready()
      for (const entry of cfg.knowledge?.collections ?? []) {
        const key = `config:${entry.id}`
        const previous = await store.collection(root, key)
        const resolved = await realpath(path.resolve(root, entry.path)).catch((err) => {
          opts.warn?.(`Knowledge path unavailable: ${message(err)}`)
          return undefined
        })
        const location = resolved ?? path.resolve(root, entry.path)
        if (previous && resolved == null && !["failed", "paused", "removed"].includes(previous.state)) {
          await change(key, "", async () => {
            const stopped = await stop(key)
            await store.save(root, { ...stopped, state: "failed", warnings: ["Configured path is unavailable. Restore access, then approve and refresh documents."] })
          })
          continue
        }
        const changed = previous && (previous.location !== location || JSON.stringify(previous.include) !== JSON.stringify(entry.include ?? ["**/*"]) || JSON.stringify(previous.exclude) !== JSON.stringify(entry.exclude ?? []) || previous.watch !== (entry.watch ?? false))
        if (changed) {
          await change(key, "", async () => {
            const stopped = await stop(key, "", true)
            await store.save(root, { ...stopped, location, include: entry.include ?? ["**/*"], exclude: entry.exclude ?? [], watch: entry.watch ?? false, state: "registered", observed: Date.now() })
          })
          continue
        }
        if (!previous) await register({ label: entry.id, kind: "folder", location, include: entry.include, exclude: entry.exclude, watch: entry.watch }, "config", key)
      }
      for (const item of await store.collections(root, session)) {
        if (item.origin === "config" && !cfg.knowledge?.collections.some((entry) => `config:${entry.id}` === item.id)) {
          if (item.state !== "removed") await this.stop(item.id, "", true)
          continue
        }
      }
    },
    async sync(cfg: Settings, session = "") {
      await this.discover(cfg, session)
      for (const item of await store.collections(root, session)) {
        if (item.approved && item.state === "registered" && runtime.pending?.has(item.id)) {
          void store.detached(() => index(item.id, item.session)).catch((err) => opts.warn?.(`Knowledge reconciliation failed: ${message(err)}`))
        }
        if (item.approved && item.state === "ready") subscribe(item)
      }
    },
    async dispose() {
      closed = true
      const active = [...jobs.values()].filter((job) => job.owner === owner)
      for (const job of active) job.controller.abort()
      for (const [key, item] of watchers) {
        if (item.owner !== owner) continue
        item.watcher.close()
        watchers.delete(key)
        clearTimeout(timers.get(key))
        timers.delete(key)
      }
      await Promise.allSettled(active.map((job) => job.promise))
    },
  }
}
