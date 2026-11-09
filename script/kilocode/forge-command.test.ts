import { expect, test } from "bun:test"
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { command } from "./forge-command"

test("source launchers preserve the JSX runtime cwd and explicitly select the project configuration", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "forge launch-")))
  try {
    await mkdir(path.join(root, ".kilo"))
    await mkdir(path.join(root, "packages/opencode/src"), { recursive: true })
    await Bun.write(path.join(root, ".kilo/forge.jsonc"), '{"investigation":true}')
    await Bun.write(path.join(root, "tsconfig.json"), "{}")
    await Bun.write(path.join(root, "packages/opencode/tsconfig.json"), '{"compilerOptions":{"jsx":"react","jsxFactory":"element"}}')
    await Bun.write(path.join(root, "packages/opencode/src/view.tsx"), 'function element(name: string) { return name }\nexport const view = <probe />\n')
    const config = path.resolve(import.meta.dirname, "../../packages/kilo-forge/src/config.ts")
    await Bun.write(path.join(root, "packages/opencode/src/index.ts"), `
      import { config } from ${JSON.stringify(config)}
      import { view } from "./view"
      console.log(JSON.stringify({
        runtime: process.cwd(),
        directory: process.env.KILO_DEV_CWD,
        args: process.argv.slice(2),
        investigation: (await config(process.env.KILO_DEV_CWD)).investigation,
        view,
      }))
    `)
    for (const args of [[], ["--model", "fixture/test"], ["../other project"], ["serve", "--port", "0"]]) {
      for (const input of [args, ["--", ...args]]) {
        const launch = command(root, input)
        const child = Bun.spawn(launch.cmd, { cwd: launch.cwd, env: launch.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
        const [output, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
        if (code) throw new Error(errors)
        expect(JSON.parse(output)).toEqual({ runtime: path.join(root, "packages/opencode"), directory: root, args, investigation: true, view: "probe" })
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
