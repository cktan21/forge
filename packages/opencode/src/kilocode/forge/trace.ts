import { AsyncLocalStorage } from "node:async_hooks"
import { randomUUID } from "node:crypto"
import type { Store, Entry, Manifest, Usage } from "@kilocode/forge"
import type { Attempt, Collection, Destination, Source } from "@kilocode/forge/schema"
import { usage } from "@kilocode/forge/schema"
import { hash, id, redact, sanitize, tokens } from "@kilocode/forge/util"
import * as Log from "@opencode-ai/core/util/log"
import { source } from "@kilocode/forge/parse"
import { knowledge } from "@kilocode/forge/knowledge"
import { caveat, lineage } from "@kilocode/forge/lineage"
import { caveat as lookupCaveat, lookups } from "@kilocode/forge/lookups"
import { monitor } from "@kilocode/forge/model-response"
import { outbound } from "./egress"
import { route, type Fetch } from "./routing"

const log = Log.create({ service: "forge.trace" })
const stores = new Map<string, Store>()
const approvals = new Map<string, (item: Collection, session: string, providers: readonly string[]) => Promise<void>>()
const destinations = new Map<string, (provider: string) => Promise<Destination>>()
const context = new AsyncLocalStorage<Handle>()

export function register(root: string, store: Store, approve?: (item: Collection, session: string, providers: readonly string[]) => Promise<void>, destination?: (provider: string) => Promise<Destination>) {
  stores.set(root, store)
  if (approve) approvals.set(root, approve)
  if (destination) destinations.set(root, destination)
  return () => { if (stores.get(root) === store) { stores.delete(root); approvals.delete(root); destinations.delete(root) } }
}

function strings(value: unknown, result: string[] = [], depth = 0): string[] {
  if (depth > 15 || result.length > 2000) return result
  if (typeof value === "string") { if (!value.startsWith("data:")) result.push(value); return result }
  if (Array.isArray(value)) { for (const item of value) strings(item, result, depth + 1); return result }
  if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) {
    if (/^(?:headers|authorization|apiKey|api_key|password|secret|image|data)$/i.test(key)) continue
    strings(item, result, depth + 1)
  }
  return result
}

async function watch(input: { root: string; session?: string; messages: unknown; system?: readonly string[]; dependencies?: readonly Source[] }) {
  const store = stores.get(input.root)
  const body = [...input.system ?? [], ...strings(input.messages)].join("\n")
  const ids = [...new Set([...input.dependencies?.map((item) => item.id) ?? [], ...[...body.matchAll(/\[([a-f0-9]{24})\]/g)].flatMap((match) => match.at(1) ?? [])])]
  const sources = store ? await Promise.all(ids.map((key) => store.source(input.root, key))) : []
  const collections = [...new Set(sources.flatMap((item) => item?.detail.collection ? [item.detail.collection] : []))]
  // Persisted state also covers writers without this store's local notifications.
  const state = store && ids.length ? await store.consent(input.root, input.session ?? "", collections) : undefined
  return {
    async check() {
      if (store && state && (stores.get(input.root) !== store || state !== await store.consent(input.root, input.session ?? "", collections))) {
        throw new Error("Forge knowledge or policy changed during authorization. Prepare and review the request again.")
      }
    },
  }
}

async function capture(input: { root: string; session?: string; model: string; purpose: string; system: readonly string[]; messages: unknown; tools?: unknown; options?: unknown; request?: string; operation?: string; check?: () => Promise<void>; dependencies?: readonly Source[] }) {
  const store = stores.get(input.root)
  if (!store || process.env.KILO_FORGE_DISABLED === "1") return undefined
  const guard = await store.guard(input.root)
  const snapshot = await store.snapshot(input.root)
  const chunks = strings(input.messages)
  const body = [...input.system, ...chunks].join("\n")
  const references = input.purpose === "coding" ? lookups(input.messages) : []
  const resolved = (await Promise.all(references.map(async (reference) => {
    const record = await store.request(input.root, input.session ?? "", reference.id)
    return record?.purpose === "tool-retrieval" && record.state === "completed"
      && record.lookup?.call === reference.call && record.lookup.tool === reference.tool ? record : undefined
  }))).filter((item) => item != null)
  const entries: Entry[] = []
  const ids = [...new Set([...body.matchAll(/\[([a-f0-9]{24})\]/g)].map((match) => match[1]!))]
  const selected = await Promise.all(ids.map((key) => store.source(input.root, key)))
  const provider = input.model.split("/").at(0) ?? ""
  const required = [...selected, ...input.dependencies ?? []].some((item) => item?.detail.collection)
  const routing = required
    ? await destinations.get(input.root)?.(provider)
    : undefined
  const candidates = [...new Map([...selected.filter((item) => item != null), ...snapshot?.sources ?? [], ...input.dependencies ?? []].map((item) => [item.id, item])).values()]
  const observed = candidates.filter((source) => (!source.detail.session || source.detail.session === (input.session ?? "")) && source.text.length >= 24 && body.includes(source.text))
  for (const source of observed.slice(0, 80)) entries.push({ source: source.id, kind: source.kind, label: source.label, uri: source.uri, hash: source.hash, text: redact(source.text).slice(0, 8000), tokens: tokens(source.text), stage: "assembled" })
  const text = redact(body)
  for (const entry of resolved.flatMap((item) => item.entries).slice(0, 80)) {
    if (!entry.text || !text.includes(entry.text) || entries.some((item) => item.source === entry.source)) continue
    entries.push({ ...entry, stage: "assembled" })
  }
  function add(label: string, kind: Entry["kind"], value: string) {
    if (!value) return
    entries.push({ source: id(input.purpose, label, hash(value)), kind, label, uri: `request:${label}`, hash: hash(value), text: redact(value).slice(0, 12_000), tokens: tokens(value), stage: "assembled" })
  }
  input.system.forEach((value, index) => add(`System instructions ${index + 1}`, "instruction", value))
  chunks.slice(-40).forEach((value, index) => add(`Message content ${index + 1}`, value.includes("[Old tool result content cleared]") ? "summary" : "tool", value))
  if (input.tools) add("Tool definitions", "configuration", JSON.stringify(input.tools, sanitize))
  if (input.options) add("Provider instructions and options", "configuration", strings(input.options).join("\n"))
  const reference = input.purpose === "coding" ? lineage(input.messages) : undefined
  // Home-screen preparation precedes session creation and has workspace scope.
  const parent = reference ? await store.request(input.root, input.session ?? "", reference)
    ?? (input.session ? await store.request(input.root, "", reference) : undefined) : undefined
  const preparation = parent?.purpose === "enhance" && parent.state === "completed" ? parent.id : undefined
  const request = input.request ?? randomUUID()
  const existing = input.request ? await store.request(input.root, input.session ?? "", input.request) : undefined
  const selection = existing?.purpose === input.purpose ? existing.selection : undefined
  const operations = [...new Set(resolved.map((item) => item.operation ?? item.id))]
  const operation = input.operation ?? (preparation ? parent?.operation ?? preparation : operations.length === 1 ? operations.at(0)! : request)
  let manifest: Manifest = { id: request, operation, selection, lookups: [...new Set(resolved.map((item) => item.id))], root: input.root, generation: snapshot?.generation ?? "unindexed", session: input.session ?? "", model: input.model, purpose: input.purpose, observed: Date.now(), entries, attempts: [], discarded: 0, coverage: ["Assembled request. Excerpts are bounded and redacted; per-source costs use conservative UTF-8 bytes. Tool internals and provider-hidden instructions are opaque.", "Entry stages describe the latest started transport attempt, not the union of retries. Each retained attempt records its own exact excerpt matches; unmatched excerpts may be transformed or removed. A response does not prove model processing. Pending attempts after interruption have unknown outcomes."], usage: usage(input.model), state: "assembled" }
  if (input.dependencies?.length) manifest = { ...manifest, coverage: [...manifest.coverage,
    `Derived-context dependencies: ${input.dependencies.length} originals, showing at most 100. These versions influenced the preparation; this does not assert that their raw text was included or transmitted.`,
    ...input.dependencies.slice(0, 100).map((item) => `[${item.id}] ${item.uri}:${item.start}-${item.end} hash=${item.hash}`),
  ] }
  if (references.length) manifest = { ...manifest, coverage: [...manifest.coverage, lookupCaveat, `${resolved.length}/${references.length} candidate search-tool references resolved in this session.`] }
  if (routing) manifest = { ...manifest, coverage: [...manifest.coverage, "Registered evidence uses reviewed-origin runtime fetch with automatic redirects disabled. This does not identify downstream processing destinations."] }
  if (preparation) manifest = { ...manifest, preparation, coverage: [...manifest.coverage, caveat] }
  if (reference && !preparation) manifest = { ...manifest, coverage: [...manifest.coverage, "Preparation reference could not be resolved to a retained, completed enhancement in this session or workspace scope."] }
  let queue = guard.run(() => store.manifest(manifest))
  const save = () => {
    const value = manifest
    queue = queue.catch((err) => log.warn("trace write failed", { error: String(err) })).then(() => guard.run(() => store.manifest(value)))
    return queue
  }
  let sequence = 0
  let completed = false
  function record(attempt: Attempt, project = true) {
    manifest = {
      ...manifest,
      attempts: manifest.attempts?.map((item) => item.id === attempt.id ? attempt : item),
      ...(!completed && project && attempt.sequence === sequence ? {
        state: attempt.state === "response" && (attempt.status ?? 500) < 400 ? "sent" as const : "failed" as const,
        entries: entries.map((entry) => ({ ...entry, stage: attempt.sent.includes(entry.source) ? "sent" as const : "assembled" as const })),
      } : {}),
    }
    return save()
  }
  function observe(body: unknown, status: number, attempt: Attempt) {
    const raw = typeof body === "string" ? body : body instanceof Uint8Array ? new TextDecoder().decode(body) : undefined
    if (raw == null) return record({ ...attempt, finished: Date.now(), state: "response", status })
    const parsed: unknown = (() => { try { return JSON.parse(raw) } catch (err) { log.debug("non-JSON model payload", { error: String(err) }); return raw } })()
    const text = redact(strings(parsed).join("\n"))
    return record({
      ...attempt, finished: Date.now(), state: "response", status, hash: hash(raw), membership: "matched",
      sent: entries.filter((entry) => entry.text.length > 0 && text.includes(entry.text)).map((entry) => entry.source),
    })
  }
  const handle = {
    id: manifest.id,
    run<A>(fn: () => A): A { return context.run(handle, fn) },
    fetch(fetcher: Fetch): typeof globalThis.fetch {
      const wrapped = async (request: RequestInfo | URL, init?: RequestInit) => {
        const attempt: Attempt = { id: randomUUID(), sequence: ++sequence, started: Date.now(), state: "pending", sent: [], membership: "unknown" }
        const attempts = [...manifest.attempts ?? [], attempt]
        manifest = { ...manifest, attempts: attempts.slice(-32), discarded: (manifest.discarded ?? 0) + Math.max(0, attempts.length - 32), entries, state: "assembled" }
        let invoked = false
        try {
          const target = required ? outbound(routing, fetcher, request, init) : undefined
          const pending = await watch(input)
          const body = target ? await target.clone().text() : init?.body ?? (request instanceof Request ? await request.clone().text() : undefined)
          await save()
          if (routing && routing.fingerprint !== (await destinations.get(input.root)?.(provider))?.fingerprint) throw new Error("Forge request routing changed after assembly. Prepare and review the request again.")
          // Authorization uses original passages, never the bounded/redacted display capture.
          await authorize(input)
          if (routing && routing.fingerprint !== (await destinations.get(input.root)?.(provider))?.fingerprint) throw new Error("Forge request routing changed during authorization. Prepare and review the request again.")
          await input.check?.()
          await guard.check()
          await pending.check()
          invoked = true
          // Only immutable standard Requests cross the registered-knowledge boundary.
          const result = target
            ? await fetcher(target, { timeout: false } as RequestInit)
            : await fetcher(request, init)
          await observe(body, result.status, attempt).catch((err) => log.warn("transport trace unavailable", { error: String(err) }))
          return monitor(result, async (response) => {
            const current = manifest.attempts?.find((item) => item.id === attempt.id)
            if (!current) return
            await record({ ...current, response }, false).catch((err) => log.warn("response usage trace unavailable", { error: String(err) }))
          })
        } catch (err) {
          // Fetch failures may occur after transmission; never infer that nothing was sent.
          await record({ ...attempt, finished: Date.now(), state: invoked ? "error" : "blocked" }).catch((error) => log.warn("transport trace unavailable", { error: String(error) }))
          throw err
        }
      }
      return Object.assign(wrapped, { preconnect: fetcher.preconnect ?? (() => undefined) })
    },
    async finish(value: Partial<Usage>, failed = false) {
      completed = true
      manifest = { ...manifest, state: failed ? "failed" : "completed", usage: { ...manifest.usage, ...value, milliseconds: Date.now() - manifest.observed } }
      return save()
    },
  }
  await queue
  return handle
}

export type Handle = NonNullable<Awaited<ReturnType<typeof capture>>>
export async function authorize(input: { root: string; session?: string; model: string; messages: unknown; system?: readonly string[]; dependencies?: readonly Source[] }) {
  const store = stores.get(input.root)
  if (!store) return false
  const pending = await watch(input)
  const body = [...input.system ?? [], ...strings(input.messages)].join("\n")
  const dependencies = new Map(input.dependencies?.map((item) => [item.id, item]))
  const ids = [...new Set([...dependencies.keys(), ...[...body.matchAll(/\[([a-f0-9]{24})\]/g)].map((match) => match[1]!)] )]
  if (!ids.length) return false
  const policies = await Promise.all([store.policy(input.root), store.policy(input.root, input.session ?? "")])
  const excluded = new Set(policies.flatMap((policy) => [...policy.exclude]))
  const library = knowledge(input.root, store, { destination: destinations.get(input.root), authorize: approvals.get(input.root) })
  const provider = input.model.split("/").at(0) ?? ""
  let required = false
  for (const key of ids) {
    if (excluded.has(key)) throw new Error(`Forge evidence ${key} is excluded by the current source policy. Remove its passage from the draft/history before sending.`)
    const item = await store.source(input.root, key)
    const dependency = dependencies.get(key)
    if (dependency?.detail.collection && (!item || item.hash !== dependency.hash || item.text !== dependency.text
      || JSON.stringify(item.detail) !== JSON.stringify(dependency.detail))) throw new Error("Forge derived evidence changed or was removed")
    if (!item && await store.retired(input.root, key)) throw new Error(`Forge evidence ${key} was removed or replaced. Remove its captured passage from the draft/history before sending.`)
    if (item?.detail.session && item.detail.session !== (input.session ?? "")) throw new Error(`Forge evidence ${key} is not available in this session.`)
    if (!item?.detail.collection) continue
    required = true
    await approvals.get(input.root)?.(await library.get(item.detail.collection, input.session), input.session ?? "", [provider])
    if ((!dependency && !body.includes(item.text)) || !(await library.fresh(item, input.session ?? "", provider))) {
      throw new Error(`Forge evidence ${key} is stale or not approved for this session/provider. Refresh the collection and review sharing before sending.`)
    }
  }
  await pending.check()
  return required
}

export async function start(input: Parameters<typeof capture>[0]) {
  // Authorization failures must stop submission, not degrade into missing provenance.
  const run = async () => {
    const pending = await watch(input)
    const required = await authorize(input)
    const handle = await capture(input).catch((err) => {
      if (required) throw new Error("Forge could not establish the required knowledge transport guard. Retry after local capture is available.", { cause: err })
      log.warn("local provenance unavailable", { error: String(err) })
      return undefined
    })
    if (required && !handle) throw new Error("Forge knowledge requires an active transport guard before sending.")
    try {
      await pending.check()
    } catch (err) {
      await handle?.finish({}, true).catch((error) => log.warn("rejected capture status unavailable", { error: String(error) }))
      throw err
    }
    return handle
  }
  const store = stores.get(input.root)
  return store ? store.fenced(input.root, run) : run()
}

async function summarize(root: string, session: string, summary: string) {
  const store = stores.get(root)
  if (!store || !summary) return
  const manifests = await store.manifests(root, { session })
  const entries = manifests.flatMap((item) => item.entries.filter((entry) => entry.stage === "sent" || entry.stage === "assembled"))
  const ids = [...new Set(entries.map((entry) => entry.source))]
  const item = source(`summary:session:${session}:${hash(summary).slice(0, 12)}`, summary, "summary", { label: "Compacted conversation", method: "session-compaction", inferred: true, evidence: ids, detail: { session, lineage: "Inputs to earlier requests; the summary may not retain every fact" } })
  await store.external(root, item)
  await store.manifest({ id: randomUUID(), root, session, generation: "compaction", purpose: "compaction-lineage", model: "recorded by session runtime", observed: Date.now(), entries: [...entries.slice(0, 100).map((entry) => ({ ...entry, stage: "summarized" as const })), { source: item.id, kind: "summary", label: item.label, uri: item.uri, hash: item.hash, text: item.text, tokens: tokens(item.text), stage: "assembled" }], coverage: ["Summary lineage is recorded separately; historical request snapshots remain unchanged. Earlier inputs are not guaranteed to be retained by the summary."], usage: usage(), state: "completed" })
}
export function compact(root: string, session: string, summary: string) {
  const store = stores.get(root)
  return (store ? store.fenced(root, () => summarize(root, session, summary)) : Promise.resolve()).catch((err) => log.warn("summary provenance unavailable", { error: String(err) }))
}
export async function compactor(root: string, session: string) {
  const guard = await stores.get(root)?.guard(root).catch((err) => { log.warn("summary provenance unavailable", { error: String(err) }); return undefined })
  return async (summary: string) => {
    if (!guard) return
    await guard.run(() => summarize(root, session, summary)).catch((err) => log.warn("summary provenance unavailable", { error: String(err) }))
  }
}
export function transport(fetcher: typeof globalThis.fetch): typeof globalThis.fetch
export function transport(fetcher: Fetch): Fetch
export function transport(fetcher: Fetch) {
  // Known adapters call back here at the final HTTP hop after rewriting the URL.
  if (route(fetcher)) return fetcher
  return context.getStore()?.fetch(fetcher) ?? fetcher
}
