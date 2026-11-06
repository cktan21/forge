import path from "node:path"
import { cp } from "node:fs/promises"

export async function buildForge() {
  const root = path.resolve(import.meta.dirname, "../../../kilo-forge-ui")
  const proc = Bun.spawn([process.execPath, "run", "build"], { cwd: root, stdout: "inherit", stderr: "inherit", windowsHide: true })
  if (await proc.exited) throw new Error("Forge source map build failed")
  return path.join(root, "dist")
}

export async function copyForge(input: string, output: string) {
  await cp(input, path.join(output, "forge"), { recursive: true })
}
