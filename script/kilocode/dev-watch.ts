import { existsSync, watch as observe, type FSWatcher } from "node:fs"
import path from "node:path"
import { command } from "./forge-command"

const configs = new Set(["package.json", "bunfig.toml", "tsconfig.json", "bun.lock"])
const ignored = new Set(["node_modules", "dist", ".git", ".cache"])

export async function watch(opts: { root: string; cmd: string[]; cwd: string; env?: NodeJS.ProcessEnv; prepare?: () => Promise<void> }) {
  const watchers: FSWatcher[] = []
  const terminal = process.stdin.isTTY && process.stdout.isTTY
  const mode =
    terminal && process.platform !== "win32"
      ? Bun.spawnSync(["stty", "-g"], { stdin: "inherit", stderr: "ignore" }).stdout.toString().trim()
      : ""
  let child: ReturnType<typeof Bun.spawn> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let changed = false
  let stopping = false
  let signal: NodeJS.Signals | undefined
  let wake = Promise.withResolvers<void>()

  function notify() {
    clearTimeout(timer)
    timer = setTimeout(() => {
      changed = true
      wake.resolve()
    }, 250)
  }

  function subscribe(dir: string, recursive: boolean) {
    if (!existsSync(dir)) return
    const watcher = observe(dir, { recursive }, (_, file) => {
      if (!file) return notify()
      if (recursive && file.split(/[\\/]/).some((part) => ignored.has(part))) return
      if (!recursive && !configs.has(file)) return
      notify()
    })
    watcher.on("error", (err) => {
      console.error("[dev:watch] File watcher failed:", err)
      stop("SIGTERM")
    })
    watchers.push(watcher)
  }

  function restore() {
    if (!terminal) return
    // Also recover the terminal if a stuck child needed SIGKILL.
    process.stdout.write("\x1b[?1049l\x1b[?25h\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[0m")
    if (mode) Bun.spawnSync(["stty", mode], { stdin: "inherit", stderr: "inherit" })
  }

  function stop(value: NodeJS.Signals) {
    signal = value
    stopping = true
    wake.resolve()
  }

  async function terminate() {
    const current = child
    if (!current || current.exitCode !== null) return
    current.kill(signal ?? "SIGTERM")
    // The TUI gives its worker five seconds to shut down.
    const timeout = setTimeout(() => current.kill("SIGKILL"), 8000)
    try {
      await current.exited
    } finally {
      clearTimeout(timeout)
    }
  }

  const signals = {
    SIGINT: () => stop("SIGINT"),
    SIGTERM: () => stop("SIGTERM"),
    SIGHUP: () => stop("SIGHUP"),
  }

  try {
    subscribe(opts.root, false)
    const manifest = await Bun.file(path.join(opts.root, "package.json")).json()
    const patterns: string[] = Array.isArray(manifest.workspaces) ? manifest.workspaces : manifest.workspaces.packages
    for (const pattern of patterns) {
      for await (const file of new Bun.Glob(`${pattern}/package.json`).scan({ cwd: opts.root, onlyFiles: true })) {
        const dir = path.dirname(path.join(opts.root, file))
        subscribe(dir, false)
        subscribe(path.join(dir, "src"), true)
      }
    }
    for (const [name, handler] of Object.entries(signals)) process.on(name, handler)

    console.error("[dev:watch] Watching workspace src folders and package configs. Saving restarts the CLI.")
    console.error("[dev:watch] Restarts interrupt active work and discard unsent input. Exit the TUI to stop.")
    while (true) {
      if (stopping) break
      changed = false
      wake = Promise.withResolvers<void>()
      const ready = await Promise.resolve().then(() => opts.prepare?.()).then(() => true, (err) => {
        console.error("[dev:watch] Preparation failed. Waiting for an edit to retry:", err)
        return false
      })
      if (!ready) {
        if (!stopping) await wake.promise
        continue
      }
      if (stopping) break
      child = Bun.spawn(opts.cmd, {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      })
      const result = await Promise.race([child.exited.then((code) => ({ code })), wake.promise.then(() => undefined)])
      if (stopping) break
      if (result && !changed) {
        restore()
        if (result.code === 0 || child.signalCode) return result.code
        console.error(`[dev:watch] CLI exited (${result.code}). Waiting for an edit to retry.`)
        await wake.promise
        if (stopping) break
      }
      await terminate()
      restore()
      console.error("[dev:watch] Source changed. Restarting...")
    }
    return signal === "SIGINT" ? 130 : signal === "SIGHUP" ? 129 : 143
  } finally {
    stopping = true
    clearTimeout(timer)
    for (const watcher of watchers) watcher.close()
    await terminate()
    restore()
    for (const [name, handler] of Object.entries(signals)) process.off(name, handler)
  }
}

if (import.meta.main) {
  const root = path.resolve(import.meta.dirname, "../..")
  const launch = command(root, process.argv.slice(2))
  process.exitCode = await watch({
    root,
    ...launch,
    env: { ...launch.env, KILO_CLIENT: "cli", KILO_NO_DAEMON: "1", KILO_DISABLE_AUTOUPDATE: "true" },
    prepare: async () => {
      console.error("[dev:watch] Building Forge browser assets...")
      const child = Bun.spawn([process.execPath, "run", "build"], { cwd: path.join(root, "packages/kilo-forge-ui"), stdin: "ignore", stdout: "inherit", stderr: "inherit" })
      if (await child.exited !== 0) throw new Error("Forge browser asset build failed")
    },
  })
}
