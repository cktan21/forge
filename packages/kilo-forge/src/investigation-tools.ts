import path from "node:path"
import { isDeepStrictEqual } from "node:util"
import { config } from "./config"
import { actions, limits, type Call, type Investigation } from "./investigation"
import { decode, type Activity, type Destination, type EnhancementModel, type Policy, type Selection, type Snapshot, type Source, type View } from "./schema"
import { read, permitted, lookup } from "./repository"
import { hash, inside, tokens } from "./util"
import { select } from "./context"
import type { Store } from "./store"

type Ports = {
  root: string
  store: Store
  policy(session: string): Promise<Policy>
  destination(provider: string): Promise<Destination>
  permit(input: { tool: string; pattern: string; session: string; signal?: AbortSignal }): Promise<void>
  document?: (item: Source, signal?: AbortSignal) => Promise<void>
  docs(query: string, dependency: Source, state: Investigation, signal: AbortSignal): Promise<Source[]>
  search(query: string, session: string, provider: string, signal: AbortSignal, record?: (value: Activity) => void): Promise<Selection>
  symbol(id: string, session: string, provider: string, signal?: AbortSignal): Promise<Source>
  view(id: string, session: string, signal: AbortSignal): Promise<View>
  snapshot(signal?: AbortSignal): Promise<Snapshot>
}

export function capabilities(ports: Ports) {
  async function registered(uri: string) {
    const absolute = path.resolve(ports.root, uri)
    const collections = await ports.store.registrations(ports.root)
    if (collections.some((item) =>
      item.kind === "file" && path.resolve(item.location) === absolute
      || item.kind === "folder" && inside(path.resolve(item.location), absolute))) {
      throw new Error("Registered paths must be inspected through their approved source IDs")
    }
  }

  async function scope(session: string, model: EnhancementModel, signal?: AbortSignal) {
    signal?.throwIfAborted()
    await ports.permit({ tool: "forge_share", pattern: model.providerID, session, signal })
    const cfg = await config(ports.root)
    const policy = await ports.policy(session)
    const destination = await ports.destination(model.providerID)
    return { policy: hash(JSON.stringify([policy, cfg])), destination: destination.fingerprint }
  }

  async function excluded(item: Source, session: string) {
    const policy = await ports.policy(session)
    if (policy.exclude.includes(item.id) || item.evidence.some((key) => policy.exclude.includes(key))) throw new Error("Source is excluded")
    for (const key of policy.exclude) {
      const other = await ports.store.source(ports.root, key)
      if (other?.uri === item.uri && other.start <= item.end && other.end >= item.start) throw new Error("Source range overlaps excluded evidence")
    }
  }

  async function original(item: Source, session: string, provider: string, signal?: AbortSignal, historical = false): Promise<Source> {
    signal?.throwIfAborted()
    if (item.status !== "current" || item.detail.session && item.detail.session !== session) throw new Error("Source is unavailable in this scope")
    await excluded(item, session)
    if (["summary", "opportunity", "memory", "history", "goal", "tool"].includes(item.kind)) throw new Error("Inspect original repository evidence instead of derived notes")
    if (!item.detail.collection && !item.uri.includes(":")) {
      await ports.permit({ tool: "read", pattern: path.resolve(ports.root, item.uri), session, signal })
      await registered(item.uri)
      await permitted(ports.root, item.uri, await config(ports.root), signal, historical)
    }
    if (item.kind === "dependency" && item.detail.manifest) {
      await ports.permit({ tool: "read", pattern: path.resolve(ports.root, item.detail.manifest), session, signal })
      await registered(item.detail.manifest)
      await permitted(ports.root, item.detail.manifest, await config(ports.root), signal, historical)
    }
    if (item.method === "context7") {
      if (item.detail.provider && item.detail.provider !== provider) throw new Error("Documentation belongs to another provider")
      for (const tool of JSON.parse(item.detail.tools ?? "[]") as string[]) await ports.permit({ tool, pattern: "*", session, signal })
      await ports.document?.(item, signal)
    }
    if (historical && !item.detail.collection && (!item.uri.includes(":") || item.kind === "dependency")) return item
    if (item.method === "direct-read") {
      const result = await read(ports.root, { path: item.uri, start: item.start, lines: item.end - item.start + 1 }, await config(ports.root), signal)
      if (result.source.id !== item.id || result.source.text !== item.text || result.source.detail.fileHash !== item.detail.fileHash) throw new Error("Inspected file changed")
      return result.source
    }
    const current = await ports.symbol(item.id, session, provider, signal)
    if (current.status !== "current" || current.hash !== item.hash || current.text !== item.text
      || JSON.stringify(current.detail) !== JSON.stringify(item.detail)) throw new Error("Inspected source changed")
    return current
  }

  async function readfile(input: { path: string; start?: number; lines?: number }, session: string, signal?: AbortSignal) {
    await ports.permit({ tool: "read", pattern: path.resolve(ports.root, input.path), session, signal })
    await registered(input.path)
    const result = await read(ports.root, input, await config(ports.root), signal)
    await excluded(result.source, session)
    return result
  }

  async function check(state: Investigation, signal?: AbortSignal) {
    if (state.root !== ports.root) throw new Error("Investigation workspace changed")
    const before = await scope(state.session, state.model, signal)
    if (before.policy !== state.policy || before.destination !== state.destination) throw new Error("Investigation policy or model destination changed")
    if (state.previous) {
      const previous = await ports.store.prepared(ports.root, state.previous.session ?? state.session, state.previous.id)
      if (!previous || previous.revision !== state.previous.revision || previous.state !== "ready"
        || previous.session && previous.session !== state.session
        || !isDeepStrictEqual(state.dependencies ?? [], previous.dependencies)
        || !isDeepStrictEqual(state.edits ?? [], previous.edits ?? [])) throw new Error("Previous prompt amendments changed or are unavailable")
    }
    const sources = new Map([...state.dependencies ?? [], ...state.observations.flatMap((item) => item.sources)].map((item) => [item.id, item]))
    for (const item of sources.values()) await original(item, state.session, state.model.providerID, signal)
    const after = await scope(state.session, state.model, signal)
    if (before.policy !== after.policy || before.destination !== after.destination) throw new Error("Investigation access changed during validation")
    signal?.throwIfAborted()
  }

  async function admitted(state: { session: string; model: EnhancementModel; policy: string; destination: string; dependencies: readonly Source[] }, signal?: AbortSignal) {
    const before = await scope(state.session, state.model, signal)
    if (before.policy !== state.policy || before.destination !== state.destination) throw new Error("Admitted context policy or destination changed")
    for (const item of state.dependencies) await original(item, state.session, state.model.providerID, signal, true)
    const after = await scope(state.session, state.model, signal)
    if (!isDeepStrictEqual(before, after)) throw new Error("Admitted context access changed during validation")
  }

  async function execute(call: Call, state: Investigation, signal: AbortSignal, record?: (value: Activity) => void) {
    await ports.permit({ tool: call.name, pattern: call.name, session: state.session, signal })
    const session = state.session
    const provider = state.model.providerID
    if (call.name === "forge_lookup") {
      const input = decode(actions.forge_lookup, call.input)
      const result = await lookup(ports.root, input, (input) => readfile(input, session, signal), signal)
      record?.({ action: "Literal lookup completed", detail: `${result.visited} entries visited; ${result.sources.length} excerpts returned${result.limited ? "; lookup limit reached" : ""}` })
      return { output: JSON.stringify(result), sources: result.sources }
    }
    if (call.name === "forge_read_file") {
      const input = decode(actions.forge_read_file, call.input)
      const result = await readfile(input, session, signal).catch((err: unknown) => {
        signal.throwIfAborted()
        const code = err != null && typeof err === "object" ? Reflect.get(err, "code") : undefined
        if (code === "ENOENT" || err instanceof Error && err.message === "Requested line is outside the file") return undefined
        throw err
      })
      if (!result) return {
        output: JSON.stringify({ error: "No content was returned for this read. Check the repository-relative file path and use the previous read's total and next values for continuation. This result is not evidence of a defect." }),
        sources: [],
      }
      record?.({ action: "Read locally", path: `${result.source.uri}:${result.source.start}-${result.source.end}`, detail: `${result.total} file lines; bounded excerpt returned to the investigator${result.next ? `; continuation at line ${result.next}` : ""}. No syntax parsing or test execution.` })
      return { output: JSON.stringify({ source: result.source, total: result.total, next: result.next }), sources: [result.source] }
    }
    if (call.name === "forge_search_code" || call.name === "forge_search_docs") {
      const input = decode(actions[call.name], call.input)
      const result = await ports.search(input.query, session, provider, signal, record)
      const candidates = []
      let note = ""
      for (const match of result.matches) {
        signal.throwIfAborted()
        if (call.name === "forge_search_docs" && !["document", "instruction", "dependency", "configuration"].includes(match.source.kind)) continue
        const current = await original(match.source, session, provider, signal).catch(() => {
          signal.throwIfAborted()
          return undefined
        })
        if (current) candidates.push({ ...match, source: current })
      }
      if (call.name === "forge_search_docs") {
        const input = decode(actions.forge_search_docs, call.input)
        if (input.dependency) {
          const snapshot = await ports.snapshot(signal)
          const dependencies = snapshot.sources.filter((item) => item.kind === "dependency" && (item.id === input.dependency || item.label === input.dependency))
          const allowed: Source[] = []
          for (const dep of dependencies) {
            const current = await original(dep, session, provider, signal).catch(() => { signal.throwIfAborted(); return undefined })
            if (current) allowed.push(current)
          }
          if (allowed.length !== 1) note = "Choose an exact dependency source ID from its owning package; the supplied dependency is missing or ambiguous."
          if (allowed.length === 1) {
            const dep = allowed.at(0)!
            candidates.push({ source: dep, score: 1, reason: "Explicit owning dependency" })
            const docs = await ports.docs(input.query, dep, state, signal).catch(() => { signal.throwIfAborted(); return undefined })
            note = docs?.length ? "Documentation version compatibility is provider-reported, not verified at runtime." : "External documentation is unavailable or not configured. Continue with local evidence and report the knowledge gap."
            for (const item of docs ?? []) candidates.push({ source: await original(item, session, provider, signal), score: 1, reason: "Explicit dependency documentation" })
          }
        }
        if (!input.dependency) note = "Local documentation only. Specify an inspected dependency source ID for an approved external lookup."
      }
      const chosen = select(candidates, limits.evidence - 1000)
      record?.({ action: "Selection complete", detail: `${chosen.matches.length} permitted original excerpts returned by ${call.name}; results enter a subsequent model turn, not the current call` })
      return { output: `${chosen.text}\n${note}\nSearch covers current permitted indexed evidence only. No hits do not prove absence. Use direct reads and follow-up queries as needed.`, sources: chosen.matches.map((item) => item.source) }
    }
    if (call.name === "forge_get_symbol" || call.name === "forge_relationships") {
      const input = decode(actions[call.name], call.input)
      const known = state.observations.flatMap((item) => item.sources).find((item) => item.id === input.id)
      const stored = known ?? await ports.symbol(input.id, session, provider, signal).catch((err: unknown) => {
        signal.throwIfAborted()
        if (err instanceof Error && err.message === "Source not found in this workspace") return undefined
        throw err
      })
      if (!stored) return {
        output: JSON.stringify({ error: "No content was returned for this source ID. Use an exact ID from tool results, or read a permitted repository-relative file path. This result is not evidence of a defect." }),
        sources: [],
      }
      const item = await original(stored, session, provider, signal)
      record?.({ action: "Evidence rechecked", path: `${item.uri}:${item.start}-${item.end}`, detail: "Original source permissions and freshness verified." })
      if (call.name === "forge_get_symbol") {
        if (tokens(item.text) > 16_384) throw new Error("Source is too large; use a bounded forge_read_file range")
        return { output: JSON.stringify({ source: item }), sources: [item] }
      }
      const view = await ports.view(item.method === "direct-read" ? item.evidence.at(0) ?? item.id : item.id, session, signal)
      const sources: Source[] = [item]
      for (const node of view.sources) {
        const current = await ports.symbol(node.id, session, provider, signal).then((item) => original(item, session, provider, signal)).catch(() => {
          signal.throwIfAborted()
          return undefined
        })
        if (current && !sources.some((item) => item.id === current.id)) sources.push(current)
      }
      const visible = new Set(sources.map((item) => item.id))
      const relations = view.relations.filter((edge) => visible.has(edge.from) && visible.has(edge.to) && edge.evidence.every((key) => visible.has(key))).slice(0, 100)
      return { output: JSON.stringify({
        sources: sources.map((item) => ({ id: item.id, path: item.uri, label: item.label, hash: item.hash })),
        relations, limited: view.page.next != null, note: "Relationships are metadata, not a complete runtime call graph. Empty results may reflect an unindexed file.",
      }), sources }
    }
    throw new Error("This action is not a read-only investigation tool")
  }

  return { scope, check, admitted, execute, read: readfile }
}
