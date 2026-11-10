import { randomUUID } from "node:crypto"
import { isDeepStrictEqual as equal } from "node:util"
import { config } from "./config"
import { investigation } from "./investigation"
import { capabilities } from "./investigation-tools"
import { writing, PreparationBinding, type Prepared } from "./writing"
import { decode, type EnhancementModel, type Source } from "./schema"
import { EnhancementError, failure } from "./enhancement"
import { hash } from "./util"
import type { Ports } from "./engine"

// The engine supplies evidence capabilities; this module owns preparation and
// handoff state without owning repository scanning or retrieval.
export function workshop(
  ports: Pick<Ports, "root" | "store" | "resolve" | "permit" | "turn" | "write">,
  tools: ReturnType<typeof capabilities>,
) {
  const research = investigation({
    root: ports.root,
    resolve: async (model) => {
      if (!(await config(ports.root)).investigation)
        throw new EnhancementError("Enable investigation in .kilo/forge.jsonc to use the investigative workshop.", {
          ...failure("transport"),
          reason: "invalid-request",
          stage: "setup",
        })
      if (!ports.turn)
        throw new EnhancementError("This host does not support investigative tool calling.", {
          ...failure("transport"),
          reason: "unsupported-format",
          stage: "setup",
        })
      if (ports.resolve) return ports.resolve(model)
      if (model) return model
      throw new EnhancementError("Select a model for investigation.", {
        ...failure("transport"),
        reason: "invalid-request",
        stage: "setup",
      })
    },
    scope: async (session, model, signal) => {
      await ports.permit?.({ tool: "forge_investigate", pattern: ports.root, session, signal })
      return tools.scope(session, model, signal)
    },
    load: (session, key) => ports.store.investigation(ports.root, session, key),
    save: (record, revision) => ports.store.investigationSave(record, revision),
    turn: (input) => ports.turn!(input),
    execute: tools.execute,
    check: tools.check,
    inherit: async (previous, session, model, signal) => {
      if (previous.session && previous.session !== session)
        throw new Error("Previous edits belong to a different session")
      const record = await writer.get(previous.id, previous.session ?? session, signal)
      if (
        record.revision !== previous.revision ||
        record.state !== "ready" ||
        record.model.providerID !== model.providerID
      )
        throw new Error("Review previous prompt edits and sharing before investigating with them")
      return { edits: record.edits ?? [], dependencies: record.dependencies }
    },
  })
  const writer = writing({
    root: ports.root,
    investigation: research.get,
    load: (key, session) => ports.store.prepared(ports.root, session, key),
    save: (record, revision) => ports.store.preparedSave(record, revision),
    check: async (record, signal) => {
      const parent = await ports.store.investigation(ports.root, record.scope, record.investigation)
      if (
        !parent ||
        parent.revision !== record.parent ||
        parent.state !== "findings_ready" ||
        (record.scope !== record.session && record.scope !== "") ||
        !equal(parent.model, record.model) ||
        (record.scope === record.session && parent.policy !== record.policy) ||
        parent.destination !== record.destination
      )
        throw new Error("Prepared direction no longer matches its investigation")
      const originals = new Map(
        [...(parent.dependencies ?? []), ...parent.observations.flatMap((item) => item.sources)].map((item) => [
          item.id,
          item,
        ]),
      )
      const needed = new Set(record.findings.flatMap((item) => [...item.evidence, ...item.counterevidence]))
      if (
        record.findings.some((item) => !parent.findings.some((original) => equal(original, item))) ||
        needed.size !== record.sources.length ||
        record.sources.some((item) => !needed.has(item.id) || !equal(originals.get(item.id), item))
      )
        throw new Error("Prepared evidence does not match the chosen findings")
      if (!equal(record.dependencies, [...originals.values()]))
        throw new Error("Prepared privacy dependencies were changed")
      await tools.check({ ...parent, session: record.session, policy: record.policy }, signal)
    },
    write: async (input) => {
      if (!ports.write) throw new Error("This host does not support the investigation prompt writer")
      return ports.write(input)
    },
  })
  async function bind(
    input: { binding: PreparationBinding; text: string; session: string; model: EnhancementModel },
    signal?: AbortSignal,
  ) {
    const reference = decode(PreparationBinding, input.binding)
    const local = await ports.store.prepared(ports.root, input.session, reference.id)
    if (reference.session && reference.session !== input.session)
      throw new Error("Prepared prompt belongs to a different session")
    const previous =
      reference.session === ""
        ? await ports.store.prepared(ports.root, "", reference.id)
        : (local ?? (await ports.store.prepared(ports.root, "", reference.id)))
    if (
      !previous ||
      previous.state !== "ready" ||
      previous.revision !== reference.revision ||
      previous.hash !== reference.hash ||
      hash(input.text) !== reference.hash
    )
      throw new Error("Prepared prompt changed; review and stage its current revision")
    const record = await writer.get(previous.id, previous.session, signal)
    if (input.model.providerID !== record.model.providerID)
      throw new Error(
        "Prepared prompt uses a different provider; review sharing and regenerate for the selected provider",
      )
    if (record.session !== input.session) {
      if (record.session || (local && local.scope !== ""))
        throw new Error("A private prepared prompt cannot be moved to another session")
      const scope = await tools.scope(input.session, input.model, signal)
      if (scope.destination !== record.destination) throw new Error("Prepared prompt destination changed")
      if (local && local.hash === record.hash && local.policy === scope.policy) {
        const checked = await writer.get(local.id, local.session, signal)
        await ports.store.handoff(ports.root, checked.session, checked.id)
        return checked
      }
      const next: Prepared = {
        ...record,
        ...scope,
        session: input.session,
        revision: randomUUID(),
        updated: Date.now(),
      }
      await ports.store.preparedSave(next, local?.revision)
      const checked = await writer.get(next.id, next.session, signal)
      await ports.store.handoff(ports.root, checked.session, checked.id)
      return checked
    }
    await ports.store.handoff(ports.root, record.session, record.id)
    return record
  }
  async function handoff(session: string, model: EnhancementModel, signal?: AbortSignal, historical = false) {
    const sources = new Map<string, Source>()
    for (const key of await ports.store.handoffs(ports.root, session)) {
      const record = historical
        ? await ports.store.prepared(ports.root, session, key)
        : await writer.get(key, session, signal)
      if (!record) throw new Error("Admitted preparation is unavailable")
      if (record.state !== "ready" || record.model.providerID !== model.providerID)
        throw new Error("Session contains prepared context that must be reviewed for this provider")
      // Coding may change original repository files; permission and destination
      // restrictions remain revocable after a prompt has been admitted.
      if (historical) await tools.admitted(record, signal)
      for (const source of record.dependencies) sources.set(source.id, source)
    }
    return [...sources.values()]
  }
  return { research, writer, bind, handoff }
}
