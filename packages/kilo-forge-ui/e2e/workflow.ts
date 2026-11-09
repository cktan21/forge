import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, chmod, realpath } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { chromium, expect } from "@playwright/test"
import { spawn } from "../../core/src/pty/driver"
import type { Collection, ImportHistory, Manifest, Policy, Proposal, Registry, View, Status, Source } from "@kilocode/forge/schema"
import { binding } from "@kilocode/forge/binding"
import { fingerprint, listener } from "./process"

// Opt-in end-to-end probe: real CLI, browser, SDK, database, and local response fixture.
const mode = process.argv.at(2) ?? "dev"
const action = process.argv.at(3) ?? "accept"
const transitions = action === "transitions"
const existing = process.env.FORGE_WORKFLOW_DAEMON === "1"
const documents = Number(process.env.FORGE_WORKFLOW_DOCUMENTS ?? "1")
assert(Number.isInteger(documents) && documents >= 1 && documents <= 600, "Choose 1..600 workflow documents")
let daemon: { pid: number; url: string; startedAt: string } | undefined
const lifecycle = action === "lifecycle" || action === "lifecycle-accept"
const editing = action === "edit" || action === "lifecycle"
const routing = process.env.FORGE_WORKFLOW_ROUTING ?? "flat"
assert(["flat", "domains"].includes(routing), "Choose flat or domains routing")
assert(["dev", "dev:watch", "packaged"].includes(mode), "Choose dev, dev:watch or packaged")
assert(mode !== "packaged" || !existing, "Packaged probe owns a fresh backend")
assert(["accept", "edit", "clarify", "search", "symbol", "relationships", "lifecycle", "lifecycle-accept", "transitions"].includes(action), "Unknown workflow action")
assert(mode !== "dev:watch" || process.env.FORGE_SOURCE_STABLE === "1", "Parent must signal source stability with FORGE_SOURCE_STABLE=1 before watch execution")
const inspection = lifecycle || ["search", "symbol", "relationships"].includes(action)
const tool = action === "symbol" ? "forge_get_symbol" : action === "relationships" ? "forge_relationships" : "forge_search_code"
let target = ""
assert.equal(process.platform, "darwin", "Browser opener interception currently supports macOS")
const root = path.resolve(import.meta.dirname, "../../..")
const binary = process.env.FORGE_WORKFLOW_BINARY ?? path.join(root, `packages/opencode/dist/@kilocode/cli-${process.platform}-${process.arch}/bin/kilo`)
assert(path.isAbsolute(binary), "Provide an absolute packaged binary path")
const initial = await fingerprint(root)
const records: Array<{ phase: string; data: unknown }> = []
function record(phase: string, data: unknown) {
  records.push({ phase, data })
  console.error(`FORGE_WORKFLOW ${JSON.stringify({ phase, data })}`)
}
record("source", initial)
// Plain dev serves existing assets; compile the current UI before measuring either launcher.
const building = performance.now()
const build = mode === "packaged" || process.env.FORGE_WORKFLOW_BUILT_UI === "1" ? undefined : Bun.spawn([process.execPath, "run", "build"], {
  cwd: path.join(root, "packages/kilo-forge-ui"), stdout: "pipe", stderr: "pipe",
})
const [stdout, stderr, code] = build ? await Promise.all([new Response(build.stdout).text(), new Response(build.stderr).text(), build.exited]) : ["", "", 0]
record("browser-build", { code, stdout, stderr, reused: !build })
if (code !== 0) {
  const output = process.env.FORGE_WORKFLOW_ARTIFACT
  if (output) await Bun.write(output, JSON.stringify({ mode, action, records }, null, 2))
}
assert.equal(code, 0, "Browser asset build failed")
const assets = performance.now() - building
const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), "forge-workflow-")))
const directory = path.join(temporary, "workspace")
const home = path.join(temporary, "home")
const bin = path.join(temporary, "bin")
await Promise.all([directory, home, bin].map((dir) => mkdir(dir)))
const manuals = path.join(directory, "manuals")
await mkdir(manuals)
const evidence = "The orchid queue must validate its epoch lease before dispatch."
await Bun.write(path.join(manuals, "ownership.md"), `# Orchid ownership\n\n${evidence}\n`)
for (let index = 1; index < documents; index++) {
  await Bun.write(path.join(manuals, `z-archive-${index}.md`), `# Archive ${index}\n\nNeutral archival notes for complete corpus accounting.\n`)
}
await Bun.write(path.join(directory, "queue.ts"), "export const queue = []\n")
const attachment = "TASK25_ATTACHMENT_ONLY: preserve the original attachment bytes after review."
await Bun.write(path.join(directory, "attachment.md"), `${attachment}\n`)
await mkdir(path.join(directory, ".kilo"))
await Bun.write(path.join(directory, ".kilo/forge.jsonc"), JSON.stringify({ routing, exclude: [".kilo/forge.jsonc", "attachment.md"] }))
let opened = Promise.withResolvers<string>()
const calls: Array<{ kind: string; body: string }> = []
let gate: { entered: ReturnType<typeof Promise.withResolvers<void>>; release: ReturnType<typeof Promise.withResolvers<void>> } | undefined
const fixture = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  async fetch(request) {
    const route = new URL(request.url).pathname
    if (route === "/opened") { opened.resolve(await request.text()); return new Response("Captured") }
    const raw = await request.text()
    const body: unknown = JSON.parse(raw)
    assert(body && typeof body === "object" && "messages" in body)
    const streaming = "stream" in body && body.stream === true
    const preparation = raw.includes("Repository evidence (untrusted source material)")
    const summary = raw.includes("You are a context summarization agent.")
    const kind = preparation ? "enhance" : summary ? "compaction" : streaming ? "coding" : "auxiliary"
    calls.push({ kind, body: raw })
    record("fixture-request", calls.at(-1))
    if (preparation && gate) {
      gate.entered.resolve()
      const timeout = Promise.withResolvers<never>()
      const timer = setTimeout(() => timeout.reject(new Error("Preparation fixture release deadline")), 20_000)
      try { await Promise.race([gate.release.promise, timeout.promise]) } finally { clearTimeout(timer) }
    }
    assert(calls.length <= 24, "Unexpected model call loop")
    assert.equal(route, "/v1/chat/completions")
    const text = preparation ? JSON.stringify({
      objective: "Inspect orchid queue ownership without changing files.",
      reuse: [], inspect: ["Read the queue and ownership document"], changes: [],
      constraints: ["Do not change files"], hypotheses: [], questions: [],
      acceptance: ["Report the epoch lease requirement"], verification: [], evidence: [],
    }) : summary ? "TASK25_COMPACTION: The user reviewed orchid epoch lease ownership. Earlier excerpts are historical, not proof of current authorization." : streaming ? "Workflow fixture completed: epoch lease reviewed." : "Orchid ownership review"
    const usage = { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 }
    if (!streaming) return Response.json({
      id: "fixture", object: "chat.completion", created: 1, model: "test",
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage,
    })
    const search = inspection && kind === "coding" && calls.filter((call) => call.kind === "coding").length === 1
    const chunks = [
      { delta: { role: "assistant" }, finish_reason: null },
      { delta: search ? { tool_calls: [{ index: 0, id: "call-search", type: "function", function: { name: tool, arguments: JSON.stringify(action === "search" || lifecycle ? { query: "orchid queue lease" } : { id: target }) } }] } : { content: text }, finish_reason: null },
      { delta: {}, finish_reason: search ? "tool_calls" : "stop" },
    ].map((choice) => `data: ${JSON.stringify({
      id: "fixture-stream", object: "chat.completion.chunk", created: 1, model: "test",
      choices: [{ index: 0, ...choice }], ...(choice.finish_reason ? { usage } : {}),
    })}\n\n`).join("")
    return new Response(`${chunks}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
  },
})
await Bun.write(path.join(bin, "open"), `#!${process.execPath}\nawait fetch(${JSON.stringify(`${fixture.url}opened`)},{method:"POST",body:process.argv.at(-1)})\n`)
await chmod(path.join(bin, "open"), 0o700)
let text = ""
let exited = false
let origin = ""
let done = Promise.withResolvers<void>()
const pending = new Set<() => void>()
const began = performance.now()
const options = {
  name: "xterm-256color", cols: 150, rows: 52, cwd: root,
  env: {
    BUN_BE_BUN: "",
    PATH: `${bin}:${process.env.PATH ?? ""}`, HOME: home, KILO_TEST_HOME: home,
    XDG_CONFIG_HOME: path.join(home, "config"), XDG_DATA_HOME: path.join(home, "data"),
    XDG_STATE_HOME: path.join(home, "state"), XDG_CACHE_HOME: path.join(home, "cache"),
    TERM: "xterm-256color", COLORTERM: "truecolor", KILO_AUTH_CONTENT: "{}",
    KILO_DISABLE_PROJECT_CONFIG: transitions ? "0" : "1", KILO_DISABLE_MODELS_FETCH: "1", KILO_DISABLE_AUTOUPDATE: "1",
    KILO_TELEMETRY_LEVEL: "off", KILO_SERVER_PASSWORD: "forge-workflow-fixture",
    KILO_TEST_DAEMON_STATE_DIR: path.join(home, "daemon"),
    KILO_TEST_DAEMON_EPHEMERAL_PORT: "1",
    KILO_CONFIG_CONTENT: JSON.stringify({
      ...(transitions ? {} : { model: "probe/test", small_model: "probe/test" }), enabled_providers: transitions ? ["probe", "alternate"] : ["probe"], indexing: { enabled: false },
      provider: { probe: {
        npm: "@ai-sdk/openai-compatible", options: { baseURL: `${fixture.url}v1`, apiKey: "fixture" },
        models: { test: { name: "Workflow probe", limit: { context: 32000, output: 4000 } } },
      }, ...(transitions ? { alternate: {
        npm: "@ai-sdk/openai-compatible", options: { baseURL: `${fixture.url}v1`, apiKey: "fixture" },
        models: { test: { name: "Workflow alternate", limit: { context: 32000, output: 4000 } } },
      } } : {}) }, permission: { forge_search_code: "allow", forge_get_symbol: "allow", forge_relationships: "allow" }, snapshot: false, formatter: false, lsp: false,
    }),
  },
}
if (transitions) await Bun.write(path.join(directory, ".kilo/kilo.jsonc"), JSON.stringify({ model: "probe/test", small_model: "probe/test" }))
let proc!: ReturnType<typeof spawn>
let data: ReturnType<ReturnType<typeof spawn>["onData"]>
let exit: ReturnType<ReturnType<typeof spawn>["onExit"]>
function launch(session?: string) {
  done = Promise.withResolvers<void>()
  exited = false
  text = ""
  proc = spawn(mode === "packaged" ? binary : process.execPath, [
    ...(mode === "packaged" ? [] : ["run", "--cwd", root, mode]), directory, ...(session ? ["--session", session] : []),
  ], options)
  data = proc.onData((chunk) => {
  text = (text + chunk).slice(-200_000)
  if (chunk.includes("\x1b[6n")) proc.write("\x1b[1;1R")
  if (chunk.includes("\x1b[c")) proc.write("\x1b[?1;2c")
  for (const notify of pending) notify()
  })
  exit = proc.onExit(() => { exited = true; done.resolve(); for (const notify of pending) notify() })
}
async function control(command: "status" | "start" | "stop") {
  const child = Bun.spawn([process.execPath, "run", "--cwd", root, "dev", "daemon", command, "--json", ...(command === "start" ? ["--hostname", "127.0.0.1", "--port", "0"] : [])], {
    cwd: directory, env: options.env, stdout: "pipe", stderr: "pipe",
  })
  const timer = setTimeout(() => child.kill("SIGTERM"), 30_000)
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    if (code !== 0) record("daemon-command-failure", {
      command, code, stdout, stderr,
      log: await Bun.file(path.join(home, "data/kilo/log/daemon.log")).text().catch((err: unknown) => String(err)),
    })
    assert.equal(code, 0, `Owned daemon ${command}: ${stderr}`)
    const value: unknown = JSON.parse(stdout)
    assert(value && typeof value === "object" && "running" in value && typeof value.running === "boolean")
    const state = "state" in value ? value.state : undefined
    if (state != null) {
      assert(typeof state === "object" && "pid" in state && typeof state.pid === "number")
      assert("url" in state && typeof state.url === "string" && new URL(state.url).hostname === "127.0.0.1")
      assert("startedAt" in state && typeof state.startedAt === "string")
      const result = { running: value.running, state: { pid: state.pid, url: state.url, startedAt: state.startedAt } }
      record(`daemon-${command}`, result)
      return result
    }
    const result = { running: value.running, state: undefined }
    record(`daemon-${command}`, result)
    return result
  } finally { clearTimeout(timer) }
}
async function survives() {
  assert(daemon)
  assert.equal(await listener(daemon.url), daemon.pid)
  const current = await control("status")
  assert(current.running)
  assert.equal(current.state?.pid, daemon.pid)
  assert.equal(current.state?.startedAt, daemon.startedAt)
}
async function refused(url: string) {
  await until(async () => fetch(`${url}/global/health`, { signal: AbortSignal.timeout(1000) }).then(
    () => undefined,
    (err: unknown) => {
      if (err instanceof Error && "code" in err && err.code === "ECONNREFUSED") return true
      if (err instanceof Error && "code" in err && err.code === "ECONNRESET") return undefined
      throw err
    },
  ), "Owned backend listener survived shutdown")
}
async function stop() {
  if (!proc) return
  if (!exited) proc.kill("SIGTERM")
  const timer = setTimeout(() => proc.kill("SIGKILL"), 12_000)
  try {
    await done.promise
    if (origin && !(daemon && mode === "dev")) await refused(origin)
    if (daemon) await survives()
    record("shutdown", { origin, owned: !(daemon && mode === "dev"), daemonSurvived: daemon?.pid })
  } finally { clearTimeout(timer); data.dispose(); exit.dispose() }
}
await using _cleanup = {
  async [Symbol.asyncDispose]() {
    gate?.release.resolve()
    try {
      await stop()
    } finally {
      if (daemon) {
        const current = await control("status")
        assert.equal(current.state?.pid, daemon.pid)
        assert.equal(current.state?.startedAt, daemon.startedAt)
        await control("stop")
        await refused(daemon.url)
        record("daemon-cleanup", { pid: daemon.pid, stopped: true })
      }
      const final = await fingerprint(root)
      record("final-source", { ...final, stable: final.hash === initial.hash })
      const output = process.env.FORGE_WORKFLOW_ARTIFACT
      if (output) await Bun.write(output, JSON.stringify({ mode, action, records, calls }, null, 2))
      await fixture.stop(true)
      await rm(temporary, { recursive: true, force: true })
    }
  },
}
async function wait(value: string, timeout = 60_000) {
  const result = Promise.withResolvers<void>()
  const check = () => {
    if (Bun.stripANSI(text).replace(/\s/g, "").includes(value.replace(/\s/g, ""))) result.resolve()
    if (exited) result.reject(new Error(`CLI exited before ${value}`))
  }
  const timer = setTimeout(() => result.reject(new Error(`Timed out waiting for ${value}`)), timeout)
  pending.add(check); check()
  try { await result.promise } finally { clearTimeout(timer); pending.delete(check) }
}
function paste(value: string) { text = ""; proc.write(`\x15\x1b[200~${value}\x1b[201~\r`) }
async function repaint(value: string) {
  const deadline = performance.now() + 30_000
  let columns = 154
  while (true) {
    text = ""
    proc.resize(columns, 53)
    columns = columns === 154 ? 155 : 154
    try {
      await wait(value, 1000)
      return
    } catch (err) {
      if (exited || performance.now() >= deadline) throw err
    }
  }
}
async function until<A>(fn: () => Promise<A | undefined>, message: string) {
  const deadline = performance.now() + 30_000
  while (true) {
    const result = await fn()
    if (result !== undefined) return result
    assert(performance.now() < deadline, message)
    await Bun.sleep(100)
  }
}
if (existing) {
  assert.equal((await control("status")).running, false, "Isolated daemon state must start empty")
  daemon = (await control("start")).state
  assert(daemon)
  await survives()
}
launch()
const browser = await chromium.launch({
  headless: true, executablePath: process.env.FORGE_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
})
const page = await browser.newPage({ viewport: { width: 1512, height: 1100 } })
page.setDefaultTimeout(30_000)
const errors: string[] = []
page.on("pageerror", (error) => errors.push(error.message))
try {
  await wait("Workflow probe")
  const startup = performance.now() - began
  paste("/map knowledge")
  await wait("Forge · map · agent knowledge")
  proc.write("\x02")
  const timer = setTimeout(() => opened.reject(new Error("Browser URL unavailable")), 5000)
  const url = new URL(await opened.promise.finally(() => clearTimeout(timer)))
  origin = url.origin
  assert.equal(url.searchParams.get("directory"), directory)
  let authorization = new URLSearchParams(url.hash.slice(1)).get("authorization")
  assert(authorization)
  async function read<A>(route: string): Promise<A> {
    const target = new URL(route, origin)
    target.searchParams.set("directory", directory)
    const response = await fetch(target, { headers: { authorization: authorization! }, signal: AbortSignal.timeout(10_000) })
    assert(response.ok, `${route}: ${response.status} ${await response.clone().text()}`)
    return response.json() as Promise<A>
  }
  const config = await read<{ model: string; small_model: string; provider: { probe: { options: { baseURL: string } } } }>("/config")
  assert.equal(config.model, "probe/test")
  assert.equal(config.small_model, "probe/test")
  assert.equal(config.provider.probe.options.baseURL, `${fixture.url}v1`)
  const pid = await listener(origin)
  if (daemon) {
    await survives()
    if (mode === "dev") assert.equal(pid, daemon.pid, "dev failed to reuse the isolated daemon")
    if (mode === "dev:watch") assert.notEqual(pid, daemon.pid, "watch must own a separate source backend")
    record("daemon-identity", { mode, phase: "fresh", pid, daemon: daemon.pid, reused: pid === daemon.pid })
  }
  const html = await fetch(`${origin}/forge/`, { headers: { authorization } }).then((response) => response.text())
  const script = html.match(/src="([^"]+\.js)"/)?.at(1)
  assert(script)
  const bundle = await fetch(new URL(script, origin), { headers: { authorization } }).then((response) => response.arrayBuffer())
  if (mode === "packaged" || process.env.FORGE_WORKFLOW_BUILT_UI === "1") {
    const asset = script.replace(/^\/forge\//, "")
    const digest = (bytes: ArrayBuffer) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
    assert.equal(digest(bundle), digest(await Bun.file(path.join(root, "packages/kilo-forge-ui/dist", asset)).arrayBuffer()), "Served UI must match the build's source UI bytes")
    assert.equal(digest(bundle), digest(await Bun.file(path.join(path.dirname(binary), "forge", asset)).arrayBuffer()), "Served UI must match packaged UI bytes")
    record("compiled-identity", { binary, hash: digest(await Bun.file(binary).arrayBuffer()), asset, hashUI: digest(bundle) })
  }
  record("identity", { mode, directory, session: "", pid, owned: !(daemon && mode === "dev"), model: config.model, endpoint: config.provider.probe.options.baseURL, asset: { script, hash: new Bun.CryptoHasher("sha256").update(bundle).digest("hex") } })
  if (transitions) {
    async function response(route: string, dir = directory, method = "GET", body?: unknown) {
      const target = new URL(route, origin)
      target.searchParams.set("directory", dir)
      return fetch(target, {
        method, headers: { authorization: authorization!, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
      })
    }
    async function request<A>(route: string, dir = directory, method = "GET", body?: unknown): Promise<A> {
      const result = await response(route, dir, method, body)
      assert(result.ok, `${method} ${route}: ${result.status} ${await result.clone().text()}`)
      return result.json() as Promise<A>
    }
    async function git(args: string[]) {
      const child = Bun.spawn(["git", ...args], { cwd: directory, env: { ...options.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }, stdout: "pipe", stderr: "pipe" })
      const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
      assert.equal(code, 0, `Fixture git ${args.join(" ")}: ${err}`)
      return out
    }
    const worktree = path.join(temporary, "linked")
    await git(["init", "--initial-branch=fixture"])
    // An unborn linked branch needs no commit, identity, hooks, or user repository.
    await git(["worktree", "add", "--orphan", "-b", "linked", worktree])
    await mkdir(path.join(worktree, ".kilo"))
    await Bun.write(path.join(worktree, ".kilo/kilo.jsonc"), JSON.stringify({ model: "probe/test", small_model: "probe/test" }))
    await Bun.write(path.join(worktree, "other.ts"), "export const separate = true\n")
    record("linked-worktree", { directory, worktree, listing: await git(["worktree", "list", "--porcelain"]) })
    const folder = path.join(temporary, "documents")
    await mkdir(folder)
    for (let offset = 0; offset < 600; offset += 20) {
      await Promise.all(Array.from({ length: 20 }, (_, index) => Bun.write(path.join(folder, `lease-${offset + index}.md`), `# Orchid ${offset + index}\n\n${evidence}\n`)))
    }
    proc.write("r")
    await wait("Workflow probe")
    const results: Array<{ id: string; scope: string; phase: string; state: string; error?: string }> = []
    for (const [offset, scope] of ["session", "worktree", "provider"].entries()) {
      for (const [ordinal, phase] of ["indexing", "preparing"].entries()) {
        const id = `T${(mode === "dev" ? 0 : 6) + offset * 2 + ordinal + 1}`
        const before = calls.length
        let pending: Promise<{ ok: boolean; proposal?: Proposal; error?: string }> | undefined
        try {
          if ((await request<{ model: string }>("/config")).model !== "probe/test") {
            await request("/config", directory, "PATCH", { model: "probe/test", small_model: "probe/test" })
          }
          assert.equal((await request<{ model: string }>("/config")).model, "probe/test")
          const old = await request<{ id: string }>("/session", directory, "POST", { title: `${id} original` })
          const dir = scope === "worktree" ? worktree : directory
          const next = await request<{ id: string }>("/session", dir, "POST", { title: `${id} destination` })
          if (scope === "session") {
            await request("/tui/select-session", directory, "POST", { sessionID: old.id })
            await repaint(`${id} original`)
          }
          const collection = await request<Collection>("/forge/knowledge", directory, "POST", {
            kind: phase === "indexing" ? "folder" : "text", label: `${id} private`,
            location: phase === "indexing" ? folder : "", content: phase === "preparing" ? evidence : undefined,
            session: old.id, watch: false,
          })
          const route = `/forge/knowledge/${collection.id}`
          const registry = await request<Registry>(`/forge/knowledge?session=${old.id}`)
          assert.equal(registry.provider, "probe")
          await request(route, directory, "PUT", { action: "approve", session: old.id, providers: ["probe"], grants: { probe: registry.destination!.fingerprint } })
          await request(route, directory, "PUT", { action: "index", session: old.id })
          let inFlight: unknown
          if (phase === "indexing") {
            inFlight = await until(async () => {
              const item = (await request<Registry>(`/forge/knowledge?session=${old.id}`)).collections.find((item) => item.id === collection.id)
              assert(item?.state !== "ready", `${id}: indexing completed before transition; not an in-flight test`)
              return item?.state === "indexing" ? item : undefined
            }, `${id}: indexing was never observed`)
          } else {
            await until(async () => (await request<Registry>(`/forge/knowledge?session=${old.id}`)).collections.find((item) => item.id === collection.id)?.state === "ready" ? true : undefined, `${id}: collection did not index`)
            gate = { entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() }
            pending = response("/forge/enhance", directory, "POST", { text: "Inspect orchid queue epoch lease ownership.", session: old.id }).then(async (result) =>
              result.ok ? { ok: true, proposal: await result.json() as Proposal } : { ok: false, error: await result.text() },
            ).catch((err: unknown) => ({ ok: false, error: String(err) }))
            await Promise.race([gate.entered.promise, pending.then(() => { throw new Error(`${id}: preparation ended before fixture gate`) })])
            inFlight = await request<Manifest[]>(`/forge/requests?session=${old.id}&purpose=enhance`)
            assert(calls.at(-1)?.body.includes(evidence), `${id}: positive private-evidence send missing`)
          }
          if (scope === "provider") {
            // Config PATCH is a supported host transition and may dispose the old instance.
            await request("/config", directory, "PATCH", { model: "alternate/test", small_model: "alternate/test" })
            assert.equal((await request<{ model: string }>("/config")).model, "alternate/test")
          }
          if (scope === "session") {
            await request("/tui/select-session", directory, "POST", { sessionID: next.id })
            await repaint(`${id} destination`)
            record("terminal-session", { id, session: next.id, terminal: Bun.stripANSI(text) })
          }
          const destination = new URL("/forge/", origin)
          destination.searchParams.set("directory", dir)
          destination.searchParams.set("session", scope === "provider" ? old.id : next.id)
          destination.hash = new URLSearchParams({ authorization }).toString()
          await page.goto(destination.href)
          await expect(page.getByText("LIVE WORKSPACE UPDATES", { exact: true })).toBeVisible()
          const active = scope === "provider" ? old.id : next.id
          const status = await request<Status>(`/forge/status?session=${active}`, dir)
          assert.equal(status.session, active)
          assert.equal(status.inventory.root, dir)
          const visible = await request<Registry>(`/forge/knowledge?session=${active}`, dir)
          if (scope === "provider") {
            assert.equal(visible.provider, "alternate")
            assert(!visible.collections.find((item) => item.id === collection.id)?.providers.includes("alternate"))
            const selected = await request<{ matches: Array<{ source: Source }> }>(`/forge/search?q=orchid&session=${old.id}`)
            assert(!selected.matches.some((item) => item.source.detail.collection === collection.id), "Unapproved new provider retrieved private evidence")
          } else {
            assert(!visible.collections.some((item) => item.id === collection.id))
            assert(!(await page.locator("body").innerText()).includes(`${id} private`))
            assert.deepEqual(await request<Manifest[]>(`/forge/requests?session=${next.id}`, dir), [])
            const denied = await response(`${route}/imports?session=${next.id}`, dir)
            assert(!denied.ok, "Foreign scope read private import history")
            if (scope === "worktree") {
              const foreign = await response(`/forge/status?session=${old.id}`, worktree)
              assert(!foreign.ok)
              assert((await foreign.text()).includes("different workspace"))
            }
          }
          gate?.release.resolve()
          const outcome = await pending
          if (phase === "preparing" && scope !== "provider") assert(outcome?.ok, `${id}: original scoped preparation failed: ${outcome?.error}`)
          if (outcome?.ok) {
            assert.equal(outcome.proposal?.session, old.id)
            if (scope === "provider") assert.equal((await request<{ valid: boolean }>("/forge/validate", directory, "POST", outcome.proposal)).valid, false)
            if (scope !== "provider") {
              assert.equal((await request<{ request: Manifest | null }>(`/forge/requests/${outcome.proposal.id}?session=${next.id}`, dir)).request, null)
            }
          }
          if (phase === "indexing" && scope !== "provider") {
            await until(async () => (await request<Registry>(`/forge/knowledge?session=${old.id}`)).collections.find((item) => item.id === collection.id)?.state === "ready" ? true : undefined, `${id}: original indexing did not finish`)
            assert(!(await request<Registry>(`/forge/knowledge?session=${next.id}`, dir)).collections.some((item) => item.id === collection.id))
          }
          assert.equal(calls.length - before, phase === "preparing" ? 1 : 0)
          assert(!calls.some((call) => call.kind === "coding"), "Transition submitted an unreviewed coding prompt")
          record("transition", { id, mode, scope, phase, state: "passed", pid, old: old.id, next: next.id, directory, destination: dir, inFlight, status, outcome, calls: calls.length - before, surface: scope === "session" ? "host TUI session-select event and browser" : scope === "worktree" ? "linked-worktree host requests and browser navigation; not TUI workspace navigation" : "host config PATCH and browser" })
          results.push({ id, scope, phase, state: "passed" })
        } catch (err) {
          record("transition", { id, mode, scope, phase, state: "failed", error: String(err), terminal: Bun.stripANSI(text), calls: calls.length - before })
          results.push({ id, scope, phase, state: "failed", error: String(err) })
        } finally {
          gate?.release.resolve()
          await pending
          gate = undefined
        }
      }
    }
    record("transition-summary", results)
    assert(results.every((item) => item.state === "passed"), "Some transition cases failed; see per-case records")
  } else {
  await page.goto(url.href)
  await expect(page.getByRole("heading", { name: "What Forge knows. What it used." })).toBeVisible()
  await expect(page.getByText("LIVE WORKSPACE UPDATES", { exact: true })).toBeVisible()
  // Status replaces the cold-wait lines with differential cursor updates.
  proc.write("o")
  await repaint("Semantic index: disabled")
  await expect(page.getByText("Semantic index: disabled;", { exact: false })).toBeVisible()
  assert.deepEqual((await read<Status>("/forge/status")).semantic, { state: "disabled", searchable: false })
  assert.equal(new URL(page.url()).hash, "")
  const library = page.getByRole("region", { name: "Knowledge library" })
  await library.getByLabel("Source type").selectOption("folder")
  await library.getByLabel("Label", { exact: true }).fill("Workflow manuals")
  await library.getByLabel("Path", { exact: true }).fill(manuals)
  await library.getByLabel("Watch for changes").uncheck()
  await library.getByRole("button", { name: "Preview before registering", exact: true }).click()
  await expect(library.getByRole("heading", { name: "Ingestion preview", exact: true })).toBeVisible()
  await library.getByRole("button", { name: "Register locally", exact: true }).click()
  const collection = library.getByRole("article").filter({ has: page.getByRole("heading", { name: "Workflow manuals" }) })
  await collection.getByRole("button", { name: "Approve local indexing", exact: true }).click()
  await expect(collection.getByText("ready", { exact: true })).toBeVisible()
  assert.equal(calls.length, 0)
  const registry = await read<Registry>("/forge/knowledge")
  assert.equal(registry.provider, "probe")
  assert.deepEqual(registry.destination?.origins, [fixture.url.origin])
  const confirmation = Promise.withResolvers<string>()
  page.once("dialog", async (dialog) => { confirmation.resolve(dialog.message()); await dialog.accept() })
  await collection.getByRole("button", { name: "Allow use with probe", exact: true }).click()
  assert((await confirmation.promise).includes(registry.destination.fingerprint))
  await expect(collection.getByRole("button", { name: "Revoke provider sharing", exact: true })).toBeVisible()
  await expect(collection.getByText("ready", { exact: true })).toBeVisible()
  assert.equal(registry.collections.at(0)?.result?.files, documents)
  record("corpus", { documents, collection: registry.collections.at(0)?.id, result: registry.collections.at(0)?.result })
  const originals = await read<View>("/forge/view?query=ownership")
  const parent = originals.sources.find((source) => source.method === "collection-document")!
  assert(parent?.detail.briefVersion === "forge-extractive-brief-v1")
  assert(parent.detail.brief?.includes(evidence))
  assert.equal(parent.text, "")
  await page.getByLabel("Search sources").fill("ownership")
  await page.getByRole("button", { name: "Search", exact: true }).click()
  await page.getByRole("button", { name: "Source table", exact: true }).click()
  await page.getByRole("table").getByRole("button", { name: `${parent.uri} · ${parent.label}`, exact: true }).focus()
  await page.keyboard.press("Enter")
  await page.getByText("Document routing brief", { exact: true }).click()
  await expect(page.getByLabel("Document routing brief", { exact: true })).toContainText(evidence)
  await page.getByRole("button", { name: "Choose section to pin", exact: true }).click()
  await expect(page.getByText(`Sections of ${parent.label}.`, { exact: false })).toBeVisible()
  assert.deepEqual((await read<Policy>("/forge/policy")).pin, [], "Choosing a document must not pin the whole document")
  await page.getByRole("table").getByRole("button").first().click()
  await expect(page.getByLabel("Document routing brief", { exact: true })).toHaveCount(0)
  await page.getByLabel("Search sources").fill("orchid queue")
  await page.getByRole("button", { name: "Search", exact: true }).click()
  await page.getByRole("button", { name: "Source table", exact: true }).click()
  await page.getByRole("table").getByRole("button").first().click()
  await page.getByRole("button", { name: "Pin for preparation", exact: true }).click()
  await expect(page.getByRole("button", { name: "Unpin evidence", exact: true })).toBeVisible()
  const policy = await read<Policy>("/forge/policy")
  assert.equal(policy.pin.length, 1)
  const pin = policy.pin.at(0)!
  const view = await read<View>("/forge/view?query=orchid")
  const source = view.sources.find((source) => source.id === pin)!
  assert(source, "Browser pin must identify the imported document")
  assert.equal(calls.length, 0, "Browser registration/sharing/pin must not call a model")
  proc.write("r")
  await wait("Workflow probe")
  // Let terminal dialog cleanup finish before pasting into its composer.
  await Bun.sleep(50)
  const original = "Inspect orchid queue ownership. Do not change files."
  if (lifecycle) {
    text = ""
    proc.write(`\x15\x1b[200~/enhance ${original} \x1b[201~`)
    await repaint(original)
    proc.write("@attachment.md")
    await wait("attachment.md")
    await Bun.sleep(300)
    proc.write("\t")
    await Bun.sleep(100)
    proc.write("\r")
    await wait("Forge · attachment scope")
    assert.equal(calls.length, 0, "Attachment choices must not send a preparation")
    text = ""; proc.write("r")
    await wait("@attachment.md")
    await Bun.sleep(50)
    text = ""; proc.write("\r")
    await wait("Forge · attachment scope")
    text = ""; proc.write("t")
  } else paste(`/enhance ${original}`)
  await wait("[a] Use prompt (does not send)")
  let preparation = (await read<Manifest[]>("/forge/requests?purpose=enhance")).at(0)!
  assert.equal(preparation.state, "completed")
  assert.equal(preparation.selection?.policy, policy.version)
  assert.equal(preparation.retrieval?.state, "completed")
  assert.deepEqual(preparation.selection?.channels?.map((channel) => channel.name).sort(), [
    "collection-semantic", "dependency-docs", "domains", "keyword", "memory", "public-docs", "relationships", "semantic",
  ])
  assert.equal(preparation.selection?.channels?.find((channel) => channel.name === "keyword")?.state, "completed")
  assert.deepEqual(preparation.selection?.channels?.find((channel) => channel.name === "semantic"), {
    name: "semantic", state: "disabled", candidates: 0, withheld: 0,
    readiness: { state: "disabled", searchable: false },
  }, "Disabled semantic index must not be reported as a completed search")
  assert(preparation.selection?.candidates.some((candidate) => candidate.channels?.some((channel) => channel.name === "keyword" && channel.rank > 0)))
  if (routing === "domains") assert(preparation.selection?.candidates.find((candidate) => candidate.source === pin)?.channels?.some((channel) => channel.name === "domains"), "Imported evidence must participate in document routing")
  assert.equal(preparation.selection?.candidates.find((candidate) => candidate.source === pin)?.state, "selected")
  assert.equal(preparation.entries.find((entry) => entry.source === pin)?.stage, "sent")
  assert(!preparation.entries.some((entry) => entry.source === parent.id), "Routing brief must not substitute for original evidence")
  if (routing === "domains") assert(preparation.selection?.candidates.find((candidate) => candidate.source === pin)?.retrieval.includes("persisted brief"))
  assert.equal(calls.filter((call) => call.kind === "enhance").length, 1)
  if (lifecycle) assert(!calls.find((call) => call.kind === "enhance")!.body.includes(attachment), "Task-only attachment bytes entered preparation")
  assert.equal(calls.filter((call) => call.kind === "coding").length, 0, "Review must not start coding")
  if (action === "clarify") {
    const previous = preparation
    text = ""; proc.write("c")
    await wait("Give feedback to improve this revision")
    await Bun.sleep(50)
    proc.write("\x1b[200~Preserve retry behavior.\x1b[201~")
    await wait("Preserve retry behavior.")
    text = ""; proc.write("\r")
    await wait("[a] Use prompt (does not send)")
    preparation = (await read<Manifest[]>("/forge/requests?purpose=enhance")).at(0)!
    assert.notEqual(preparation.id, previous.id)
    assert.equal(preparation.entries.find((entry) => entry.source === pin)?.stage, "sent")
    assert.equal(calls.filter((call) => call.kind === "enhance").length, 2)
    assert.equal(calls.filter((call) => call.kind === "coding").length, 0)
    text = ""; proc.write("a")
  }
  if (inspection) {
    target = preparation.entries.find((entry) => entry.uri === "queue.ts")?.source ?? ""
    assert(target, "Prepared repository source ID is available for inspection")
  }
  if (action === "accept" || (inspection && !editing)) { text = ""; proc.write("a") }
  if (editing) {
    text = ""; proc.write("e")
    await wait("Edit the improved prompt")
    await Bun.sleep(50) // The dialog schedules textarea focus after mount.
    // Append in the actual prompt editor; no synthetic PromptInfo or SDK submission.
    proc.write("\x1b[200~ Review-only workflow edit.\x1b[201~")
    await wait("Review-only workflow edit.")
    text = ""; proc.write("\r")
    await wait("[a] Use prompt (does not send)")
    text = ""; proc.write("a")
    await wait("</forge-evidence>")
    await Bun.sleep(50)
    if (lifecycle) {
      await repaint("@attachment.md")
      record("edited-draft", { terminal: Bun.stripANSI(text) })
      // Re-anchoring the final @file marker opens completion; dismiss it before submission.
      proc.write("\x1b")
      await Bun.sleep(100)
    }
    assert.equal(calls.filter((call) => call.kind === "coding").length, 0)
    text = ""; proc.write("\r")
  }
  if (!editing) {
    await repaint("</forge-evidence>")
    assert.equal(calls.filter((call) => call.kind === "coding").length, 0, "Staging must not submit the coding request")
    text = ""; proc.write("\r")
  }
  await repaint("Workflow fixture completed: epoch lease reviewed.")
  const sessions = await read<Array<{ id: string }>>("/session")
  assert.equal(sessions.length, 1, "Isolated workflow must create exactly one coding session")
  const coding = await until(async () => {
    const records = await read<Manifest[]>(`/forge/requests?purpose=coding&session=${sessions.at(0)!.id}`)
    return records.find((item) => item.preparation === preparation.id && item.state === "completed" && (!inspection || item.lookups?.length))
  }, "Coding capture was not completed")
  assert(coding.session.startsWith("ses_"))
  assert.equal(coding.operation, preparation.operation)
  const captured = coding.entries.find((entry) => entry.source === pin)!
  assert.equal(captured.hash, source.hash)
  assert.equal(captured.text, preparation.entries.find((entry) => entry.source === pin)?.text)
  assert.equal(captured.stage, "sent")
  assert(coding.attempts?.some((attempt) => attempt.status === 200 && attempt.sent.includes(pin)))
  if (inspection) {
    assert.equal(calls.filter((call) => call.kind === "coding").length, 2)
    assert.equal(coding.lookups?.length, 1)
    const result = await read<{ request: Manifest }>(`/forge/requests/${coding.lookups.at(0)}?session=${coding.session}`)
    assert.equal(result.request.lookup?.tool, tool)
    assert.equal(result.request.lookup?.call, "call-search")
    assert.equal(result.request.operation, preparation.operation)
    assert.equal(result.request.state, "completed")
    if (action === "search" || lifecycle) {
      assert.equal(result.request.retrieval?.state, "completed")
      assert(result.request.selection?.candidates.length)
      if (routing === "domains") assert(result.request.selection?.candidates.find((candidate) => candidate.source === pin)?.channels?.some((channel) => channel.name === "domains"), "Search-tool evidence must participate in document routing")
      assert.deepEqual(result.request.selection?.channels?.find((channel) => channel.name === "semantic"), {
        name: "semantic", state: "disabled", candidates: 0, withheld: 0,
        readiness: { state: "disabled", searchable: false },
      })
    }
    if (action !== "search" && !lifecycle) assert.equal(result.request.selection, undefined)
    if (action === "relationships") assert.equal(result.request.entries.at(0)?.kind, "tool")
    assert(result.request.entries.every((entry) => entry.stage === "assembled"))
    assert(calls.filter((call) => call.kind === "coding").at(-1)?.body.includes("forge-retrieval"))
  }
  const sent = calls.find((call) => call.kind === "coding")!
  assert(sent.body.includes(original))
  assert(sent.body.includes(pin))
  assert(sent.body.includes(evidence))
  if (action === "clarify") assert(sent.body.includes("Developer clarifications:\\nPreserve retry behavior."))
  if (editing) assert(sent.body.includes("Review-only workflow edit."))
  if (lifecycle) {
    assert(sent.body.includes(attachment), "Coding must receive the task-only attachment")
    const messages = await read<Array<{ info: { role: string }; parts: Array<{ type: string; url?: string; filename?: string }> }>>(`/session/${coding.session}/message`)
    const attached = messages.filter((item) => item.info.role === "user").flatMap((item) => item.parts).find((part) => part.type === "file" && part.filename === "attachment.md")
    assert.equal(attached?.url, new URL(`file://${directory}/attachment.md`).href)
    assert.equal(await Bun.file(path.join(directory, "attachment.md")).text(), `${attachment}\n`)
    record("attachment", { preparation, coding, attached, edited: editing, original })
  }
  opened = Promise.withResolvers<string>()
  paste("/map knowledge")
  await wait("Forge · map · agent knowledge")
  proc.write("\x02")
  const timeout = setTimeout(() => opened.reject(new Error("Session browser URL unavailable")), 5000)
  const session = new URL(await opened.promise.finally(() => clearTimeout(timeout)))
  assert.equal(session.searchParams.get("session"), coding.session)
  await page.goto(session.href)
  await expect(page.locator(".request-info")).toContainText(`Preparation reference: ${preparation.id}`)
  await expect(page.locator(".request-info")).toContainText("HTTP 200")
  await expect(page.locator(".selection-history")).toContainText(coding.operation!)
  if (inspection) {
    await page.getByRole("button", { name: `Inspect tool retrieval ${coding.lookups!.at(0)}`, exact: true }).click()
    await expect(page.locator(".selection-history")).toContainText(`Lookup tool: ${tool}`)
    await expect(page.locator(".selection-history")).toContainText(`Query / source ID: ${action === "search" || lifecycle ? "orchid queue lease" : target}`)
    await page.locator("#request").selectOption(coding.id)
  }
  await page.getByRole("button", { name: "Inspect referenced preparation (when retained in history)" }).click()
  await expect(page.locator(".selection-history")).toContainText(`selected: ${pin}`)
  await expect(page.locator(".selection-history")).toContainText("keyword: completed")
  await expect(page.locator(".selection-history")).toContainText("not exhaustive corpus coverage")
  proc.write("r")
  await wait("Workflow probe")
  await Bun.sleep(50)
  paste("/overview knowledge")
  await repaint("Preparation reference:")
  proc.write("\x1b[6~")
  if (inspection) await wait("Tool retrieval:")
  await wait("HTTP 200")
  if (inspection) {
    proc.write("l")
    await repaint("Inspecting tool retrieval:")
    proc.write("\x1b[B".repeat(6))
    await repaint(`Lookup tool: ${tool}`)
    // Resize requests a repaint; differential PTY updates can split the query.
    text = ""
    proc.resize(151, 52)
    await wait(`Query / source ID: ${action === "search" || lifecycle ? "orchid queue lease" : target}`)
  }
  if (lifecycle) {
    proc.write("r")
    await wait("Workflow probe")
    await Bun.sleep(50)
    const previous = new Set((await read<Manifest[]>(`/forge/requests?purpose=coding&session=${coding.session}`)).map((item) => item.id))
    paste("Give a subsequent coding-turn confirmation of the reviewed lease; do not modify files.")
    await repaint("Workflow fixture completed: epoch lease reviewed.")
    const latest = await until(async () => (await read<Manifest[]>(`/forge/requests?purpose=coding&session=${coding.session}`)).find((item) => !previous.has(item.id) && item.state === "completed"), "Subsequent coding capture missing")
    assert.equal(latest.preparation, undefined, "New user turn must not inherit old preparation approval")
    assert.deepEqual(latest.lookups, [], "A new user turn must not borrow a prior turn's tool selection")
    assert.equal((await read<Status>(`/forge/status?session=${coding.session}`)).coding?.id, latest.id)
    record("subsequent-coding", latest)
    paste("/compact")
    await repaint("/compact")
    text = ""; proc.write("\r")
    await until(async () => calls.some((call) => call.kind === "compaction") ? true : undefined, "Compaction did not contact the local fixed response source")
    const compacted = await until(async () => (await read<Manifest[]>(`/forge/requests?purpose=compaction-lineage&session=${coding.session}`)).find((item) => item.state === "completed"), "Compaction lineage missing")
    assert(compacted.entries.some((entry) => entry.kind === "summary" && entry.text.includes("TASK25_COMPACTION")))
    assert(compacted.entries.some((entry) => entry.source === pin && entry.stage === "summarized"))
    const historical = (await read<{ request: Manifest }>(`/forge/requests/${coding.id}?session=${coding.session}`)).request
    assert.deepEqual(historical, coding, "Compaction mutated a historical request")
    const saved = await read<Status>(`/forge/status?session=${coding.session}`)
    const inventory = saved.inventory
    const imports = await read<ImportHistory>(`/forge/knowledge/${registry.collections.at(0)!.id}/imports?session=${coding.session}`)
    record("compaction", { compacted, historical, inventory, imports })
    await stop()
    opened = Promise.withResolvers<string>()
    const start = performance.now()
    launch(coding.session)
    await wait("Workflow probe")
    await wait("TASK25_COMPACTION")
    paste("/map knowledge")
    await wait("Forge · map · agent knowledge")
    proc.write("\x02")
    const timer = setTimeout(() => opened.reject(new Error("Resumed browser URL unavailable")), 5000)
    const resumed = new URL(await opened.promise.finally(() => clearTimeout(timer)))
    assert.equal(resumed.searchParams.get("session"), coding.session)
    assert.equal(resumed.searchParams.get("directory"), directory)
    origin = resumed.origin
    authorization = new URLSearchParams(resumed.hash.slice(1)).get("authorization")
    assert(authorization)
    const count = calls.length
    const reading = performance.now()
    const status = await read<Status>(`/forge/status?session=${coding.session}`)
    const latency = performance.now() - reading
    const reused = daemon && mode === "dev"
    for (const key of ["root", "revision", "observed", "files", "partial", "indexed", "counts"] as const) {
      assert.deepEqual(status.inventory[key], inventory[key], `Read-only resume changed saved ${key}`)
    }
    assert.equal(status.session, coding.session)
    if (reused) assert.deepEqual(status.job, saved.job, "Daemon reuse changed the completed repository job")
    if (!reused) assert.equal(status.job.state, "idle")
    const current = await read<Registry>(`/forge/knowledge?session=${coding.session}`)
    assert(current.collections.every((item) => item.state === (reused ? "ready" : "registered") && !item.watch))
    const persisted = await read<View>(`/forge/view?query=orchid&session=${coding.session}`)
    assert(persisted.sources.some((item) => item.id === pin && item.status === (reused ? "current" : "unavailable")), "Document availability did not match backend reuse/restart")
    assert.deepEqual(await read<ImportHistory>(`/forge/knowledge/${registry.collections.at(0)!.id}/imports?session=${coding.session}`), imports)
    assert.deepEqual((await read<{ request: Manifest }>(`/forge/requests/${coding.id}?session=${coding.session}`)).request, historical)
    await page.goto(resumed.href)
    await expect(page.getByText("LIVE WORKSPACE UPDATES", { exact: true })).toBeVisible()
    await page.locator("#request").selectOption(coding.id)
    await expect(page.locator(".request-info")).toContainText(preparation.id)
    await page.getByRole("button", { name: "Source table", exact: true }).click()
    await page.getByRole("button", { name: "Inspect referenced preparation (when retained in history)" }).click()
    await expect(page.locator(".selection-history")).toContainText(`selected: ${pin}`)
    assert.equal(calls.length, count, "Saved-session inspection called inference")
    if (daemon) {
      const resumed = await listener(origin)
      await survives()
      if (mode === "dev") assert.equal(resumed, daemon.pid)
      if (mode === "dev:watch") {
        assert.notEqual(resumed, daemon.pid)
        assert.notEqual(resumed, pid)
      }
      record("daemon-identity", { mode, phase: "resumed", pid: resumed, previous: pid, daemon: daemon.pid, reused: resumed === daemon.pid })
    }
    record("resume", { session: coding.session, pid: await listener(origin), previous: pid, elapsed: performance.now() - start, inventoryRead: latency, documents, status, registry: current, persisted })
    const refresh = await fetch(new URL(`/forge/knowledge/${current.collections.at(0)!.id}?directory=${encodeURIComponent(directory)}`, origin), {
      method: "PUT", headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({ action: "index", session: coding.session }),
    })
    assert(refresh.ok, `Explicit post-resume refresh failed: ${await refresh.text()}`)
    await until(async () => (await read<Registry>("/forge/knowledge")).collections.every((item) => item.state === "ready") ? true : undefined, "Explicit resume refresh did not finish")
    proc.write("r")
    await wait("Workflow probe")
    await Bun.sleep(50)
    paste("/overview knowledge")
    await repaint("Forge · overview · agent knowledge")
  }
  const count = calls.length
  const endpoint = new URL("/forge/enhance", origin)
  endpoint.searchParams.set("directory", directory)
  const rejected = await fetch(endpoint, {
    method: "POST", headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify({ text: "Inspect queue", session: coding.session, pin: ["missing-journal-pin"] }),
    signal: AbortSignal.timeout(30_000),
  })
  assert(!rejected.ok)
  assert((await rejected.text()).includes("Pinned excerpt is unavailable"))
  const failed = (await read<Manifest[]>(`/forge/requests?session=${coding.session}&purpose=enhance`)).find((item) => item.state === "failed")
  assert(failed)
  assert.equal(failed.retrieval?.state, "failed")
  assert.equal(failed.retrieval?.phase, "selection")
  assert.equal(failed.retrieval?.channels.find((item) => item.name === "keyword")?.state, "completed")
  assert.deepEqual(failed.entries, [])
  assert.equal(failed.selection, undefined)
  assert.deepEqual(failed.attempts, [])
  assert.equal(calls.length, count, "Failed selection must not call the provider")
  await page.getByRole("button", { name: "Reload view", exact: true }).click()
  await page.locator("#request").selectOption(failed.id)
  await page.locator(".retrieval-history summary").click()
  await expect(page.locator(".retrieval-history")).toContainText("Retrieval execution: failed; last phase: selection")
  await expect(page.locator(".retrieval-history")).toContainText("keyword: completed")
  await expect(page.locator(".request-info")).toContainText("0 captured sources")
  proc.write("p")
  await repaint("pending · failed")
  proc.write("h")
  await repaint("Retrieval execution: failed; last phase: selection")
  await wait("keyword: completed")
  await page.reload()
  await expect(page.getByRole("alert").first()).toHaveText("Open /map in the terminal and press Ctrl+B to authenticate this browser session.")
  await expect(page.locator(".request-info")).toHaveCount(0)
  assert.equal(new URL(page.url()).hash, "")
  assert.deepEqual(await page.evaluate(() => [localStorage.length, sessionStorage.length]), [0, 0])
  opened = Promise.withResolvers<string>()
  proc.write("\x02")
  const recovery = setTimeout(() => opened.reject(new Error("Recovery browser URL unavailable")), 5000)
  const renewed = new URL(await opened.promise.finally(() => clearTimeout(recovery)))
  assert.equal(renewed.searchParams.get("directory"), directory)
  assert.equal(renewed.searchParams.get("session"), coding.session)
  await page.goto(renewed.href)
  await expect(page.getByText("LIVE WORKSPACE UPDATES", { exact: true })).toBeVisible()
  await page.locator("#request").selectOption(failed.id)
  await page.locator(".retrieval-history summary").click()
  await expect(page.locator(".retrieval-history")).toContainText("Retrieval execution: failed; last phase: selection")
  await expect(page.getByRole("alert")).toHaveCount(0)
  assert.equal(new URL(page.url()).hash, "")
  assert.equal(calls.length, count, "Browser reauthentication must not call the provider")
  const imports = await read<ImportHistory>(`/forge/knowledge/${registry.collections.at(0)!.id}/imports?session=${coding.session}`)
  assert(imports.runs.length >= 2)
  assert.equal(imports.selected?.state, "published")
  assert.equal(imports.documents.at(0)?.state, "reused")
  const name = imports.documents.at(0)?.name
  assert(name)
  if (documents === 1) assert.equal(name, "ownership.md")
  assert(!JSON.stringify(imports).includes(evidence))
  const earliest = await read<ImportHistory>(`/forge/knowledge/${registry.collections.at(0)!.id}/imports?session=${coding.session}&run=${imports.runs.at(-1)!.id}`)
  assert.equal(earliest.documents.at(0)?.name, name)
  assert.equal(earliest.documents.at(0)?.state, "extracted")
  await page.getByRole("button", { name: "Inspect import history", exact: true }).click()
  const history = page.getByRole("article", { name: "Import history", exact: true })
  await expect(history).toContainText(`${name}: reused`)
  await history.getByLabel("Import run", { exact: true }).selectOption(earliest.selected!.id)
  await expect(history).toContainText(`${name}: extracted`)
  proc.write("k")
  await repaint("[j] Inspect import history")
  proc.write("j")
  await repaint("Import run published")
  await wait(`${name}: reused`)
  for (let index = 1; index < imports.runs.length; index++) {
    proc.write("o")
    await repaint("Import run published")
  }
  await repaint(`${name}: extracted`)
  proc.write("q")
  await repaint("Forge knowledge library")
  assert.equal(calls.length, count, "Import history inspection must not call the provider")
  const pinned = await read<Source>(`/forge/source/${pin}`)
  await Bun.write(path.join(manuals, "ownership.md"), `# Orchid ownership\n\n${evidence}\n\nUpdated: reviewers must confirm this document version.\n`)
  await page.getByRole("button", { name: "Refresh documents", exact: true }).click()
  await expect.poll(async () => read<Source>(`/forge/source/${pin}`).then((source) => source.hash !== pinned.hash, () => false), { timeout: 30_000 }).toBe(true)
  const changed = await read<Source>(`/forge/source/${pin}`)
  const stale = await fetch(endpoint, {
    method: "POST", headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify({ text: "Inspect the updated queue policy", session: coding.session }),
    signal: AbortSignal.timeout(30_000),
  })
  assert(!stale.ok)
  assert((await stale.text()).includes("Pinned excerpt changed"))
  assert.equal(calls.length, count, "Stale pin must block preparation before provider calls")
  await page.locator("#request").selectOption("")
  await page.getByRole("button", { name: "Reload view", exact: true }).click()
  await page.getByRole("button", { name: "Source table", exact: true }).click()
  await page.getByLabel("Search sources").fill("orchid queue")
  await page.getByRole("button", { name: "Search", exact: true }).click()
  await page.getByRole("table").getByRole("button").first().click()
  await page.getByLabel(/Context controls/).selectOption("")
  await expect(page.getByText("Pinned source version changed.", { exact: false })).toBeVisible()
  await expect(page.getByRole("button", { name: "Confirm current pin version", exact: true })).toBeEnabled()
  await page.getByRole("button", { name: "Confirm current pin version", exact: true }).click()
  await expect(page.getByText("Pin matches this inspected source version.", { exact: true })).toBeVisible()
  const confirmed = await read<Policy>("/forge/policy")
  assert.equal(confirmed.versions?.[pin], binding(changed))
  assert.equal(calls.length, count, "Pin version confirmation must not call the provider")
  assert.deepEqual(errors, [])
  const snapshot = process.env.FORGE_WORKFLOW_SCREENSHOT
  if (snapshot) await page.screenshot({ path: snapshot, fullPage: true })
  console.log(JSON.stringify({
    mode, action, routing, platform: `${os.platform()} ${os.release()} ${os.arch()}`, bun: Bun.version,
    startup, elapsed: performance.now() - began, session: coding.session,
    assets, brief: { id: parent.id, hash: parent.hash, version: parent.detail.briefVersion, evidence: parent.evidence }, pin, policy: policy.version, confirmation: { policy: confirmed.version, previous: binding(pinned), current: binding(changed) }, operation: coding.operation, preparation: preparation.id, coding: coding.id,
    calls: calls.map((call) => call.kind), attempts: coding.attempts, lookups: coding.lookups,
    channels: preparation.selection?.channels,
    retrieval: preparation.retrieval, failed: { id: failed.id, retrieval: failed.retrieval, entries: failed.entries.length, attempts: failed.attempts }, imports,
    passed: ["browser folder preview/register/index/share", "stored document brief expands to original evidence without becoming selected context", "document pin action opens original-section selection without pinning the parent", "browser persisted pin", "terminal enhance/review", `terminal ${action}`, "actual SDK coding stream", "captured source version", "browser historical selection", "terminal coding capture", "failed selection retains channel execution without provider calls", "browser and terminal failed execution history", "hard reload explains reauthentication", "fresh terminal handoff restores retained history without model calls or browser credential storage", "browser and terminal retain original and reused import outcomes without excerpts or model calls", "changed document pin blocks preparation before provider calls and requires explicit current-version confirmation"],
    limits: [existing ? "Temporary workspace with a harness-owned pre-existing isolated daemon; no user daemon." : "Temporary workspace and isolated user state; no existing daemon.", inspection ? `Fixed local responses with one real ${tool} call, not model quality.` : "Fixed local responses, not model quality or tool execution.", "PTY emitted text, not terminal pixels.", ...(lifecycle ? ["Local saved-session restart, not large-corpus launcher latency."] : ["No attachment, compaction, or restart in this scenario."])],
  }, null, 2))
  }
} catch (err) {
  record("failure", { error: String(err), terminal: Bun.stripANSI(text), body: await page.locator("body").innerText() })
  console.error(err)
  console.error(Bun.stripANSI(text).slice(-10000))
  console.error(await page.locator("body").innerText())
  console.error(`Fixture calls: ${calls.map((call) => call.kind).join(", ")}`)
  throw err
} finally {
  await browser.close()
}
