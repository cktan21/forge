import { createEffect, createSignal, For, onCleanup, Show, untrack } from "solid-js"
import type { Collection, Registry, Registration, Preview } from "@kilocode/forge/schema"
import { activity, outcome } from "@kilocode/forge/imports"
import { Imports } from "./imports"
import { Embeddings } from "./embeddings"

type Request = <A>(path: string, init?: { method?: string; body?: unknown; query?: Record<string, string>; signal?: AbortSignal }) => Promise<A>

export function Knowledge(props: { request: Request; session: string; generation?: string; changed: () => void }) {
  const [registry, setRegistry] = createSignal<Registry>({ collections: [], provider: "", generation: "", page: { offset: 0, limit: 10, total: 0 } })
  const [query, setQuery] = createSignal("")
  const [search, setSearch] = createSignal("")
  const [paging, setPaging] = createSignal(false)
  const [kind, setKind] = createSignal<Registration["kind"]>("folder")
  const [label, setLabel] = createSignal("")
  const [location, setLocation] = createSignal("")
  const [content, setContent] = createSignal("")
  const [privateScope, setPrivateScope] = createSignal(false)
  const [watch, setWatch] = createSignal(true)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal("")
  const [review, setReview] = createSignal<{ input: Registration; preview: Preview }>()
  const [inspecting, setInspecting] = createSignal<string>()
  const [embedding, setEmbedding] = createSignal<{ id: string; label: string }>()
  createEffect(() => { props.session; setInspecting(undefined); setEmbedding(undefined) })
  createEffect(() => { kind(); label(); location(); content(); privateScope(); watch(); setReview(undefined) })
  const controller = new AbortController()
  let sequence = 0
  let position = 0
  let filter = ""
  const refresh = async (offset = position, text = filter) => {
    position = offset
    filter = text
    const current = ++sequence
    setPaging(true)
    try {
      const value = await props.request<Registry>("knowledge", { query: { offset: String(offset), limit: "10", query: text, ...(text === search() && registry().generation ? { generation: registry().generation } : {}) }, signal: controller.signal })
      if (current === sequence && !controller.signal.aborted) { position = value.page.offset; setRegistry(value); setSearch(text) }
    } finally { if (current === sequence) setPaging(false) }
  }
  createEffect(() => { props.generation; untrack(() => { void refresh().catch((err) => { if (!controller.signal.aborted) setError(String(err)) }) }) })
  onCleanup(() => controller.abort())

  async function action(fn: () => Promise<unknown>) {
    if (busy()) return
    setBusy(true)
    setError("")
    try { await fn(); await refresh(); props.changed() } catch (err) { setError(err instanceof Error ? err.message : String(err)) } finally { setBusy(false) }
  }

  async function control(item: Collection, action: string, providers?: string[], grants?: Record<string, string>) {
    return props.request(`knowledge/${encodeURIComponent(item.id)}`, { method: "PUT", body: { action, session: item.session, providers, grants, ...(action === "purge" ? { confirmation: "PURGE" } : {}) } })
  }

  async function approve(item: Collection, providers: string[], grants: Record<string, string> = {}) {
    await control(item, "approve", providers, grants)
    await control(item, "index")
  }

  async function upload(file: File) {
    if (file.size > 20 * 1024 * 1024) throw new Error("Uploads are limited to 20 MiB")
    const bytes = new Uint8Array(await file.arrayBuffer())
    const parts: string[] = []
    for (let offset = 0; offset < bytes.length; offset += 8192) parts.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)))
    setContent(btoa(parts.join("")))
    setLocation(file.name)
    if (!label()) setLabel(file.name)
  }

  return <section class="discovery" aria-label="Knowledge library">
    <div><p class="eyebrow">KNOWLEDGE LIBRARY</p><h2>Add the knowledge Forge should work with.</h2><p class="muted">Document extraction is local. Coding-provider sharing and embedding indexing require separate approvals. Folder paths refer to the backend machine.</p></div>
    <Show when={error()}><p role="alert" class="alert">{error()}</p></Show>
    <Show when={registry().warning}><p role="status" class="muted">Provider sharing unavailable: {registry().warning}. Local registration, indexing and inspection remain available.</p></Show>
    <form onSubmit={(event) => {
      event.preventDefault()
      void action(async () => {
        const input = { kind: kind(), label: label(), location: location(), content: kind() === "text" || kind() === "upload" ? content() : undefined, session: privateScope() ? props.session : "", watch: kind() === "folder" && watch() }
        const preview = await props.request<Preview>("knowledge/preview", { method: "POST", body: input, signal: controller.signal })
        if (!controller.signal.aborted && JSON.stringify(input) === JSON.stringify({ kind: kind(), label: label(), location: location(), content: kind() === "text" || kind() === "upload" ? content() : undefined, session: privateScope() ? props.session : "", watch: kind() === "folder" && watch() })) setReview({ input, preview })
      })
    }}>
      <div class="actions">
        <label>Source type <select value={kind()} onChange={(event) => { setKind(event.currentTarget.value as Registration["kind"]); setContent(""); setLocation("") }}>
          <option value="folder">Folder on backend</option><option value="file">File on backend</option><option value="upload">Upload document</option><option value="url">Public URL</option><option value="text">Paste text</option>
        </select></label>
        <label>Label <input required maxlength={200} value={label()} onInput={(event) => setLabel(event.currentTarget.value)} /></label>
      </div>
      <Show when={kind() !== "text" && kind() !== "upload"}><label>{kind() === "url" ? "URL" : "Path"} <input required value={location()} onInput={(event) => setLocation(event.currentTarget.value)} placeholder={kind() === "url" ? "https://..." : "/path/to/documents"} /></label></Show>
      <Show when={kind() === "upload"}><input aria-label="Upload document" type="file" accept=".md,.mdx,.txt,.rst,.pdf,.docx,.html,.htm" onChange={(event) => { const file = event.currentTarget.files?.item(0); if (file) void action(() => upload(file)) }} /><p>{location()}</p></Show>
      <Show when={kind() === "text"}><textarea required aria-label="Knowledge text" value={content()} onInput={(event) => setContent(event.currentTarget.value)} placeholder="Paste reference material. Imported text is evidence, not instructions." /></Show>
      <div class="actions">
        <Show when={props.session}><label><input type="checkbox" checked={privateScope()} onChange={(event) => setPrivateScope(event.currentTarget.checked)} />Only this session</label></Show>
        <Show when={kind() === "folder"}><label><input type="checkbox" checked={watch()} onChange={(event) => setWatch(event.currentTarget.checked)} />Watch for changes</label></Show>
        <button type="submit" disabled={busy() || !label().trim() || ((kind() === "text" || kind() === "upload") && !content().trim())}>Preview before registering</button>
      </div>
      <p class="muted">Preview reads local files or explicitly fetches the public URL. It makes no model call and saves no knowledge. Limits: 5 sampled documents, 2 MiB each, 8 MiB total, 2000 visited entries, 30 seconds.</p>
    </form>
    <Show when={review()}>{(value) => <article aria-label="Ingestion preview">
      <h3>Ingestion preview</h3>
      <p>{value().preview.location || value().input.label} · {value().input.session ? "Session scope" : "Workspace scope"}</p>
      <p>{value().preview.partial ? "Partial inventory" : "Discovered inventory"}: {value().preview.files} files · {value().preview.bytes.toLocaleString()} bytes · {value().preview.excluded} excluded entries</p>
      <For each={value().preview.samples}>{(sample) => <details open><summary>{sample.name} · {sample.bytes} bytes</summary><pre>{sample.text || "No excerpt available"}</pre></details>}</For>
      <For each={value().preview.warnings}>{(warning) => <p class="alert">{warning}</p>}</For>
      <p>Samples are evidence, not instructions. Preview is not approval or a frozen snapshot: full indexing reads current content and may find additional errors. Indexing and provider sharing need separate approval.</p>
      <button disabled={busy()} onClick={() => {
        const input = value().input
        void action(async () => {
          await props.request<Collection>("knowledge", { method: "POST", body: input, signal: controller.signal })
          setReview(undefined)
          setContent("")
          setQuery(input.label)
          await refresh(0, input.label)
        })
      }}>Register locally</button>
      <button disabled={busy()} onClick={() => setReview(undefined)}>Cancel preview</button>
    </article>}</Show>
    <form onSubmit={(event) => { event.preventDefault(); void refresh(0, query()).catch((err) => setError(String(err))) }}>
      <label>Search collections <input value={query()} onInput={(event) => setQuery(event.currentTarget.value)} placeholder="Label or backend path" /></label>
      <button type="submit" disabled={paging() || busy()}>Find collections</button>
      <button type="button" disabled={paging() || busy()} onClick={() => { setQuery(""); void refresh(0, "").catch((err) => setError(String(err))) }}>All collections</button>
    </form>
    <nav aria-label="Collection pages">
      <p class="muted">Collection page {Math.floor(registry().page.offset / registry().page.limit) + 1} · {registry().page.total ?? registry().collections.length} matching registrations</p>
      <button disabled={paging() || busy() || !registry().page.offset} onClick={() => void refresh(Math.max(0, registry().page.offset - registry().page.limit)).catch((err) => setError(String(err)))}>Previous collections</button>
      <button disabled={paging() || busy() || registry().page.next == null} onClick={() => void refresh(registry().page.next).catch((err) => setError(String(err)))}>Next collections</button>
      <p class="muted">Search covers workspace and current-session registrations. Added or purged matches restart live pages; removed registrations remain visible for inspection or purge.</p>
    </nav>
    <Show when={!registry().collections.length}><p class="muted">{search() ? "No matching registrations." : "No registered documents yet. Repository indexing remains available above."}</p></Show>
    <Show when={inspecting()} keyed>{(id) => <Imports revision={props.generation} close={() => setInspecting(undefined)} load={(opts) => props.request(`knowledge/${encodeURIComponent(id)}/imports`, { query: { ...(opts.run ? { run: opts.run } : {}), offset: String(opts.offset), limit: "50" }, signal: opts.signal })} />}</Show>
    <Show when={embedding()} keyed>{(item) => <Embeddings id={item.id} label={item.label} request={props.request} session={props.session} generation={props.generation} close={() => setEmbedding(undefined)} changed={props.changed} />}</Show>
    <div class="ideas"><For each={registry().collections}>{(item) => <article>
      <span class="pill">{item.state}</span><h3>{item.label}</h3><p class="path">{item.location || "Pasted text"}</p>
      <p class="muted">{item.origin} · {item.session ? "Session scope" : "Workspace scope"} · {item.files} documents · {item.chunks} indexed records</p>
      <Show when={item.progress}>{(progress) => <p role="status">{progress().stage}: {progress().document || "collection"} · {progress().files} files · {progress().bytes.toLocaleString()} bytes · {progress().chunks} extracted records · updated {new Date(progress().updated).toLocaleTimeString()}<br />{activity(progress())}</p>}</Show>
      <Show when={item.result}>{(result) => <p>{outcome(result())}</p>}</Show>
      <p>Sharing grants: {item.providers.length ? item.providers.join(", ") : "Local only"}</p>
      <Show when={item.providers.includes(registry().provider) && item.grants?.[registry().provider] !== registry().destination?.fingerprint}><p class="alert">Routing changed or legacy approval: approve the current destination before model use.</p></Show>
      <For each={item.warnings}>{(warning) => <p class="muted">{warning}</p>}</For>
      <div class="actions">
        <button disabled={busy()} onClick={() => setInspecting(item.id)}>Inspect import history</button>
        <button disabled={busy()} onClick={() => setEmbedding({ id: item.id, label: item.label })}>Manage embeddings</button>
        <button disabled={busy() || item.state === "indexing"} onClick={() => void action(() => item.approved ? control(item, "index") : approve(item, []))}>{item.approved ? "Refresh documents" : "Approve local indexing"}</button>
        <Show when={registry().provider && registry().destination}><button disabled={busy()} onClick={() => {
          const provider = registry().provider
          const destination = registry().destination!
          const revoke = item.providers.includes(provider) && item.grants?.[provider] === destination.fingerprint
          if (!revoke && !window.confirm(`Allow selected passages from "${item.label}" with "${provider}"?\nAllowed endpoint origins: ${destination.origins.join(", ") || "None resolved: configure an explicit endpoint before model use"}\nRouting fingerprint: ${destination.fingerprint}\nStandard transport only; redirects and custom fetchers are blocked for registered knowledge.\nApplies to enhancement and coding. Local indexing does not require sharing.`)) return
          void action(() => approve(item, revoke ? [] : [provider], revoke ? {} : { [provider]: destination.fingerprint }))
        }}>{item.providers.includes(registry().provider) && item.grants?.[registry().provider] === registry().destination?.fingerprint ? "Revoke provider sharing" : `Allow use with ${registry().provider}`}</button></Show>
        <button disabled={busy()} onClick={() => void action(() => control(item, "pause"))}>Pause</button>
        <button disabled={busy()} onClick={() => { if (window.confirm("Remove this registration from future retrieval? Original files will not be changed.")) void action(() => control(item, "remove")) }}>Remove</button>
        <button disabled={busy()} onClick={() => { if (window.confirm("Purge this collection's managed content AND all workspace request captures and derived caches? Original files, chat transcripts, and already-sent provider content are not deleted.")) void action(() => control(item, "purge")) }}>Purge stored content</button>
      </div>
    </article>}</For></div>
  </section>
}
