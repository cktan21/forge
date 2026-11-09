import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import path from "node:path"
import { summarize } from "./report"
import { describe } from "./harness"
import { account } from "./chatgpt"
import { plugins } from "./ablation"

// Only the explicit ChatGPT entry point imports a credential; neither inherits API keys or custom configuration.
export async function run(input: { subscription?: boolean } = {}) {
  if (input.subscription && !process.env.FORGE_EVAL_MODEL)
    throw new Error("Set FORGE_EVAL_MODEL to a GPT model supported by your ChatGPT account")
  const model = process.env.FORGE_EVAL_MODEL ?? "kilo/cohere/north-mini-code:free"
  const provider = input.subscription ? "openai" : "kilo"
  if (!model.startsWith(`${provider}/`)) throw new Error(`This launcher requires the ${provider} provider`)
  const auth = input.subscription
    ? account(await Bun.file(path.join(process.env.XDG_DATA_HOME ?? path.join(homedir(), ".local/share"), "kilo/auth.json")).json())
    : {}
  process.env.FORGE_EVAL_MODEL = model
  const { evaluate, settings } = await import("./evaluate")
  const repo = path.resolve(import.meta.dir, "../../..")
  const output = path.resolve(process.argv.at(2) ?? path.join(repo, "reports", `forge-tools-${Date.now()}`))
  await mkdir(path.dirname(output), { recursive: true })
  await mkdir(output)
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "forge-free-")))
  const password = crypto.randomUUID()
  const ready = Promise.withResolvers<string>()
  const env = {
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR,
    TERM: "dumb",
    HOME: home,
    KILO_TEST_HOME: home,
    XDG_DATA_HOME: `${home}/data`,
    XDG_STATE_HOME: `${home}/state`,
    XDG_CONFIG_HOME: `${home}/config`,
    XDG_CACHE_HOME: `${home}/cache`,
    KILO_AUTH_CONTENT: JSON.stringify(auth),
    KILO_DB: `${home}/kilo.db`,
    KILO_SERVER_PASSWORD: password,
    KILO_SERVER_USERNAME: "kilo",
    KILO_DISABLE_PROJECT_CONFIG: "1",
    KILO_PURE: "1",
    // The built-in Codex plugin installs the OAuth transport and subscription pricing.
    KILO_DISABLE_DEFAULT_PLUGINS: input.subscription ? "0" : "1",
    KILO_DISABLE_EXTERNAL_SKILLS: "1",
    KILO_DISABLE_CLAUDE_CODE: "1",
    KILO_DISABLE_AUTOUPDATE: "1",
    KILO_DISABLE_LSP_DOWNLOAD: "1",
    KILO_NO_DAEMON: "1",
    KILO_TELEMETRY_LEVEL: "off",
    KILO_CONFIG_CONTENT: JSON.stringify({ ...settings, ...(input.subscription ? { plugin: plugins } : {}), enabled_providers: [provider] }),
  }
  const child = Bun.spawn(
    [
      process.execPath,
      "run",
      "--conditions=node",
      path.join(repo, "packages/opencode/src/index.ts"),
      "serve",
      "--hostname",
      "127.0.0.1",
      "--port",
      "0",
    ],
    { cwd: home, env, stdout: "pipe", stderr: "pipe" },
  )
  let log = ""
  const drains = [child.stdout, child.stderr].map(async (stream) => {
    for await (const chunk of stream) {
      log = (log + new TextDecoder().decode(chunk)).slice(-30000)
      const url = /kilo server listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(log)?.at(1)
      if (url) ready.resolve(url)
    }
  })
  const timer = setTimeout(() => ready.reject(new Error(`Backend readiness deadline: ${log}`)), 60000)
  let error = ""
  try {
    const base = await Promise.race([
      ready.promise,
      child.exited.then((code) => {
        throw new Error(`Backend exited ${code}: ${log}`)
      }),
    ]).finally(() => clearTimeout(timer))
    await evaluate({
      base,
      password,
      output,
      tools: true,
      subscription: input.subscription,
      investigative: false,
      trials: Number(process.env.FORGE_EVAL_TRIALS ?? 2),
    })
  } catch (err) {
    error = describe(err)
    process.exitCode = 1
    console.error(error)
  } finally {
    clearTimeout(timer)
    child.kill()
    const stop = setTimeout(() => child.kill("SIGKILL"), 5000)
    await child.exited.finally(() => clearTimeout(stop))
    await Promise.all(drains)
    await Bun.write(path.join(home, "backend.log"), log)
    const result = Bun.file(path.join(output, "results.json"))
    if (await result.exists()) {
      const report = summarize(await result.json(), true)
      await Bun.write(path.join(output, "report.md"), report.text)
      console.log(JSON.stringify(report.arms, null, 2))
      console.log(`Report: ${path.join(output, "report.md")}`)
    }
    if (error) {
      await Bun.write(path.join(output, "failure.txt"), `${error}\nBackend diagnostics: ${home}/backend.log\n`)
    }
    if (!error) await rm(home, { recursive: true, force: true })
  }
}

if (import.meta.main) await run()
