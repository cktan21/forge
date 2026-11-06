import assert from "node:assert/strict"
import path from "node:path"

// Hash source inputs, not only the browser bundle. Tests/reports are outside watch roots.
export async function fingerprint(root: string) {
  const files = new Set(["package.json", "bun.lock", "script/kilocode/dev-watch.ts"])
  for (const pattern of [
    "packages/*/src/**/*",
    "packages/*/package.json",
    "packages/*/tsconfig.json",
    "packages/sdk/js/src/**/*",
    "packages/sdk/js/package.json",
    "packages/sdk/js/tsconfig.json",
  ]) {
    for await (const file of new Bun.Glob(pattern).scan({ cwd: root, onlyFiles: true })) files.add(file)
  }
  assert(files.size > 1000, "Source fingerprint did not enumerate workspace sources")
  const hasher = new Bun.CryptoHasher("sha256")
  for (const file of [...files].sort()) {
    hasher
      .update(file)
      .update("\0")
      .update(await Bun.file(path.join(root, file)).arrayBuffer())
      .update("\0")
  }
  return { hash: hasher.digest("hex"), files: files.size }
}

export async function listener(origin: string) {
  const port = new URL(origin).port
  const proc = Bun.spawn(["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"], { stdout: "pipe", stderr: "pipe" })
  const output = await new Response(proc.stdout).text()
  assert.equal(await proc.exited, 0, `No listener identified at ${origin}`)
  const pids = [
    ...new Set(
      output
        .split("\n")
        .filter((line) => /^p\d+$/.test(line))
        .map((line) => Number(line.slice(1))),
    ),
  ]
  assert.equal(pids.length, 1, `Ambiguous listener ownership at ${origin}`)
  return pids.at(0)!
}
