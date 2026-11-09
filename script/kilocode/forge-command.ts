import path from "node:path"

export function command(root: string, input: readonly string[]) {
  const args = input.at(0) === "--" ? input.slice(1) : input
  return {
    // Bun must start with the CLI's SolidJS configuration; the TUI resolves its
    // project separately through the existing development-workspace override.
    cwd: path.join(root, "packages/opencode"),
    cmd: [process.execPath, "run", "--conditions=node", path.join(root, "packages/opencode/src/index.ts"), ...args],
    env: { ...process.env, KILO_DEV_CWD: root },
  }
}
