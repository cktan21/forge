import { createEffect, createSignal, For, onCleanup, Show, untrack } from "solid-js"
import { Coverage } from "./coverage"
import { Usage } from "./usage"
import { summary } from "@kilocode/forge/embedding-usage"
import {
  decode,
  EmbeddingReview,
  EmbeddingJob,
  EmbeddingJobs,
  EmbeddingApproval,
  EmbeddingRevocation,
} from "@kilocode/forge/schema"

export function Embeddings(props: {
  id: string
  label: string
  session: string
  generation?: string
  request: <A>(
    path: string,
    init?: { method?: string; body?: unknown; query?: Record<string, string>; signal?: AbortSignal },
  ) => Promise<A>
  close(): void
  changed(): void
}) {
  const [review, setReview] = createSignal<typeof EmbeddingReview.Type>()
  const [accepted, setAccepted] = createSignal(false)
  const [busy, setBusy] = createSignal("")
  const [message, setMessage] = createSignal("")
  const [error, setError] = createSignal("")
  const [jobs, setJobs] = createSignal<readonly EmbeddingJob[]>([])
  const [loading, setLoading] = createSignal(false)
  const [failure, setFailure] = createSignal("")
  const [observed, setObserved] = createSignal<number>()
  const [refresh, setRefresh] = createSignal(0)
  const [epoch, setEpoch] = createSignal(0)
  const active = () => jobs().some((job) => job.state === "queued" || job.state === "running")
  let controller: AbortController | undefined
  let observation: AbortController | undefined
  let disposed = false
  const clear = () => {
    setReview(undefined)
    setAccepted(false)
  }
  createEffect(() => {
    const id = props.id
    const session = props.session
    props.generation
    refresh()
    untrack(() => {
      observation?.abort()
      const pending = new AbortController()
      observation = pending
      setLoading(true)
      setFailure("")
      void props
        .request(`knowledge/${encodeURIComponent(id)}/embeddings/jobs`, {
          query: { session },
          signal: pending.signal,
        })
        .then((response) => {
          if (disposed || pending.signal.aborted || observation !== pending) return
          const rows = decode(EmbeddingJobs, response)
          if (rows.length > 16 || rows.some((job) => job.collection !== id || job.session !== session)) {
            throw new Error("Embedding job history does not match the active collection and session")
          }
          if (
            new Set(rows.map((job) => job.id)).size !== rows.length ||
            rows.some((job) =>
              [job.started, job.updated, job.progressed, ...(job.finished == null ? [] : [job.finished])].some(
                (time) => !Number.isFinite(new Date(time).getTime()),
              ),
            )
          ) {
            throw new Error("Embedding job history contains invalid identifiers or timestamps")
          }
          setJobs(rows)
          setObserved(Date.now())
        })
        .catch((err) => {
          if (disposed || pending.signal.aborted || observation !== pending) return
          setJobs([])
          setObserved(undefined)
          setFailure(err instanceof Error ? err.message : String(err))
        })
        .finally(() => {
          if (!disposed && observation === pending) setLoading(false)
        })
    })
  })
  createEffect(() => {
    props.generation
    // Mutations emit refresh events themselves; only pending observations become stale here.
    untrack(() => {
      if (busy() === "review") controller?.abort()
      clear()
    })
  })
  createEffect(() => {
    props.id
    props.session
    untrack(() => {
      controller?.abort()
      clear()
      setMessage("")
      setError("")
      setJobs([])
      setObserved(undefined)
    })
  })
  onCleanup(() => {
    disposed = true
    controller?.abort()
    observation?.abort()
  })

  async function run(action: "review" | "approve" | "revoke" | "index" | "cancel", job?: string) {
    if (busy()) return
    const previous = review()
    if (action === "approve" && (!previous || !accepted())) return
    if (action === "index" && (!previous?.approved || active() || loading() || failure())) return
    if (
      action === "cancel" &&
      (!job || !jobs().some((value) => value.id === job && ["queued", "running"].includes(value.state)))
    )
      return
    const pending = new AbortController()
    controller = pending
    setEpoch((value) => value + 1)
    setBusy(action)
    setMessage("")
    setError("")
    clear()
    const path = `knowledge/${encodeURIComponent(props.id)}/embeddings`
    const session = props.session
    try {
      if (action === "review") {
        const value = decode(EmbeddingReview, await props.request(path, { query: { session }, signal: pending.signal }))
        if (!pending.signal.aborted && !disposed) setReview(value)
        return
      }
      const suffix =
        action === "index" ? "jobs" : action === "cancel" ? `jobs/${encodeURIComponent(job!)}/cancel` : action
      const value = await props.request(path + "/" + suffix, {
        method: "POST",
        body: { session, ...(action === "approve" ? { revision: previous!.revision } : {}) },
        signal: pending.signal,
      })
      if (pending.signal.aborted || disposed) return
      if (action === "index") {
        const result = decode(EmbeddingJob, value)
        if (result.collection !== props.id || result.session !== session)
          throw new Error("Embedding job does not match this scope")
        setMessage(`Embedding job admitted: ${result.id}. Closing this panel does not cancel it.`)
      }
      if (action === "cancel") {
        if (!value || typeof value !== "object" || !("requested" in value) || value.requested !== true) {
          throw new Error("Embedding job cancellation was not acknowledged; refresh job history")
        }
        setMessage("Job cancellation requested. An admitted publication may have completed; inspect job history.")
      }
      if (action === "approve") {
        decode(EmbeddingApproval, value)
        setMessage("Embedding destination approved. No indexing was started. Review again to enable explicit indexing.")
      }
      if (action === "revoke") {
        decode(EmbeddingRevocation, value)
        setMessage(
          "Embedding consent revoked. Previously sent text cannot be retracted; cached vectors are not deleted by revocation.",
        )
      }
      props.changed()
      setRefresh((value) => value + 1)
    } catch (err) {
      if (disposed) return
      clear()
      if (pending.signal.aborted) {
        setMessage("Request cancelled. An admitted job may still be running; refresh job history before retrying.")
        return
      }
      setError(err instanceof Error ? err.message : String(err))
      setRefresh((value) => value + 1)
    } finally {
      if (!disposed && controller === pending) {
        controller = undefined
        setBusy("")
        if (pending.signal.aborted) setRefresh((value) => value + 1)
      }
    }
  }

  return (
    <article aria-label="Collection embeddings">
      <h3>Collection embeddings: {props.label}</h3>
      <p>
        Document extraction is local. Embedding indexing sends eligible original sections to the endpoint below;
        semantic queries also go there. Coding-provider sharing is a separate approval. No embedding request is made by
        opening or reviewing this panel.
      </p>
      <p class="muted">
        Configure KILO_FORGE_EMBEDDING_ENDPOINT, KILO_FORGE_EMBEDDING_MODEL and KILO_FORGE_EMBEDDING_DIMENSIONS on the
        backend. Optional credentials belong in KILO_FORGE_EMBEDDING_KEY, never in a document.
      </p>
      <Show when={busy()}>
        <p role="status">
          {busy() === "index"
            ? "Starting embedding job; waiting for admission."
            : "Waiting for embedding " + busy() + "..."}
        </p>
      </Show>
      <Show when={message()}>
        <p role="status">{message()}</p>
      </Show>
      <Show when={error()}>
        <p role="alert">{error()}</p>
      </Show>
      <Show when={review()}>
        {(value) => (
          <>
            <dl>
              <dt>Exact embedding endpoint</dt>
              <dd class="path">{value().endpoint}</dd>
              <dt>Model</dt>
              <dd>{value().target.model}</dd>
              <dt>Dimensions</dt>
              <dd>{value().target.dimensions}</dd>
              <dt>Routing fingerprint</dt>
              <dd class="path">{value().target.fingerprint}</dd>
              <dt>Observed approval</dt>
              <dd>{value().approved ? "Approved for this destination" : "Not approved for this destination"}</dd>
            </dl>
            <p>
              Approval allows future explicit indexing of current eligible sections and semantic query requests. Changes
              to endpoint or model require another approval. Live permissions, exclusions and freshness are still
              enforced.
            </p>
            <Show when={!value().approved}>
              <label>
                <input
                  type="checkbox"
                  checked={accepted()}
                  onChange={(event) => setAccepted(event.currentTarget.checked)}
                />
                I approve sending collection sections and semantic queries to this exact destination.
              </label>
            </Show>
          </>
        )}
      </Show>
      <div class="actions">
        <button disabled={!!busy()} onClick={() => void run("review")}>
          Review embedding destination
        </button>
        <button
          disabled={!!busy() || !review() || review()?.approved || !accepted()}
          onClick={() => void run("approve")}
        >
          Approve embedding destination
        </button>
        <button
          disabled={!!busy() || !review()?.approved || active() || loading() || !!failure()}
          onClick={() => void run("index")}
        >
          Index embeddings
        </button>
        <button disabled={!!busy()} onClick={() => void run("revoke")}>
          Revoke embedding consent
        </button>
        <Show when={busy()}>
          <button onClick={() => controller?.abort()}>Cancel embedding request</button>
        </Show>
        <button
          onClick={() => {
            controller?.abort()
            props.close()
          }}
        >
          Close embeddings
        </button>
      </div>
      <Coverage
        id={props.id}
        session={props.session}
        generation={`${props.generation ?? ""}:${epoch()}`}
        disabled={!!busy()}
        inspect={(signal) =>
          props.request(`knowledge/${encodeURIComponent(props.id)}/embeddings/coverage`, {
            query: { session: props.session },
            signal,
          })
        }
      />
      <Usage
        id={props.id}
        session={props.session}
        generation={`${props.generation ?? ""}:${epoch()}`}
        disabled={!!busy()}
        read={(request, signal) => props.request("embeddings/usage", {
          query: { session: request.session, limit: String(request.limit), ...(request.after == null ? {} : { after: request.after }) },
          signal,
        })}
      />
      <section aria-label="Embedding job history">
        <h4>Embedding jobs in this session</h4>
        <p>
          Latest 16 retained jobs. Completed counts describe that operation, not a guarantee of current coverage. Counts
          are not provider usage or billing.
        </p>
        <Show when={loading()}>
          <p>Refreshing job history...</p>
        </Show>
        <Show when={failure()}>
          <p role="alert">Job history unavailable: {failure()}</p>
        </Show>
        <Show when={observed()}>
          <p class="muted">
            Last observation: {new Date(observed()!).toISOString()}. Updates depend on the workspace connection; refresh
            to check again.
          </p>
        </Show>
        <Show when={!loading() && !failure() && !jobs().length}>
          <p>No retained embedding jobs in this session.</p>
        </Show>
        <For each={jobs()}>
          {(job) => (
            <div aria-label={`Embedding job ${job.id}`}>
              <p class="path">
                Job {job.id}: {job.state}
              </p>
              <p>
                Phase: {job.progress.phase}. Processed {job.progress.processed} of {job.progress.sections ?? "unknown"}{" "}
                sections; {job.progress.embedded} newly embedded, {job.progress.reused} reused.
              </p>
              <p class="path">
                Model: {job.target.model}. Dimensions: {job.target.dimensions}. Routing fingerprint:{" "}
                {job.target.fingerprint}
              </p>
              <p class="muted">
                Started: {new Date(job.started).toISOString()}. Last checkpoint: {new Date(job.updated).toISOString()}.
                Last material progress: {new Date(job.progressed).toISOString()}.
              </p>
              <Show when={job.finished != null}>
                <p>Finished: {new Date(job.finished!).toISOString()}</p>
              </Show>
              <Show when={job.state === "completed" && job.result}>
                {(result) => (
                  <p>
                    Index published: {result().sections} sections, {result().embedded} newly embedded, {result().reused}{" "}
                    reused.
                  </p>
                )}
              </Show>
              <Show when={job.error}>
                <p>{job.error}</p>
              </Show>
              <p aria-label="Embedding job usage" style={{ "white-space": "pre-line" }}>
                {summary(job.usage)}
              </p>
              <Show when={job.state === "queued" || job.state === "running"}>
                <p>
                  Background work continues after closing. Checkpoints are heartbeats, not proof of progress; a stalled
                  call may wait for its deadline.
                </p>
                <button disabled={!!busy() || loading() || !!failure()} onClick={() => void run("cancel", job.id)}>
                  Cancel embedding job {job.id}
                </button>
              </Show>
            </div>
          )}
        </For>
        <button disabled={loading()} onClick={() => setRefresh((value) => value + 1)}>
          Refresh embedding jobs
        </button>
      </section>
      <p class="muted">
        Review is an observation, not a readiness guarantee. Closing cancels observation and pending client requests,
        not an admitted background job. Use its Cancel embedding job button to stop it. Cancellation cannot retract sent
        bytes or roll back a write already admitted by the server.
      </p>
    </article>
  )
}
