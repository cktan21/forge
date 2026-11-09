import path from "node:path"
import { command } from "./forge-command"

const root = path.resolve(import.meta.dirname, "../..")
const build = Bun.spawn([process.execPath, "run", "build"], { cwd: path.join(root, "packages/kilo-forge-ui"), stdout: "inherit", stderr: "inherit", windowsHide: true })
if (await build.exited) process.exit(1)
const launch = command(root, process.argv.slice(2))
const child = Bun.spawn(launch.cmd, { cwd: launch.cwd, env: { ...launch.env, KILO_CLIENT: "cli" }, stdin: "inherit", stdout: "inherit", stderr: "inherit", windowsHide: true })
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => child.kill(signal))
process.exit(await child.exited)
