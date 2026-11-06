import { expect, test } from "bun:test"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

async function fixture(prepare = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), "kilo-watch-"))
  for (const dir of ["packages/cli/src", "packages/worker/src", "packages/cli/dist", "packages/cli/test"]) {
    await mkdir(path.join(root, dir), { recursive: true })
  }
  await Bun.write(path.join(root, "package.json"), JSON.stringify({ workspaces: { packages: ["packages/*"] } }))
  for (const name of ["cli", "worker"]) {
    await Bun.write(path.join(root, `packages/${name}/package.json`), "{}")
    await Bun.write(path.join(root, `packages/${name}/src/index.ts`), "ok")
  }
  const log = path.join(root, "events")
  const source = path.join(root, "packages/cli/src/index.ts")
  const script = `
    import { appendFileSync, readFileSync } from "node:fs"
    const log = (event) => appendFileSync(${JSON.stringify(log)}, event + "\\n")
    if (readFileSync(${JSON.stringify(source)}, "utf8") === "bad") {
      log("error")
      process.exit(1)
    }
    log("start:" + process.pid)
    process.on("SIGTERM", () => {
      log("stop:" + process.pid)
      setTimeout(() => { log("exit:" + process.pid); process.exit(0) }, 100)
    })
    process.on("SIGINT", () => process.exit(0))
    setInterval(() => {}, 1000)
  `
  const entry = path.join(import.meta.dirname, "dev-watch.ts")
  const options = { root, cwd: root, cmd: [process.execPath, "-e", script] }
  const child = Bun.spawn([process.execPath, "-e", `
    import { watch } from ${JSON.stringify(entry)}
    import { appendFileSync, readFileSync } from "node:fs"
    process.exitCode = await watch({ ...${JSON.stringify(options)}, ${prepare ? `prepare: async () => {
      appendFileSync(${JSON.stringify(log)}, "prepare\\n")
      if (readFileSync(${JSON.stringify(source)}, "utf8") === "bad") throw new Error("Invalid browser source")
    }` : ""} })
  `], { cwd: root, stdin: "ignore", stdout: "ignore", stderr: "pipe" })
  const errors = new Response(child.stderr).text()
  async function events() {
    return (await Bun.file(log).text().catch(() => "")).trim().split("\n").filter(Boolean)
  }
  async function until(check: (lines: string[]) => boolean) {
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      const lines = await events()
      if (check(lines)) return lines
      if (child.exitCode !== null) throw new Error(`Watcher exited: ${await errors}`)
      await Bun.sleep(20)
    }
    throw new Error(`Timed out waiting for watcher: ${(await events()).join(", ")}`)
  }
  return {
    child,
    events,
    until,
    write: (file: string, text: string) => Bun.write(path.join(root, file), text),
    async close() {
      child.kill("SIGTERM")
      const timeout = setTimeout(() => child.kill("SIGKILL"), 10000)
      try {
        await child.exited
      } finally {
        clearTimeout(timeout)
        await rm(root, { recursive: true, force: true })
      }
    },
  }
}

test("restarts for worker-only source edits, coalesces saves, and waits for shutdown", async () => {
  const run = await fixture()
  try {
    const initial = await run.until((lines) => lines.length === 1)
    const pid = initial.at(0)!.split(":").at(1)
    for (let index = 0; index < 5; index++) {
      await run.write("packages/worker/src/index.ts", String(index))
    }
    const lines = await run.until((lines) => lines.filter((line) => line.startsWith("start:")).length === 2)
    expect(lines.slice(0, 3)).toEqual([`start:${pid}`, `stop:${pid}`, `exit:${pid}`])
    await Bun.sleep(400)
    expect((await run.events()).filter((line) => line.startsWith("start:"))).toHaveLength(2)
    run.child.kill("SIGTERM")
    expect(await run.child.exited).toBe(143)
    expect((await run.events()).at(-1)).toBe(`exit:${lines.at(-1)!.split(":").at(1)}`)
  } finally {
    await run.close()
  }
}, 15000)

test("ignores build output and tests but restarts for package configuration", async () => {
  const run = await fixture()
  try {
    await run.until((lines) => lines.length === 1)
    await run.write("packages/cli/dist/bundle.js", "generated")
    await run.write("packages/cli/test/example.test.ts", "test")
    await Bun.sleep(600)
    expect(await run.events()).toHaveLength(1)
    await run.write("packages/cli/package.json", '{"name":"changed"}')
    await run.until((lines) => lines.filter((line) => line.startsWith("start:")).length === 2)
  } finally {
    await run.close()
  }
}, 15000)

test("recovers from a failed child after the next edit", async () => {
  const run = await fixture()
  try {
    await run.until((lines) => lines.length === 1)
    await run.write("packages/cli/src/index.ts", "bad")
    await run.until((lines) => lines.includes("error"))
    await run.write("packages/cli/src/index.ts", "fixed")
    await run.until((lines) => lines.filter((line) => line.startsWith("start:")).length === 2)
  } finally {
    await run.close()
  }
}, 15000)

test("stops watching when the TUI exits normally", async () => {
  const run = await fixture()
  try {
    const lines = await run.until((lines) => lines.length === 1)
    process.kill(Number(lines.at(0)!.split(":").at(1)), "SIGINT")
    expect(await run.child.exited).toBe(0)
  } finally {
    await run.close()
  }
}, 15000)

test("build preparation runs before launch and recovers after a failed rebuild", async () => {
  const run = await fixture(true)
  try {
    await run.until((lines) => lines.length === 2)
    expect((await run.events()).at(0)).toBe("prepare")
    await run.write("packages/cli/src/index.ts", "bad")
    await run.until((lines) => lines.filter((line) => line === "prepare").length === 2)
    expect((await run.events()).filter((line) => line.startsWith("start:"))).toHaveLength(1)
    await run.write("packages/cli/src/index.ts", "fixed")
    const lines = await run.until((lines) => lines.filter((line) => line.startsWith("start:")).length === 2)
    expect(lines.at(-2)).toBe("prepare")
  } finally {
    await run.close()
  }
}, 15000)
