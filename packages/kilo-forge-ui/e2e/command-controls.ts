import assert from "node:assert/strict"
import { chmod, mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawn } from "../../core/src/pty/driver"
import { listener } from "./process"
import type { Manifest } from "@kilocode/forge/schema"

// Frozen-package PTY supplement to workflow.ts; run only under the loopback supervisor.
const root = path.resolve(import.meta.dirname, "../../..")
const output = process.env.FORGE_CONTROLS_OUTPUT
assert(output && process.env.FORCE_REUSE_UI === "1")
assert(!(await Bun.file(output).exists()), "Never replace a retained attempt")
const binary = process.env.FORGE_CONTROLS_BINARY
const expected = process.env.FORGE_CONTROLS_SHA
const expectedUI = process.env.FORGE_CONTROLS_UI_SHA
const asset = process.env.FORGE_CONTROLS_ASSET
assert(binary && path.isAbsolute(binary), "Provide the absolute frozen binary path")
assert(expected && /^[a-f0-9]{64}$/.test(expected), "Provide the frozen binary SHA-256")
assert(expectedUI && /^[a-f0-9]{64}$/.test(expectedUI), "Provide the frozen UI SHA-256")
assert(asset && /^assets\/[\w.-]+\.js$/.test(asset), "Provide the frozen UI asset path")
const digest = (bytes: ArrayBuffer) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
assert.equal(digest(await Bun.file(binary).arrayBuffer()), expected)
assert.equal(digest(await Bun.file(path.join(path.dirname(binary), "forge", asset)).arrayBuffer()), expectedUI)
const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), "forge-command-controls-")))
const directory = path.join(temporary, "workspace")
const home = path.join(temporary, "home")
const bin = path.join(temporary, "bin")
await Promise.all([directory, home, bin].map((dir) => mkdir(dir)))
await Bun.write(path.join(directory, "queue.ts"), "export const queue = []\n")
await Bun.write(path.join(directory, "ownership.md"), "# Orchid queue\nValidate the epoch lease before dispatch.\n")
const records: Array<{ phase: string; data: unknown }> = []
function record(phase: string, data: unknown) {
  records.push({ phase, data })
  console.log(JSON.stringify({ phase, data }))
}
const calls: Array<{ kind: string; body: string }> = []
let gate: { entered: ReturnType<typeof Promise.withResolvers<void>>; release: ReturnType<typeof Promise.withResolvers<void>>; settled: ReturnType<typeof Promise.withResolvers<void>> } | undefined
const opened = Promise.withResolvers<string>()
const fixture = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  async fetch(request) {
    const route = new URL(request.url).pathname
    if (route === "/opened") {
      opened.resolve(await request.text())
      return new Response("Captured")
    }
    assert.equal(route, "/v1/chat/completions")
    const body = await request.text()
    const value: unknown = JSON.parse(body)
    assert(value && typeof value === "object" && "messages" in value)
    const streaming = "stream" in value && value.stream === true
    const kind = body.includes("Repository evidence (untrusted source material)") ? "enhance" : streaming ? "coding" : "auxiliary"
    calls.push({ kind, body })
    record("fixture", { kind, count: calls.length })
    assert(calls.length <= 16, "Unexpected inference loop")
    if (kind === "enhance" && gate) {
      const held = gate
      held.entered.resolve()
      const timer = setTimeout(() => held.release.reject(new Error("Held response deadline")), 20_000)
      try { await held.release.promise } finally { clearTimeout(timer); held.settled.resolve() }
    }
    const content = kind === "enhance" ? JSON.stringify({
      objective: "Inspect orchid queue ownership without changing files.",
      reuse: [], inspect: ["Read the ownership document"], changes: [],
      constraints: ["Keep permissions unchanged"], hypotheses: [], questions: [],
      acceptance: ["Report the epoch lease requirement"], verification: [], evidence: [],
    }) : "Command control fixture completed."
    const usage = { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 }
    if (!streaming) return Response.json({
      id: "controls", object: "chat.completion", created: 1, model: "test",
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage,
    })
    const first = calls.filter((call) => call.kind === "coding").length === 1
    const chunks = [
      { delta: { role: "assistant" }, finish_reason: null },
      { delta: first ? { tool_calls: [{ index: 0, id: "permission-control", type: "function", function: {
        name: "bash", arguments: JSON.stringify({ command: "touch permission-canary", description: "Permission preservation control" }),
      } }] } : { content }, finish_reason: null },
      { delta: {}, finish_reason: first ? "tool_calls" : "stop" },
    ].map((choice) => `data: ${JSON.stringify({
      id: "controls", object: "chat.completion.chunk", created: 1, model: "test",
      choices: [{ index: 0, ...choice }], ...(choice.finish_reason ? { usage } : {}),
    })}\n\n`).join("")
    return new Response(`${chunks}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
  },
})
await Bun.write(path.join(bin, "open"), `#!${process.execPath}\nawait fetch(${JSON.stringify(`${fixture.url}opened`)},{method:"POST",body:process.argv.at(-1)})\n`)
await chmod(path.join(bin, "open"), 0o700)
const permission = { bash: "ask", edit: "ask" }
const env = {
  BUN_BE_BUN: "", PATH: `${bin}:${process.env.PATH ?? ""}`, HOME: home, KILO_TEST_HOME: home,
  XDG_CONFIG_HOME: path.join(home, "config"), XDG_DATA_HOME: path.join(home, "data"),
  XDG_STATE_HOME: path.join(home, "state"), XDG_CACHE_HOME: path.join(home, "cache"),
  TERM: "xterm-256color", COLORTERM: "truecolor", KILO_AUTH_CONTENT: "{}",
  KILO_DISABLE_PROJECT_CONFIG: "1", KILO_DISABLE_MODELS_FETCH: "1", KILO_DISABLE_AUTOUPDATE: "1",
  KILO_TELEMETRY_LEVEL: "off", KILO_SERVER_PASSWORD: "command-controls",
  KILO_TEST_DAEMON_STATE_DIR: path.join(home, "daemon"), KILO_TEST_DAEMON_EPHEMERAL_PORT: "1",
  KILO_CONFIG_CONTENT: JSON.stringify({
    model: "probe/test", small_model: "probe/test", enabled_providers: ["probe"],
    indexing: { enabled: false }, snapshot: false, formatter: false, lsp: false, permission,
    provider: { probe: {
      npm: "@ai-sdk/openai-compatible", options: { baseURL: `${fixture.url}v1`, apiKey: "fixture" },
      models: { test: { name: "Command control probe", limit: { context: 32000, output: 4000 } } },
    } },
  }),
}
let text = ""
let exited = false
let origin = ""
let authorization = ""
let passed = false
const began = performance.now()
const pending = new Set<() => void>()
const done = Promise.withResolvers<void>()
const proc = spawn(binary, [directory], { cwd: root, env, name: "xterm-256color", cols: 150, rows: 52 })
const data = proc.onData((chunk) => {
  text = (text + chunk).slice(-200_000)
  if (chunk.includes("\x1b[6n")) proc.write("\x1b[1;1R")
  if (chunk.includes("\x1b[c")) proc.write("\x1b[?1;2c")
  for (const notify of pending) notify()
})
const exit = proc.onExit(() => { exited = true; done.resolve(); for (const notify of pending) notify() })
async function wait(value: string, timeout = 30_000) {
  const result = Promise.withResolvers<void>()
  const check = () => {
    if (Bun.stripANSI(text).replace(/\s/g, "").includes(value.replace(/\s/g, ""))) result.resolve()
    if (exited) result.reject(new Error(`CLI exited before ${value}`))
  }
  const timer = setTimeout(() => result.reject(new Error(`Timed out waiting for ${value}`)), timeout)
  pending.add(check); check()
  try { await result.promise } finally { clearTimeout(timer); pending.delete(check) }
}
async function repaint(value: string) {
  const deadline = performance.now() + 15_000
  let columns = 154
  while (true) {
    text = ""
    proc.resize(columns, 53)
    columns = columns === 154 ? 155 : 154
    try { await wait(value, 1000); return } catch (err) {
      if (exited || performance.now() >= deadline) throw err
    }
  }
}
function paste(value: string, submit = true) {
  text = ""
  proc.write(`\x15\x1b[200~${value}\x1b[201~${submit ? "\r" : ""}`)
}
async function request<T>(route: string, method = "GET", body?: unknown): Promise<T> {
  const url = new URL(route, origin)
  url.searchParams.set("directory", directory)
  const response = await fetch(url, {
    method, headers: { authorization, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000),
  })
  assert(response.ok, `${route}: ${response.status} ${await response.clone().text()}`)
  return response.json() as Promise<T>
}
async function until<T>(fn: () => Promise<T | undefined>, label: string) {
  const deadline = performance.now() + 15_000
  while (performance.now() < deadline) {
    const value = await fn()
    if (value !== undefined) return value
    await Bun.sleep(50)
  }
  throw new Error(label)
}
async function quiet(label: string) {
  // Bounded negative observation after the actual key event, not an instantaneous count.
  const deadline = performance.now() + 750
  do {
    assert.equal(calls.filter((call) => call.kind === "coding").length, 0, label)
    assert(!(await Bun.file(path.join(directory, "permission-canary")).exists()))
    await Bun.sleep(50)
  } while (performance.now() < deadline)
  assert.deepEqual(await request("/forge/requests?purpose=coding"), [])
  assert.deepEqual(await request("/session"), [], "Rejected shell draft must not create even a shell session")
  assert.deepEqual((await request<{ permission: unknown }>("/config")).permission, permission)
  record(label, { codingCalls: 0, permission, terminal: Bun.stripANSI(text) })
}
try {
  await wait("Command control probe")
  paste("/map knowledge")
  await wait("Forge · map · agent knowledge")
  const timer = setTimeout(() => opened.reject(new Error("Missing browser handoff")), 5000)
  const url = new URL(await opened.promise.finally(() => clearTimeout(timer)))
  origin = url.origin
  authorization = new URLSearchParams(url.hash.slice(1)).get("authorization") ?? ""
  assert(authorization)
  const html = await fetch(`${origin}/forge/`, { headers: { authorization } }).then((response) => response.text())
  const script = html.match(/src="([^"]+\.js)"/)?.at(1)
  assert(script)
  const served = digest(await fetch(new URL(script, origin), { headers: { authorization } }).then((response) => response.arrayBuffer()))
  assert.equal(served, expectedUI)
  record("identity", { binary, hash: expected, served, script, pid: await listener(origin), directory, fixture: fixture.url.origin, rebuild: false })
  text = ""; proc.write("r")
  await repaint("Command control probe")
  proc.write("\x15")
  await Bun.sleep(50)
  proc.write("!")
  await repaint("exit shell mode")
  record("shell-mode", { terminal: Bun.stripANSI(text) })
  const original = "Inspect orchid queue ownership.\nPreserve retry behavior.\nKeep the existing API.\nKeep permissions unchanged.\nDo not change files."
  paste("/enhance ", false)
  proc.write(`\x1b[200~${original}\x1b[201~`)
  await repaint("[Pasted")
  record("pasted", { original, terminal: Bun.stripANSI(text) })
  text = ""; proc.write("\r")
  await wait("[a] Accept and run")
  assert(calls.find((call) => call.kind === "enhance")?.body.includes(original.replace(/\n/g, "\\n")))
  await quiet("ready-no-coding")
  text = ""; proc.write("r")
  await repaint("exit shell mode")
  await quiet("reject-no-coding")
  text = ""; proc.write("\r")
  await wait("[a] Accept and run")
  text = ""; proc.write("\x1b")
  await repaint("exit shell mode")
  await quiet("escape-ready-no-coding")
  gate = { entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>(), settled: Promise.withResolvers<void>() }
  text = ""; proc.write("\r")
  await wait("Gathering and checking")
  await gate.entered.promise
  text = ""; proc.write("\x1b")
  await repaint("exit shell mode")
  gate.release.resolve()
  await gate.settled.promise
  gate = undefined
  await quiet("escape-held-no-coding")
  assert(!Bun.stripANSI(text).includes("[a] Accept and run"), "Late result reopened cancelled review")
  text = ""; proc.write("\r")
  await wait("[a] Accept and run")
  await quiet("explicit-accept-required")
  const preparation = (await request<Manifest[]>("/forge/requests?purpose=enhance")).find((item) => item.state === "completed")
  assert(preparation)
  text = ""; proc.write("a")
  await repaint("Permission")
  const permissions = await until(async () => {
    const values = await request<Array<{ id: string; sessionID: string; permission: string; patterns: string[] }>>("/permission")
    return values.find((item) => item.permission === "bash")
  }, "Normal permission did not ask for bash")
  assert.equal(calls.filter((call) => call.kind === "coding").length, 1)
  assert(!(await Bun.file(path.join(directory, "permission-canary")).exists()))
  assert.deepEqual((await request<{ permission: unknown }>("/config")).permission, permission)
  const coding = calls.find((call) => call.kind === "coding")!
  for (const line of original.split("\n")) assert(coding.body.includes(line), `Lost pasted requirement: ${line}`)
  assert(coding.body.includes("<forge-evidence>"))
  assert(!coding.body.includes("[Pasted"))
  const messages = await request<Array<{ info: { role: string }; parts: Array<{ type: string; tool?: string; text?: string }> }>>(`/session/${permissions.sessionID}/message`)
  assert(messages.some((item) => item.info.role === "user" && item.parts.some((part) => part.type === "text" && part.text?.includes("<forge-evidence>"))))
  assert(!messages.some((item) => item.parts.some((part) => part.text?.includes("The following tool was executed by the user"))), "Prepared task entered shell execution")
  record("accept-normal-coding", { permission: permissions, config: permission, preparation: preparation.id, messages, terminal: Bun.stripANSI(text) })
  await request(`/permission/${permissions.id}/reply`, "POST", { reply: "reject" })
  await repaint("Command control fixture completed.")
  assert(!(await Bun.file(path.join(directory, "permission-canary")).exists()))
  const captured = await until(async () => (await request<Manifest[]>(`/forge/requests?purpose=coding&session=${permissions.sessionID}`)).find((item) => item.state === "completed"), "Missing coding capture")
  assert.equal(captured.preparation, preparation.id)
  record("permission-rejected", { canaryAbsent: true, capture: captured })
  const next = await request<{ id: string }>("/session", "POST", { title: "Controls destination" })
  const count = calls.filter((call) => call.kind === "coding").length
  gate = { entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>(), settled: Promise.withResolvers<void>() }
  paste("/enhance Inspect orchid queue after session change.")
  await wait("Gathering and checking")
  await gate.entered.promise
  await request("/tui/select-session", "POST", { sessionID: next.id })
  await repaint("Controls destination")
  record("session-switched-while-held", { next: next.id, terminal: Bun.stripANSI(text) })
  gate.release.resolve()
  await gate.settled.promise
  gate = undefined
  await Bun.sleep(250)
  await repaint("Controls destination")
  proc.write("a")
  await Bun.sleep(750)
  const stale = Bun.stripANSI(text).includes("[a] Accept and run")
  assert.equal(calls.filter((call) => call.kind === "coding").length, count)
  assert.deepEqual(await request(`/forge/requests?session=${next.id}`), [])
  assert.deepEqual(await request(`/session/${next.id}/message`), [])
  assert.deepEqual((await request<{ permission: unknown }>("/config")).permission, permission)
  record("held-session-switch", { old: permissions.sessionID, next: next.id, addedCodingCalls: 0, staleReviewVisible: stale, terminal: Bun.stripANSI(text) })
  text = ""; proc.write("\x1b")
  await repaint("Command control probe")
  paste("/enhance Inspect orchid queue in the destination session.")
  await wait("[a] Accept and run")
  const fresh = (await request<Manifest[]>(`/forge/requests?purpose=enhance&session=${next.id}`)).find((item) => item.state === "completed")
  assert(fresh)
  text = ""; proc.write("r")
  await repaint("Command control probe")
  assert.equal(calls.filter((call) => call.kind === "coding").length, count)
  assert.deepEqual(await request(`/session/${next.id}/message`), [])
  record("switch-recovery", { session: next.id, preparation: fresh.id, addedCodingCalls: 0, terminal: Bun.stripANSI(text) })
  assert(!stale, "Late old-session review remains visible with Accept label after confirmed session switch; submission stayed blocked")
  passed = true
} catch (err) {
  record("failure", { error: String(err), terminal: Bun.stripANSI(text) })
  throw err
} finally {
  gate?.release.resolve()
  if (!exited) proc.kill("SIGTERM")
  const timer = setTimeout(() => proc.kill("SIGKILL"), 8000)
  try { await done.promise } finally { clearTimeout(timer); data.dispose(); exit.dispose() }
  const closed = !origin || await until(async () => fetch(`${origin}/global/health`, { signal: AbortSignal.timeout(1000) }).then(
    () => undefined,
    (err: unknown) => err instanceof Error && "code" in err && err.code === "ECONNREFUSED" ? true : undefined,
  ), "Backend survived PTY shutdown")
  await fixture.stop(true)
  assert.equal(digest(await Bun.file(binary).arrayBuffer()), expected)
  record("cleanup", { closed, elapsed: performance.now() - began, passed, binaryUnchanged: true })
  await Bun.write(output, JSON.stringify({ passed, records, calls }, null, 2))
  await rm(temporary, { recursive: true, force: true })
}
