import path from "node:path"

const root = path.resolve(import.meta.dirname, "../..")
const build = Bun.spawn([process.execPath, "run", "build"], { cwd: path.join(root, "packages/kilo-forge-ui"), stdout: "inherit", stderr: "inherit", windowsHide: true })
if (await build.exited) process.exit(1)
const args = process.argv.slice(2).filter((arg, index) => index !== 0 || arg !== "--")
const child = Bun.spawn([process.execPath, "run", "--conditions=node", "src/index.ts", ...args], { cwd: path.join(root, "packages/opencode"), env: { ...process.env, KILO_CLIENT: "cli" }, stdin: "inherit", stdout: "inherit", stderr: "inherit", windowsHide: true })
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => child.kill(signal))
process.exit(await child.exited)
