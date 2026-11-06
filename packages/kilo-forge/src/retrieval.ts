import type { RetrievalRun } from "./schema"

type Channel = RetrievalRun["channels"][number]
const names = ["keyword", "semantic", "collection-semantic", "domains", "memory", "relationships", "public-docs", "dependency-docs"] as const

export function retrieval(save: (value: RetrievalRun) => Promise<void>) {
  const started = Date.now()
  const channels = new Map<Channel["name"], Channel>(names.map((name) => [name, { name, state: "pending" }]))
  let phase: RetrievalRun["phase"] = "setup"
  let generation: string | undefined
  let closed = false
  let completed = false
  let failure: { error: unknown } | undefined
  let writing = Promise.resolve()

  function publish(state: RetrievalRun["state"] = "running") {
    const updated = Date.now()
    const value: RetrievalRun = {
      started,
      updated,
      phase,
      state,
      generation,
      ...(state === "running" ? {} : { finished: updated }),
      channels: [...channels.values()].map((item) => ({ ...item })),
    }
    writing = writing
      .then(() => {
        if (!failure) return save(value)
      })
      .catch((error) => {
        failure = { error }
      })
  }

  function mark(name: Channel["name"], state: Channel["state"]) {
    if (closed) return
    const previous = channels.get(name)!
    channels.set(name, {
      ...previous,
      state,
      ...(state === "running" ? { started: Date.now() } : { finished: Date.now() }),
    })
    publish()
  }

  publish()
  return {
    mark,
    phase(value: RetrievalRun["phase"], version?: string) {
      if (closed) return
      phase = value
      if (version) generation = version
      publish()
    },
    async run<A>(name: Channel["name"], fn: () => Promise<A> | A) {
      if (closed) throw new Error("Retrieval execution history is closed")
      mark(name, "running")
      try {
        const result = await fn()
        mark(name, "completed")
        return result
      } catch (err) {
        mark(name, "failed")
        throw err
      }
    },
    async finish(state: Exclude<RetrievalRun["state"], "running">) {
      // Final validation can reject a result after its completion write drains.
      // Never promote a failure/cancellation or reopen late channel activity.
      if (!closed || (completed && state !== "completed")) {
        closed = true
        completed = state === "completed"
        for (const [name, channel] of channels) {
          if (channel.state === "running") channels.set(name, { ...channel, state: "abandoned", finished: Date.now() })
        }
        publish(state)
      }
      await writing
      if (failure) throw failure.error
    },
  }
}

export type Journal = ReturnType<typeof retrieval>

export function progress(value?: RetrievalRun) {
  if (!value) return ["Retrieval execution history unavailable for this capture."]
  return [
    `Retrieval execution: ${value.state}; last phase: ${value.phase}.`,
    ...value.channels.map(
      (item) =>
        `${item.name}: ${item.state}${item.started == null || item.finished == null ? "" : ` (${Math.max(0, item.finished - item.started)} ms)`}.`,
    ),
    "Execution observations do not imply selected evidence or provider transmission. Abandoned results were not accepted; adapters may have continued running. Pending channels were not observed started. Running is the last persisted state, not proof of a live process.",
  ]
}
