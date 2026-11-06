import type { CodeIndexManager } from "@kilocode/kilo-indexing/engine"
import { AsyncLocalStorage } from "node:async_hooks"
import { format } from "node:util"
import type { Incoming, Request, Result, Event, Log } from "./indexing-worker-protocol"
import { parseQdrantWarning } from "./indexing-warning"

type Entry = {
  manager: CodeIndexManager
  progress: { dispose(): void }
  telemetry: { dispose(): void }
}

const managers = new Map<string, Entry>()
const context = new AsyncLocalStorage<string>()
const queues = new Map<string, Promise<void>>()
const searches = new Map<number, { key: string; controller: AbortController }>()

function send(message: Result | Event) {
  postMessage(message)
}

function write(level: Log["level"], args: unknown[]) {
  const key = context.getStore()
  const message = format(...args)
  send({ type: "event", key, event: "log", data: { level, message } })
  if (level !== "warn") return
  const warning = parseQdrantWarning(message)
  if (warning) send({ type: "event", key, event: "warning", data: warning })
}

console.debug = (...args) => write("debug", args)
console.info = (...args) => write("info", args)
console.log = (...args) => write("info", args)
console.warn = (...args) => write("warn", args)
console.error = (...args) => write("error", args)

async function dispose(key: string) {
  const entry = managers.get(key)
  if (!entry) return
  managers.delete(key)
  entry.progress.dispose()
  entry.telemetry.dispose()
  await entry.manager.dispose()
}

async function init(request: Extract<Request, { method: "init" }>) {
  await dispose(request.key)
  if (request.input.lancedbPath) process.env.KILO_LANCEDB_PATH = request.input.lancedbPath
  const [engine, status] = await Promise.all([
    import("@kilocode/kilo-indexing/engine"),
    import("@kilocode/kilo-indexing/status"),
  ])
  const manager = new engine.CodeIndexManager(
    request.input.directory,
    request.input.root,
    request.input.baselineDirectory,
  )
  const progress = manager.onProgressUpdate.on(() => {
    send({ type: "event", key: request.key, event: "status", data: status.normalizeIndexingStatus(manager) })
  })
  const telemetry = manager.onTelemetry.on((data) => {
    send({ type: "event", key: request.key, event: "telemetry", data })
  })
  managers.set(request.key, { manager, progress, telemetry })
  await manager.initialize(request.input.config)
  send({ type: "result", id: request.id, method: "init", ok: true, value: status.normalizeIndexingStatus(manager) })
}

async function handle(request: Request, signal?: AbortSignal) {
  try {
    if (request.method === "dispose") {
      await dispose(request.key)
      send({ type: "result", id: request.id, method: "dispose", ok: true, value: undefined })
      return
    }

    if (request.method === "search") {
      signal?.throwIfAborted()
      const value = await managers
        .get(request.key)
        ?.manager.searchIndex(request.input.query, request.input.directoryPrefix, request.input.scope, signal)
      signal?.throwIfAborted()
      send({ type: "result", id: request.id, method: "search", ok: true, value: value ?? [] })
      return
    }

    await init(request)
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    send({ type: "result", id: request.id, method: request.method, ok: false, error })
  }
}

onmessage = (event: MessageEvent<Incoming>) => {
  const request = event.data
  // Cancellation must bypass the per-directory queue it is trying to release.
  if (request.type === "cancel") {
    const pending = searches.get(request.id)
    if (pending?.key === request.key) pending.controller.abort()
    return
  }
  if (request.method !== "search") {
    for (const pending of searches.values()) {
      if (pending.key === request.key) pending.controller.abort()
    }
  }
  const controller = request.method === "search" ? new AbortController() : undefined
  if (controller) searches.set(request.id, { key: request.key, controller })
  const prior = queues.get(request.key) ?? Promise.resolve()
  const task = prior.then(() => context.run(request.key, () => handle(request, controller?.signal)))
  const queued = task.finally(() => {
    searches.delete(request.id)
    if (queues.get(request.key) === queued) queues.delete(request.key)
  })
  queues.set(request.key, queued)
}
