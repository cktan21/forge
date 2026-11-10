import { createSignal } from "solid-js"
import { diagnostic, EnhancementError } from "@kilocode/forge/enhancement"
import type { EnhancementFailure } from "@kilocode/forge/schema"

type State =
  | { kind: "idle" }
  | { kind: "running"; controller: AbortController; message: string }
  | { kind: "failed"; message: string; failure?: EnhancementFailure }

export function operation(opts: { signal: AbortSignal; valid: () => boolean; cancelled: () => void }) {
  const [state, setState] = createSignal<State>({ kind: "idle" })
  const busy = () => state().kind === "running"
  function error(message: string) {
    if (busy()) return
    setState(message ? { kind: "failed", message } : { kind: "idle" })
  }
  return {
    busy,
    error: () => {
      const value = state()
      return value.kind === "failed" ? value.message : ""
    },
    failure: () => {
      const value = state()
      return value.kind === "failed" ? value.failure : undefined
    },
    status: () => {
      const value = state()
      return value.kind === "running" ? value.message : ""
    },
    setError: error,
    update: (message: string) => setState((value) => (value.kind === "running" ? { ...value, message } : value)),
    cancel: () => {
      const value = state()
      if (value.kind === "running") value.controller.abort()
    },
    run: async (message: string, action: (signal: AbortSignal) => Promise<void>) => {
      if (busy() || !opts.valid()) return
      const controller = new AbortController()
      const signal = AbortSignal.any([opts.signal, controller.signal])
      setState({ kind: "running", controller, message })
      try {
        await action(signal)
      } catch (err) {
        if (!opts.valid() || signal.aborted) return
        const value = err != null && typeof err === "object" ? err : undefined
        const message: unknown = value && Reflect.get(value, "message")
        const failure =
          err instanceof EnhancementError ? err.failure : diagnostic(value && Reflect.get(value, "failure"))
        setState({
          kind: "failed",
          message: typeof message === "string" ? message : "The request failed. Your input was preserved.",
          failure,
        })
      } finally {
        if (opts.valid() && signal.aborted) opts.cancelled()
        setState((value) => (value.kind === "running" && value.controller === controller ? { kind: "idle" } : value))
      }
    },
  }
}
