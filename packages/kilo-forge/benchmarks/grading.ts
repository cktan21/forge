import { spawn } from "node:child_process"
import { constants } from "node:fs"
import { mkdir, mkdtemp, open, readdir, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Readable } from "node:stream"
import type { Task } from "./tasks"

function paths(names: string[]) {
  const seen = new Map<string, string>()
  const files = new Set(names.map((file) => file.toLowerCase()))
  for (const file of names) {
    const parts = file.split("/")
    if (file.length > 240 || parts.some((part) => !/^[a-zA-Z0-9_.-]+$/.test(part) || part === "." || part === ".."))
      throw new Error(`Invalid fixture path: ${file}`)
    for (let size = 1; size <= parts.length; size++) {
      const prefix = parts.slice(0, size).join("/")
      const key = prefix.toLowerCase()
      const previous = seen.get(key)
      if ((previous != null && previous !== prefix) || (size < parts.length && files.has(key)))
        throw new Error(`Conflicting fixture path: ${file}`)
      seen.set(key, prefix)
    }
  }
}

/** Explicit declarations are exact selected paths, never globs or runner options. */
export function publicTests(task: Pick<Task, "id" | "language" | "files" | "tests">) {
  const pattern =
    task.language === "typescript" ? /(?:^|\/)[^/]+[.](?:test|spec)\.[cm]?[jt]sx?$/ : /(?:^|\/)test[^/]*\.py$/
  const discovered = Object.keys(task.files).filter((file) => pattern.test(file))
  const tests = task.tests ?? discovered.filter((file) => file.startsWith("tests/"))
  paths(tests)
  if (
    !tests.length ||
    tests.length > 200 ||
    new Set(tests.map((file) => file.toLowerCase())).size !== tests.length ||
    tests.some((file) => !Object.hasOwn(task.files, file) || !pattern.test(file)) ||
    (task.tests != null && discovered.some((file) => !tests.includes(file)))
  )
    throw new Error(`Missing public tests or invalid public test declaration: ${task.id}`)
  return [...tests].sort()
}

export async function materialize(root: string, files: Record<string, string>) {
  paths(Object.keys(files))
  root = await realpath(root)
  for (const [file, text] of Object.entries(files)) {
    const target = path.resolve(root, file)
    if (!target.startsWith(`${root}${path.sep}`)) throw new Error(`Invalid fixture path: ${file}`)
    await mkdir(path.dirname(target), { recursive: true })
    if ((await realpath(path.dirname(target))) !== path.dirname(target))
      throw new Error("Evaluation does not accept symlinks")
    await writeFile(target, text, {
      flag: constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
    })
  }
}

export async function files(root: string) {
  root = await realpath(root)
  const result: Record<string, string> = {}
  async function visit(dir: string) {
    const target = path.join(root, dir)
    if ((await realpath(target)) !== target) throw new Error("Evaluation does not accept symlinks")
    for (const entry of await readdir(target, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error("Evaluation does not accept symlinks")
      if ([".git", "node_modules", "__pycache__", ".kilo", ".kilocode", ".pytest_cache"].includes(entry.name)) continue
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await visit(file)
        continue
      }
      if (!entry.isFile()) continue
      if (Object.keys(result).length >= 200) throw new Error("Too many evaluation files")
      // No-follow protects the final component; this is not a sandbox against ancestor replacement.
      const handle = await open(path.join(root, file), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      try {
        const stat = await handle.stat()
        if (!stat.isFile()) throw new Error("Evaluation requires regular files")
        if (stat.size > 1_000_000) throw new Error("Evaluation file exceeds size limit")
        const data = Buffer.alloc(1_000_001)
        let size = 0
        while (size < data.length) {
          const chunk = await handle.read(data, size, data.length - size, size)
          if (!chunk.bytesRead) break
          size += chunk.bytesRead
        }
        if (size > 1_000_000) throw new Error("Evaluation file exceeds size limit")
        result[file] = data.toString("utf8", 0, size)
      } finally {
        await handle.close()
      }
    }
  }
  await visit("")
  return result
}

/** Validate controls before contacting a backend. Checks and references execute only in private graders. */
export async function preflight(tasks: Task[]) {
  if (!tasks.length || new Set(tasks.map((task) => task.id)).size !== tasks.length)
    throw new Error("Preflight requires unique nonempty tasks")
  const baseline = []
  for (const task of tasks) {
    const tests = publicTests(task)
    if (!tests.length || !task.checks.length) throw new Error(`Missing public tests or independent checks: ${task.id}`)
    if (Object.keys(task.solution).some((file) => file.startsWith("tests/") || tests.includes(file)))
      throw new Error(`Reference solution must preserve public tests: ${task.id}`)
    const result = await grade(task, task.files)
    const control = await grade(task, { ...task.files, ...task.solution })
    if (
      result.success ||
      !result.regression ||
      result.hidden.code !== 0 ||
      result.hidden.expired ||
      result.checks.length !== task.checks.length ||
      result.passed >= result.total ||
      !control.success
    )
      throw new Error(
        `Invalid evaluator for ${task.id}: require passing public tests, a failing negative control and a passing reference`,
      )
    baseline.push({
      task: task.id,
      passed: result.passed,
      total: result.total,
      regression: result.regression,
      reference: control.success,
    })
  }
  return baseline
}

async function execute(root: string, command: string[], timeout = 15000) {
  if (process.platform === "win32") throw new Error("Evaluation requires POSIX process groups")
  const child = spawn(command.at(0)!, command.slice(1), {
    cwd: root,
    env: { PATH: process.env.PATH, HOME: root, PYTHONDONTWRITEBYTECODE: "1", NO_COLOR: "1" },
    detached: true,
    stdio: ["ignore", "pipe", "pipe", "pipe"],
  })
  const done = Promise.withResolvers<number>()
  const streams = child.stdio.slice(1).filter((stream): stream is Readable => stream instanceof Readable)
  const output = streams.map(() => Buffer.alloc(0))
  let bytes = 0
  let expired = false
  let overflow = false
  let stopped = false
  function stop() {
    if (stopped) return
    stopped = true
    try {
      if (child.pid) process.kill(-child.pid, "SIGKILL")
    } catch (err) {
      if (!(err instanceof Error && "code" in err && err.code === "ESRCH")) throw err
    }
  }
  function finish() {
    try {
      stop()
      done.resolve(child.exitCode ?? -1)
    } catch (err) {
      done.reject(err)
    } finally {
      // A detached descendant may retain a pipe. Never wait for its EOF after the deadline.
      for (const stream of streams) stream.destroy()
    }
  }
  streams.forEach((stream, index) => {
    stream.on("data", (chunk: Buffer) => {
      if (stopped) return
      bytes += chunk.length
      const limit = index === 2 ? 1_000_000 : 30000
      const previous = output.at(index)!
      output[index] = Buffer.concat([previous, chunk.subarray(-limit)]).subarray(-limit)
      if (bytes <= 1_000_000) return
      overflow = true
      finish()
    })
    stream.on("error", done.reject)
  })
  child.on("error", done.reject)
  child.on("close", (code) => done.resolve(code ?? -1))
  const timer = setTimeout(() => {
    expired = true
    finish()
  }, timeout)
  try {
    const code = await done.promise
    return {
      code,
      stdout: output.at(0)!.toString("utf8"),
      stderr: output.at(1)!.toString("utf8"),
      result: output.at(2)!.toString("utf8"),
      expired,
      overflow,
    }
  } finally {
    clearTimeout(timer)
    try {
      stop()
    } finally {
      for (const stream of streams) stream.destroy()
    }
  }
}

function results(text: string, names: string[]) {
  try {
    const value: unknown = JSON.parse(text)
    if (
      Array.isArray(value) &&
      value.length === names.length &&
      value.every(
        (check: unknown): check is { name: string; pass: boolean; error?: string } =>
          check !== null &&
          typeof check === "object" &&
          "name" in check &&
          typeof check.name === "string" &&
          names.includes(check.name) &&
          "pass" in check &&
          typeof check.pass === "boolean" &&
          (!("error" in check) || typeof check.error === "string"),
      ) &&
      new Set(value.map((check) => check.name)).size === names.length
    )
      return value
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err
    return []
  }
  return []
}

export async function grade(task: Task, patched: Record<string, string>) {
  const names = task.checks.map((check) => check.name)
  if (!names.length || names.some((name) => !name.trim()) || new Set(names).size !== names.length)
    throw new Error("Evaluation requires unique nonempty check names")
  const tests = publicTests(task)
  paths([...new Set([...Object.keys(task.files), ...Object.keys(patched)])])
  // Construct the evaluator only after coding has ended, in a separate private directory.
  const root = await mkdtemp(path.join(tmpdir(), "forge-check-"))
  try {
    const originals = Object.fromEntries(
      Object.entries(task.files).filter(([file]) => file.startsWith("tests/") || tests.includes(file)),
    )
    await materialize(root, { ...patched, ...originals })
    const commands =
      task.language === "typescript"
        ? [[process.execPath, "test", "--no-install", ...tests.map((file) => `./${file}`)]]
        : task.tests == null
          ? [["python3", "-m", "unittest", "discover", "-s", "tests"]]
          : tests.map((file) => [
              "python3",
              "-m",
              "unittest",
              "discover",
              "-s",
              path.posix.dirname(file),
              "-p",
              path.posix.basename(file),
            ])
    const runs = []
    for (const command of commands) runs.push(await execute(root, command))
    const counts = runs.map((run) =>
      Number(
        (task.language === "typescript" ? /(?:^|\n)\s*(\d+) pass\b/ : /Ran (\d+) tests?\b/).exec(run.stderr)?.[1] ?? 0,
      ),
    )
    const regression = {
      code: runs.find((run) => run.code !== 0)?.code ?? 0,
      stdout: runs
        .map((run) => run.stdout)
        .join("\n")
        .slice(-30000),
      stderr: runs
        .map((run) => run.stderr)
        .join("\n")
        .slice(-30000),
      expired: runs.some((run) => run.expired),
      overflow: runs.some((run) => run.overflow),
      count: counts.reduce((sum, count) => sum + count, 0),
    }
    const preserved =
      regression.code === 0 && !regression.expired && !regression.overflow && counts.every((count) => count > 0)
    // FD 3 separates generated results from candidate logs, not from arbitrary malicious code.
    // Candidates execute in the evaluator process with the same OS privileges; no sandbox is provided.
    const script =
      task.language === "typescript"
        ? [
            'import assert from "node:assert/strict"',
            'import { writeFileSync } from "node:fs"',
            "const results = []",
            ...task.checks.map(
              (check) =>
                `try { await (async () => { ${check.code} })(); results.push({name:${JSON.stringify(check.name)},pass:true}) } catch (err) { results.push({name:${JSON.stringify(check.name)},pass:false,error:String(err)}) }`,
            ),
            "writeFileSync(3, JSON.stringify(results))",
          ].join("\n")
        : [
            "import json, unittest, sqlite3, os",
            "from pathlib import Path",
            "class Checks(unittest.TestCase):",
            "    def database(self):",
            "        db = sqlite3.connect(':memory:')",
            "        db.executescript(Path('schema.sql').read_text())",
            "        db.execute(\"INSERT INTO warehouse VALUES (1,'One'),(2,'Two')\")",
            "        return db",
            ...task.checks.map(
              (check, index) =>
                `    def check_${index}(self):\n${check.code
                  .split("\n")
                  .map((line) => `        ${line}`)
                  .join("\n")}`,
            ),
            "results = []",
            "self = Checks()",
            ...task.checks.map(
              (check, index) =>
                `try:\n    self.check_${index}()\n    results.append({"name":${JSON.stringify(check.name)},"pass":True})\nexcept Exception as err:\n    results.append({"name":${JSON.stringify(check.name)},"pass":False,"error":str(err)})`,
            ),
            'with os.fdopen(3, "w") as channel:',
            "    channel.write(json.dumps(results))",
          ].join("\n")
    const name = task.language === "typescript" ? ".forge-evaluator.ts" : ".forge-evaluator.py"
    await writeFile(path.join(root, name), script)
    const hidden = await execute(
      root,
      task.language === "typescript" ? [process.execPath, "run", "--no-install", name] : ["python3", name],
    )
    const checks = hidden.expired || hidden.overflow ? [] : results(hidden.result, names)
    const passed = checks.filter((check) => check.pass).length
    return {
      passed,
      total: task.checks.length,
      success:
        passed === task.checks.length &&
        checks.length === task.checks.length &&
        hidden.code === 0 &&
        !hidden.expired &&
        !hidden.overflow &&
        preserved,
      regression: preserved,
      checks,
      public: regression,
      hidden: {
        code: hidden.code,
        stderr: hidden.stderr,
        expired: hidden.expired,
        overflow: hidden.overflow,
      },
      changed: [...new Set([...Object.keys(task.files), ...Object.keys(patched)])]
        .filter((file) => task.files[file] !== patched[file])
        .sort(),
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
