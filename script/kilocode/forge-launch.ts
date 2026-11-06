import { spawn } from "../../packages/core/src/pty/driver"
import { mkdtemp, mkdir, rm, chmod, realpath } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { Collection, EmbeddingLedger, ImportHistory, Registry, Status, View, decode } from "../../packages/kilo-forge/src/schema"
import { observe } from "./forge-launch-observe"
import { screen } from "./forge-terminal"

// Opt-in real-terminal probe. Temporary state and a local inference trap keep it model-free.
const root = path.resolve(import.meta.dirname, "../..")
const modes = process.argv.slice(3).length ? process.argv.slice(3) : ["dev", "dev:watch"]
const repetitions = Number(process.env.FORGE_LAUNCH_RUNS ?? "1")
const documents = Number(process.env.FORGE_LAUNCH_DOCUMENTS ?? "0")
const restart = process.env.FORGE_LAUNCH_RESTART === "1"
const indexing = process.env.FORGE_LAUNCH_REPOSITORY === "1"
const usage = process.env.FORGE_LAUNCH_USAGE === "1"
const binary = process.env.FORGE_LAUNCH_BINARY
if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 10)
  throw new Error("FORGE_LAUNCH_RUNS must be 1..10")
if (!Number.isInteger(documents) || documents < 0 || documents > 1000)
  throw new Error("FORGE_LAUNCH_DOCUMENTS must be 0..1000")
if (restart && documents < 2) throw new Error("Restart verification requires at least two documents")
if (usage && !documents) throw new Error("Usage verification requires a registered document collection")
if (modes.some((mode) => !["dev", "dev:watch", "forge", "packaged"].includes(mode))) throw new Error("Use dev, dev:watch, forge, or packaged")
if (modes.includes("packaged") && !binary) throw new Error("Packaged verification requires FORGE_LAUNCH_BINARY")
if (process.platform !== "darwin") throw new Error("This probe currently intercepts the macOS browser opener only")
const temporary = await mkdtemp(path.join(os.tmpdir(), "forge-launch-"))
const fixture = path.join(temporary, "workspace")
await mkdir(fixture)
if (indexing && process.argv[2] === "--fixture")
  await Bun.write(path.join(fixture, "queue.ts"), "export function dispatch(epoch: number) { return epoch > 0 }\n")
const directory = await realpath(process.argv[2] === "--fixture" ? fixture : path.resolve(process.argv[2] ?? root))
const calls: string[] = []
const late: string[] = []
let opening = ""
let opened = Promise.withResolvers<string>()
const trap = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (new URL(request.url).pathname === "/opened") {
      if (request.headers.get("x-forge-launch") !== opening) {
        late.push(request.headers.get("x-forge-launch") ?? "missing")
        return new Response("Opener belongs to a previous launch", { status: 409 })
      }
      opened.resolve(await request.text())
      return new Response("Captured browser target")
    }
    calls.push(new URL(request.url).pathname)
    return new Response("Inference is forbidden in this launch probe", { status: 503 })
  },
})
const rows: Record<string, unknown>[] = []
const saved = new Map<number, { session: string; collection: string; generation: string; inventory: Status["inventory"]; history: ImportHistory["runs"]; content: string; unchanged: string[] }>()
function metadata(value: unknown) {
  if (value == null || typeof value !== "object") throw new Error("Invalid status response")
  // The HTTP codec represents absent optional request records as null.
  return decode(Status, {
    ...value,
    ...("coding" in value && value.coding === null ? { coding: undefined } : {}),
    ...("preparation" in value && value.preparation === null ? { preparation: undefined } : {}),
  })
}
try {
  const bin = path.join(temporary, "bin")
  await mkdir(bin)
  const manuals = path.join(temporary, "manuals")
  if (documents) {
    await mkdir(manuals)
    for (let index = 0; index < documents; index++) {
      await Bun.write(path.join(manuals, `service-${index}.md`), `# Service ${index}\n\nService ${index} owns its retry queue and epoch lease. Expired owners must stop processing before reassignment.\n\n## Verification\n\nCheck owner identity before publishing the result. Preserve the original task on retry.\n`)
    }
  }
  await Bun.write(
    path.join(bin, "open"),
    `#!${process.execPath}\nawait fetch(${JSON.stringify(`${trap.url}opened`)}, {method:"POST", headers:{"x-forge-launch":process.env.FORGE_LAUNCH_ID}, body:process.argv.at(-1)})\n`,
  )
  await chmod(path.join(bin, "open"), 0o700)
  const launches = Array.from({ length: repetitions }, () => modes).flat()
    .flatMap((mode, pair) => restart ? [{ mode, pair, resumed: false }, { mode, pair, resumed: true }] : [{ mode, pair, resumed: false }])
  for (const [iteration, launch] of launches.entries()) {
    const mode = launch.mode
    const previous = launch.resumed ? saved.get(launch.pair) : undefined
    if (launch.resumed && !previous) throw new Error("Restart state was not saved")
    const session = previous?.session ?? ""
    opening = String(iteration)
    opened = Promise.withResolvers<string>()
    const home = path.join(temporary, `${launch.pair}-${mode.replace(":", "-")}`)
    await mkdir(home, { recursive: true })
    if (restart) {
      // These writes occur after the preceding process has exited; no watcher drives the update.
      const marker = launch.resumed ? `forgeupdated${launch.pair}` : `forgeoriginal${launch.pair}`
      await Bun.write(path.join(manuals, "service-0.md"), `# Service zero\n\n${marker} owns the lease.\n\n## Verification\n\nVerify ${marker} before publishing.\n`)
      if (!launch.resumed) await Bun.write(path.join(manuals, "service-1.md"), "# Stable service\n\nforgeunchanged owns its queue.\n\n## Verification\n\nPreserve forgeunchanged through restart.\n")
    }
    let url = ""
    const headers = {
      authorization: `Basic ${Buffer.from("kilo:forge-launch-probe").toString("base64")}`,
      "x-opencode-directory": directory,
    }
    const started = performance.now()
    let exited = false
    const done = Promise.withResolvers<void>()
    const pending = new Set<() => void>()
    const args = [directory, ...(session ? ["--session", session] : [])]
    const proc = spawn(mode === "packaged" ? binary! : process.execPath, mode === "packaged" ? args : ["run", "--cwd", root, mode, ...args], {
      name: "xterm-256color",
      cols: 140,
      rows: 48,
      cwd: root,
      env: {
        BUN_BE_BUN: "",
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        HOME: home,
        KILO_TEST_HOME: home,
        XDG_CONFIG_HOME: path.join(home, "config"),
        XDG_DATA_HOME: path.join(home, "data"),
        XDG_STATE_HOME: path.join(home, "state"),
        XDG_CACHE_HOME: path.join(home, "cache"),
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        KILO_AUTH_CONTENT: "{}",
        KILO_DISABLE_PROJECT_CONFIG: "1",
        KILO_DISABLE_MODELS_FETCH: "1",
        KILO_DISABLE_AUTOUPDATE: "1",
        KILO_TELEMETRY_LEVEL: "off",
        KILO_SERVER_PASSWORD: "forge-launch-probe",
        FORGE_LAUNCH_ID: opening,
        KILO_CONFIG_CONTENT: JSON.stringify({
          model: "probe/test",
          small_model: "probe/test",
          enabled_providers: ["probe"],
          provider: {
            probe: {
              npm: "@ai-sdk/openai-compatible",
              options: { baseURL: `${trap.url}v1`, apiKey: "fixture" },
              models: { test: { name: "Launch probe", limit: { context: 32000, output: 4000 } } },
            },
          },
          snapshot: false,
          formatter: false,
          lsp: false,
        }),
      },
    })
    using terminal = screen((reply) => proc.write(reply), () => {
      for (const notify of pending) notify()
    })
    const data = proc.onData((chunk) => {
      void terminal.write(chunk).catch((err: unknown) => console.error("Terminal observation failed", err))
    })
    const exit = proc.onExit(() => {
      exited = true
      done.resolve()
      for (const notify of pending) notify()
    })
    async function wait(value: string, timeout = 60_000, visible = true) {
      const result = Promise.withResolvers<void>()
      const check = () => {
        try {
          const text = terminal.text()
          if (text.replace(/\s/g, "").includes(value.replace(/\s/g, "")) === visible) result.resolve()
          if (exited) result.reject(new Error(`Launch exited before ${value}: ${text}`))
        } catch (err) {
          result.reject(err)
        }
      }
      const timer = setTimeout(() => {
        try {
          result.reject(new Error(`Timed out waiting for ${visible ? "" : "absence of "}${value}: ${terminal.text()}`))
        } catch (err) {
          result.reject(err)
        }
      }, timeout)
      pending.add(check)
      check()
      try {
        await result.promise
      } finally {
        clearTimeout(timer)
        pending.delete(check)
      }
    }
    async function read(route: string, body?: unknown, method = "GET") {
      const target = new URL(route, url)
      if (session && method === "GET" && target.pathname.startsWith("/forge/")) target.searchParams.set("session", session)
      const response = await fetch(target, {
        headers: { ...headers, ...(body == null ? {} : { "content-type": "application/json" }) },
        body: body == null ? undefined : JSON.stringify(body), method, signal: AbortSignal.timeout(5000),
      }).catch((err: unknown) => { throw new Error(`${method} ${route} failed`, { cause: err }) })
      if (!response.ok) throw new Error(`${route}: ${response.status} ${await response.text()}`)
      return response
    }
    async function browser() {
      const timer = setTimeout(
        () => opened.reject(new Error(`Map did not request browser open: ${terminal.text()}`)),
        5000,
      )
      try { url = new URL(await opened.promise).origin } finally { clearTimeout(timer) }
    }
    async function evidence(query: string) {
      return decode(View, await (await read(`/forge/view?query=${encodeURIComponent(query)}`)).json()).sources
    }
    async function history(collection: string) {
      return decode(ImportHistory, await (await read(`/forge/knowledge/${collection}/imports`)).json()).runs
    }
    const measured: Record<string, unknown> = { mode, iteration, phase: launch.resumed ? "resumed" : "fresh" }
    try {
      await wait("Launch probe")
      if (session) await wait("Saved launch probe answer")
      const startup = performance.now() - started
      measured.startup = startup
      const began = performance.now()
      proc.write("\x15\x1b[200~/overview knowledge\x1b[201~\r")
      await wait("Forge · overview · agent knowledge")
      if (!launch.resumed) await wait("No inventory yet.")
      const cold = performance.now() - began
      if (launch.resumed) await wait(indexing ? "files inspected" : `document: ${documents * 3}`, 5000)
      const progress = performance.now() - began
      Object.assign(measured, { cold, progress })
      const population = documents ? await (async () => {
        proc.write("m")
        await browser()
        const began = performance.now()
        const collection = previous?.collection ?? decode(Collection, await (await read("/forge/knowledge", { kind: "folder", label: "Launch manuals", location: manuals, watch: false }, "POST")).json()).id
        const inspection: Array<{ elapsed: number; inventory: Status["inventory"]; collection: Collection }> = []
        measured.inspection = inspection
        if (previous) {
          for (let index = 0; index < 3; index++) {
            const started = performance.now()
            const state = metadata(await (await read("/forge/status")).json())
            const stale = await evidence(`forgeoriginal${launch.pair}`)
            if (!stale.length || stale.some((source) => source.status !== "unavailable")) throw new Error("Restart exposed stale document evidence as usable")
            if ((await evidence(`forgeupdated${launch.pair}`)).length) throw new Error("Read-only startup scanned the offline edit")
            const registry = decode(Registry, await (await read("/forge/knowledge")).json())
            const current = registry.collections.find((value) => value.id === collection)
            if (!current || current.state !== "registered" || current.watch || current.generation !== previous.generation) throw new Error("Read-only startup changed the saved collection content or started indexing")
            if (JSON.stringify(await history(collection)) !== JSON.stringify(previous.history)) throw new Error("Read-only startup created an import run")
            if (state.job.state !== "idle") throw new Error("Read-only startup started repository indexing")
            for (const key of ["root", "revision", "observed", "files", "partial", "indexed", "counts"] as const) {
              if (JSON.stringify(state.inventory[key]) !== JSON.stringify(previous.inventory[key])) throw new Error(`Restart changed saved inventory ${key}`)
            }
            inspection.push({ elapsed: performance.now() - started, inventory: state.inventory, collection: current })
          }
        }
        if (!launch.resumed) await read(`/forge/knowledge/${collection}`, { action: "approve", providers: [], grants: {} }, "PUT")
        // Reconciliation is explicitly requested only after unavailable inventory and
        // unchanged import history have been verified through the real read routes.
        const refresh = performance.now()
        await read(`/forge/knowledge/${collection}`, { action: "index", session }, "PUT")
        const deadline = performance.now() + 90_000
        while (true) {
          const registry = decode(Registry, await (await read("/forge/knowledge")).json())
          const current = registry.collections.find((value) => value.id === collection)
          if (current?.state === "ready") {
            if (current.files !== documents || current.chunks <= documents || current.providers.length) throw new Error("Populated collection does not match the locally approved fixture")
            const state = metadata(await (await read("/forge/status")).json())
            if (previous) {
              const updated = await evidence(`forgeupdated${launch.pair}`)
              if (!updated.length || updated.some((source) => source.status !== "current")) throw new Error("Offline edit was not reconciled")
              const content = new Bun.CryptoHasher("sha256").update(await Bun.file(path.join(manuals, "service-0.md")).arrayBuffer()).digest("hex")
              if (content === previous.content || updated.some((source) => source.detail.fileHash !== content)) throw new Error("Reconciled evidence does not match the offline file bytes")
              if ((await evidence(`forgeoriginal${launch.pair}`)).length) throw new Error("Old document text survived reconciliation")
              const unchanged = (await evidence("forgeunchanged")).map((source) => `${source.id}:${source.hash}`).sort()
              if (JSON.stringify(unchanged) !== JSON.stringify(previous.unchanged)) throw new Error("Unchanged evidence identity was not preserved")
              if (current.generation === previous.generation) throw new Error("Offline edit did not advance collection content generation")
            }
            return { collection, documents: current.files, chunks: current.chunks, generation: state.inventory.generation, registration: current, history: await history(collection), elapsed: performance.now() - began, refresh: performance.now() - refresh, explicit: true, reconciled: launch.resumed, inspection, previous }
          }
          if (current?.state === "failed" || performance.now() > deadline) throw new Error(`Collection indexing did not finish: ${JSON.stringify(current)}`)
          await Bun.sleep(100)
        }
      })() : undefined
      measured.population = population
      const repository = indexing ? await (async () => {
        if (!url) { proc.write("m"); await browser() }
        const began = performance.now()
        if (!launch.resumed) await read("/forge/index", {}, "POST")
        const deadline = performance.now() + 120_000
        let stage = ""
        const reads: Array<{ elapsed: number; stage?: string; error?: string }> = []
        measured.repositoryReads = reads
        while (true) {
          const started = performance.now()
          const state = await observe(
            async () => metadata(await (await read("/forge/status")).json()),
            (error) => {
              reads.push({ elapsed: performance.now() - started, error })
              console.error(`Repository status failed: ${error}`)
              if (exited || performance.now() > deadline) throw new Error(error)
            },
          )
          if (!state) continue
          reads.push({ elapsed: performance.now() - started, stage: state.job.message })
          if (state.job.message !== stage) {
            stage = state.job.message
            console.error(`Repository stage: ${stage}`)
          }
          if (state.inventory.indexed && (launch.resumed || state.job.state === "completed")) {
            if (!state.inventory.files || !state.inventory.counts.code) throw new Error("Repository fixture has no indexed code")
            if (population && (state.inventory.counts.document ?? 0) < population.chunks) throw new Error("Repository refresh erased imported documents")
            return { elapsed: performance.now() - began, inventory: state.inventory, job: state.job, resumed: launch.resumed, reads }
          }
          if (state.job.state === "failed" || performance.now() > deadline) throw new Error(`Repository indexing did not finish: ${JSON.stringify(state.job)}`)
          await Bun.sleep(100)
        }
      })() : undefined
      if (launch.resumed && population) {
        await wait(`document: ${repository?.inventory.counts.document ?? population.chunks}`, 5000)
        if (repository) {
          const page = decode(View, await (await read("/forge/view?limit=25")).json())
          await wait(`Source generation: ${page.generation}`, 5000)
          proc.write("\x1b[6~")
          await terminal.resize(143, 48)
          proc.resize(143, 48)
        }
        const total = repository
          ? Object.values(repository.inventory.counts).reduce((sum, count) => sum + count, 0)
          : population.chunks
        await wait(`Page 1 · ${Math.min(25, total)} sources`, 5000)
      }
      const ready = performance.now() - began
      const samples: { command: string; elapsed: number; useful: number }[] = []
      for (let index = 0; index < 20; index++) {
        proc.write("r")
        await wait("Forge ·", 5000, false)
        await wait("Launch probe", 5000)
        // Let the closing dialog's frame and keyboard cleanup finish before pasting.
        await Bun.sleep(50)
        const command = index % 2 ? "overview" : "map"
        const began = performance.now()
        proc.write(`\x15\x1b[200~/${command} knowledge\x1b[201~\r`)
        await wait(`Forge · ${command} · agent knowledge`, 5000)
        await wait(repository ? `${repository.inventory.files} files inspected` : population ? `document: ${population.chunks}` : "No inventory yet.", 5000)
        const useful = performance.now() - began
        if (repository) {
          await wait(`code: ${repository.inventory.counts.code}`, 5000)
          const page = decode(View, await (await read("/forge/view?limit=25")).json())
          if (page.generation !== repository.inventory.generation) throw new Error("Source page does not match published repository generation")
          // The independent API read does not prove the UI has laid out its
          // source page yet. An earlier scroll can be clamped to empty content.
          await wait(`Source generation: ${page.generation}`, 5000)
          proc.write("\x1b[6~")
          await terminal.resize(index % 2 ? 142 : 141, 48)
          proc.resize(index % 2 ? 142 : 141, 48)
          await wait(`Page 1 · ${Math.min(25, Object.values(repository.inventory.counts).reduce((total, count) => total + count, 0))} sources`, 5000)
        } else if (population) await wait(`Page 1 · ${Math.min(25, population.chunks)} sources`, 5000)
        samples.push({ command, elapsed: performance.now() - began, useful })
        if (index === 0) await browser()
        const state = metadata(await (await read("/forge/status")).json())
        if (state.job.state !== (repository?.job.state ?? "idle"))
          throw new Error(`Index started at sample ${index} (${command}): ${terminal.text()}`)
        if (repository && (JSON.stringify(state.inventory) !== JSON.stringify(repository.inventory) || JSON.stringify(state.job) !== JSON.stringify(repository.job)))
          throw new Error(`Opening ${command} changed repository metadata or indexing job`)
        if (!repository && population && (state.inventory.generation !== population.generation || state.inventory.counts.document !== population.chunks))
          throw new Error(`Opening ${command} changed the populated library`)
        if (population) {
          const registry = decode(Registry, await (await read("/forge/knowledge")).json())
          if (JSON.stringify(registry.collections.find((value) => value.id === population.collection)) !== JSON.stringify(population.registration)
            || JSON.stringify(await history(population.collection)) !== JSON.stringify(population.history)) throw new Error(`Opening ${command} started or changed a collection job`)
        }
      }
      if (usage) {
        proc.write("k")
        await wait("Forge knowledge library", 5000)
        await wait("Launch manuals", 5000)
        proc.write("e")
        await wait("Collection embeddings: Launch manuals", 5000)
        proc.write("u")
        await wait("Recorded embedding usage across this session", 5000)
        if (terminal.text().includes("observed attempts in this page")) throw new Error("Usage was inspected automatically")
        proc.write("r")
        await wait("0 observed attempts in this page", 5000)
        await wait("does not prove complete historical usage", 5000)
        await wait("[d] Show observed attempt records", 5000)
        proc.write("d")
        await wait("[d] Show page subtotals", 5000)
        proc.write("d")
        await wait("[d] Show observed attempt records", 5000)
        proc.write("\x1b[6~")
        // The scrollbar separates wrapped lines in the screen buffer.
        await wait("Use kilo forge-usage or the browser to export JSON.", 5000)
        await wait("Changes without a delivered event", 5000)
        await wait("require reinspection.", 5000)
        const ledger = decode(EmbeddingLedger, await (await read("/forge/embeddings/usage")).json())
        if (ledger.session !== session || ledger.entries.length) throw new Error("Usage does not match the exact empty session ledger")
        console.error(`FORGE_LAUNCH_USAGE ${JSON.stringify({ phase: measured.phase, session, screen: terminal.text() })}`)
        for (const expected of ["Collection embeddings: Launch manuals", "Forge knowledge library", "agent knowledge"]) {
          proc.write("q")
          await wait(expected, 5000)
        }
        measured.usage = true
      }
      const target = new URL(await opened.promise)
      if (target.searchParams.get("directory") !== directory || (target.searchParams.get("session") ?? "") !== session || !target.hash.includes("authorization"))
        throw new Error("Map scope/authentication was not propagated")
      url = target.origin
      const status = (await (await read("/forge/status")).json()) as {
        inventory: { root: string; indexed: boolean }
        session: string
        job: { state: string }
      }
      const config = (await (await read("/config")).json()) as { model: string; small_model: string }
      if (
        status.inventory.root !== directory ||
        status.session !== session ||
        config.model !== "probe/test" ||
        config.small_model !== "probe/test"
      )
        throw new Error("Effective launch scope/model differs from the isolated fixture")
      if (status.inventory.indexed !== indexing || status.job.state !== (repository?.job.state ?? "idle"))
        throw new Error("Read-only probe unexpectedly started indexing")
      const assets = await (await read("/forge/")).text()
      const script = assets.match(/src="([^"]+\.js)"/)?.at(1)
      if (!script) throw new Error("Browser asset bundle missing")
      const bundle = await (await read(script)).text()
      const hash = new Bun.CryptoHasher("sha256").update(bundle).digest("hex")
      const requests: number[] = []
      for (let index = 0; index < 30; index++) {
        const began = performance.now()
        await (await read("/forge/status")).json()
        requests.push(performance.now() - began)
      }
      const percentile = (values: number[], fraction: number) =>
        [...values].sort((a, b) => a - b).at(Math.ceil(values.length * fraction) - 1)
      if (restart && !launch.resumed && population) {
        const info: unknown = await (await read("/session", { title: "Saved launch probe" }, "POST")).json()
        if (info == null || typeof info !== "object" || !("id" in info) || typeof info.id !== "string" || !info.id.startsWith("ses_")) throw new Error("Session creation failed")
        const id = info.id
        const now = Date.now()
        const user = `msg_${now.toString(16)}0`
        const assistant = `msg_${now.toString(16)}1`
        for (const [message, data, text] of [
          [user, { role: "user", time: { created: now }, agent: "build", model: { providerID: "probe", modelID: "test" } }, "Saved launch probe question"],
          [assistant, { role: "assistant", time: { created: now + 1, completed: now + 2 }, parentID: user, modelID: "test", providerID: "probe", mode: "build", agent: "build", path: { cwd: directory, root: directory }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, finish: "stop" }, "Saved launch probe answer"],
        ] as const) {
          await read("/kilocode/session-import/message", { id: message, sessionID: id, timeCreated: now, data }, "POST")
          await read("/kilocode/session-import/part", { id: message.replace("msg_", "prt_"), messageID: message, sessionID: id, timeCreated: now, data: { type: "text", text } }, "POST")
        }
        const unchanged = (await evidence("forgeunchanged")).map((source) => `${source.id}:${source.hash}`).sort()
        if (!unchanged.length) throw new Error("Unchanged evidence fixture was not indexed")
        const inventory = metadata(await (await read("/forge/status")).json()).inventory
        const content = new Bun.CryptoHasher("sha256").update(await Bun.file(path.join(manuals, "service-0.md")).arrayBuffer()).digest("hex")
        saved.set(launch.pair, { session: id, collection: population.collection, generation: population.registration.generation, inventory, history: await history(population.collection), content, unchanged })
      }
      rows.push({
        mode,
        iteration,
        phase: launch.resumed ? "resumed" : "fresh",
        directory: status.inventory.root,
        session: status.session,
        model: config.model,
        small_model: config.small_model,
        startup,
        cold,
        progress,
        ready,
        usage,
        population,
        saved: saved.get(launch.pair),
        repository,
        render: {
          samples,
          overview: {
            p50: percentile(
              samples.filter((item) => item.command === "overview").map((item) => item.elapsed),
              0.5,
            ),
            p95: percentile(
              samples.filter((item) => item.command === "overview").map((item) => item.elapsed),
              0.95,
            ),
          },
          map: {
            p50: percentile(
              samples.filter((item) => item.command === "map").map((item) => item.elapsed),
              0.5,
            ),
            p95: percentile(
              samples.filter((item) => item.command === "map").map((item) => item.elapsed),
              0.95,
            ),
          },
        },
        status: { samples: requests, p50: percentile(requests, 0.5), p95: percentile(requests, 0.95) },
        asset: { path: script, hash },
        inference: calls.length,
      })
      console.error(`${mode}: startup ${startup.toFixed(1)}ms; cold view ${cold.toFixed(1)}ms`)
      console.error(`FORGE_LAUNCH_ROW ${JSON.stringify(rows.at(-1))}`)
    } catch (err) {
      console.error(`FORGE_LAUNCH_FAILURE ${JSON.stringify({ ...measured, elapsed: performance.now() - started, inference: calls.length, error: String(err) })}`)
      console.error(err)
      console.error(`${mode} iteration ${iteration} failed; listener=${url}; terminal=${terminal.text()}`)
      throw err
    } finally {
      if (!exited) proc.kill("SIGTERM")
      const timer = setTimeout(() => proc.kill("SIGKILL"), 12_000)
      try {
        await done.promise
        if (restart && url) {
          const deadline = performance.now() + 3000
          while (await fetch(`${url}/global/health`, { headers, signal: AbortSignal.timeout(1000) }).then(() => true, (err: unknown) => {
            if (err instanceof Error && "code" in err && err.code === "ECONNREFUSED") return false
            if (err instanceof Error && "code" in err && err.code === "ECONNRESET") return true
            throw new Error("Could not establish backend listener shutdown", { cause: err })
          })) {
            if (performance.now() > deadline) throw new Error("Backend listener survived launch shutdown")
            await Bun.sleep(100)
          }
        }
      } finally {
        clearTimeout(timer)
        data.dispose()
        exit.dispose()
      }
    }
  }
  if (calls.length) throw new Error(`Unexpected inference requests: ${calls.join(", ")}`)
  console.log(
    JSON.stringify(
      {
        platform: `${os.platform()} ${os.release()} ${os.arch()}`,
        cpu: os.cpus().at(0)?.model,
        bun: Bun.version,
        directory,
        rows,
        repetitions,
        documents,
        restart,
        indexing,
        ignoredOpeners: late,
        limits: [
          "Isolated config/storage, no pre-existing daemon. Optional restart uses an imported local conversation, not real model-generated history or daemon attachment.",
          "PTY screen cells reconstructed with xterm 6.0.0; not pixel rendering or a real user's terminal emulator.",
          "Initial startup includes launch and build; cold is initial view readiness (empty when fresh, shell when resumed). Progress measures first inventory before explicit refresh. Population includes read-only inspection plus explicitly requested indexing; refresh isolates the latter.",
          "Repository indexing is opt-in and timed separately. Status samples include response-body JSON parsing.",
          "Map opener intercepted; authenticated assets fetched but frontend rendering not exercised.",
          "Warm filesystem/module caches may remain across independent processes; this is not machine-cold startup.",
        ],
      },
      null,
      2,
    ),
  )
} finally {
  await trap.stop(true)
  await rm(temporary, { recursive: true, force: true })
}
