import { expect, test } from "bun:test"
import { rejects } from "node:assert/strict"
import { mkdtemp, open, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { files, grade, preflight } from "../grading"
import { type Task, tasks } from "../tasks"

function fixture(): Task {
  return {
    id: "grading",
    language: "typescript",
    prompt: "Grading regression fixture",
    files: {
      "tests/value.test.ts": 'import {test, expect} from "bun:test"; test("public", () => expect(true).toBe(true))',
    },
    checks: [
      { name: "first", code: "assert.ok(true)" },
      { name: "second", code: "assert.ok(true)" },
    ],
    solution: {},
  }
}

for (const language of ["typescript", "python"] as const) {
  test(`${language} candidate stdout cannot replace generated checks or validate a broken reference`, async () => {
    const task = tasks.find((task) => task.language === language)!
    const baseline = await grade(task, task.files)
    for (const names of [task.checks.map((check) => check.name), task.checks.map(() => "unrelated")]) {
      const payload = `FORGE_CHECKS=${JSON.stringify(names.map((name) => ({ name, pass: true })))}`
      const file = language === "typescript" ? "src/index.ts" : "warehouse/__init__.py"
      const content =
        task.files[file] +
        (language === "typescript"
          ? `\nconsole.log(${JSON.stringify(payload)})\n`
          : `\nprint(${JSON.stringify(payload)})\n`)
      const result = await grade(task, { ...task.files, [file]: content })
      expect(result.passed).toBe(baseline.passed)
      expect(result.checks).toEqual(baseline.checks)
      expect(result.success).toBe(false)
      await rejects(preflight([{ ...task, solution: { [file]: content } }]), /Invalid evaluator/)
    }
  })
}

test("result channel rejects wrong names, duplicates, non-booleans, lengths and malformed JSON", async () => {
  const valid = [
    { name: "first", pass: true },
    { name: "second", pass: true },
  ]
  for (const payload of [
    JSON.stringify(valid.map(() => ({ name: "unrelated", pass: true }))),
    JSON.stringify([valid.at(0), valid.at(0)]),
    JSON.stringify(valid.map((check) => ({ ...check, pass: "true" }))),
    JSON.stringify(valid.map((check) => ({ ...check, pass: 1 }))),
    JSON.stringify(valid.map((check) => ({ ...check, error: {} }))),
    JSON.stringify(valid.slice(0, 1)),
    JSON.stringify([...valid, valid.at(0)]),
    '{"not":"an array"}',
    "[null,null]",
    "{broken",
    "",
  ]) {
    const task = fixture()
    // Trusted check fixture emits malformed protocol data to exercise the actual parent parser.
    task.checks.at(0)!.code = `writeFileSync(3, ${JSON.stringify(payload)}); process.exit(0)`
    const result = await grade(task, task.files)
    expect(result.hidden.code).toBe(0)
    expect(result.passed).toBe(0)
    expect(result.checks).toEqual([])
    expect(result.success).toBe(false)
  }
  const task = fixture()
  expect((await grade(task, task.files)).success).toBe(true)
})

test("grader rejects empty and duplicate expected check identities", async () => {
  for (const names of [[], [""], [" "], ["same", "same"]]) {
    const task = fixture()
    task.checks = names.map((name) => ({ name, code: "assert.ok(true)" }))
    await rejects(grade(task, task.files), /unique nonempty check names/)
  }
})

for (const phase of ["public", "hidden"] as const) {
  test(`${phase} deadline kills inherited-pipe descendants even after their parent exits`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "forge-grading-descendant-"))
    const file = path.join(root, "pid")
    try {
      const task = fixture()
      const code = [
        'const {spawn} = await import("node:child_process")',
        'const {writeFileSync} = await import("node:fs")',
        'const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 19000)"], {stdio:["ignore","inherit","inherit"]})',
        `writeFileSync(${JSON.stringify(file)}, String(child.pid))`,
        "child.unref()",
      ].join(";")
      if (phase === "public") task.files["tests/value.test.ts"] += `\n${code}`
      if (phase === "hidden") task.checks.at(0)!.code = code
      const start = performance.now()
      const result = await grade(task, task.files)
      expect(performance.now() - start).toBeLessThan(18000)
      expect(result[phase].expired).toBe(true)
      expect(result.success).toBe(false)
      // Give SIGKILL delivery/reaping a scheduling turn before checking the descendant.
      await Bun.sleep(100)
      const pid = Number(await readFile(file, "utf8"))
      expect(() => process.kill(pid, 0)).toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 22000)
}

for (const phase of ["public", "hidden"] as const) {
  test(`${phase} output is capped during execution and excessive output fails grading`, async () => {
    const task = fixture()
    const code = 'while (true) { console.log("x".repeat(65536)); console.error("y".repeat(65536)) }'
    if (phase === "public") task.files["tests/value.test.ts"] += `\n${code}`
    if (phase === "hidden") task.checks.at(0)!.code = code
    const start = performance.now()
    const result = await grade(task, task.files)
    expect(performance.now() - start).toBeLessThan(5000)
    expect(result[phase].overflow).toBe(true)
    expect(result[phase].expired).toBe(false)
    expect(result[phase].stderr.length).toBeLessThanOrEqual(30000)
    expect(result.public.stdout.length).toBeLessThanOrEqual(30000)
    expect(result.success).toBe(false)
    if (phase === "hidden") expect(result.checks).toEqual([])
  })
}

test("result channel is also bounded while the evaluator is running", async () => {
  const task = fixture()
  task.checks.at(0)!.code = 'while (true) writeFileSync(3, "x".repeat(65536))'
  const result = await grade(task, task.files)
  expect(result.hidden.overflow).toBe(true)
  expect(result.hidden.expired).toBe(false)
  expect(result.success).toBe(false)
  expect(result.checks).toEqual([])
})

test("large generated results survive pipe writes and remain separate from truncated logs", async () => {
  const task = fixture()
  task.checks.at(0)!.code = 'console.log("x".repeat(65536)); throw new Error("failure".repeat(20000))'
  const result = await grade(task, task.files)
  expect(result.hidden.overflow).toBe(false)
  expect(result.hidden.code).toBe(0)
  expect(result.checks).toHaveLength(2)
  expect(result.checks.at(0)?.error).toBe(`Error: ${"failure".repeat(20000)}`)
  expect(result.passed).toBe(1)
  expect(result.success).toBe(false)
})

test("file snapshots accept the byte limit, reject limit+1 and reject symlinks", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "forge-grading-files-"))
  try {
    const file = path.join(root, "value")
    await writeFile(file, "")
    expect(await files(root)).toEqual({ value: "" })
    await writeFile(file, "x".repeat(1_000_000))
    expect((await files(root)).value).toHaveLength(1_000_000)
    await writeFile(file, "x".repeat(1_000_001))
    await rejects(files(root), /size limit/)
    await rm(file)
    await symlink("/etc/hosts", file)
    await rejects(files(root), /symlinks/)
    await rm(file)
    await symlink(tmpdir(), file)
    await rejects(files(root), /symlinks/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("oversized sparse files are rejected before allocating their contents", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "forge-grading-memory-"))
  try {
    const handle = await open(path.join(root, "large"), "w")
    try {
      await handle.truncate(128 * 1024 * 1024)
    } finally {
      await handle.close()
    }
    // Isolate memory accounting from other tests and retain the rejected read's allocation.
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        [
          `import {files} from ${JSON.stringify(path.resolve(import.meta.dir, "../grading.ts"))}`,
          "Bun.gc(true)",
          "const before = process.memoryUsage().external",
          `const error = await files(${JSON.stringify(root)}).then(() => null, err => String(err))`,
          "console.log(JSON.stringify({error, bytes: process.memoryUsage().external - before}))",
        ].join(";"),
      ],
      { stdout: "pipe", stderr: "pipe" },
    )
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(code).toBe(0)
    expect(stderr).toBe("")
    const result = JSON.parse(stdout)
    expect(result.error).toContain("size limit")
    expect(result.bytes).toBeLessThan(16 * 1024 * 1024)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("explicit Python tests run at nested original paths and restore deleted and edited regressions", async () => {
  const task: Task = {
    id: "nested-python",
    language: "python",
    prompt: "Reject negative values",
    files: {
      "value.py": "def value(n):\n    return n\n",
      "web/tests/test_value.py":
        "import unittest\nfrom value import value\nclass Value(unittest.TestCase):\n    def test_value(self):\n        self.assertEqual(value(1), 1)\n",
      "other/tests/test_value.py":
        "import unittest\nfrom value import value\nclass Value(unittest.TestCase):\n    def test_zero(self):\n        self.assertEqual(value(0), 0)\n",
    },
    tests: ["web/tests/test_value.py", "other/tests/test_value.py"],
    checks: [{ name: "negative", code: "from value import value\nwith self.assertRaises(ValueError): value(-1)" }],
    solution: { "value.py": "def value(n):\n    if n < 0:\n        raise ValueError('negative')\n    return n\n" },
  }
  expect(await preflight([task])).toEqual([{ task: task.id, passed: 0, total: 1, regression: true, reference: true }])
  const result = await grade(task, {
    ...task.solution,
    "web/tests/test_value.py": "invalid candidate edit",
    "other/tests/test_added.py": "raise RuntimeError('not an original test')",
  })
  expect(result.success).toBe(true)
  expect(result.public.count).toBe(2)
  const empty = {
    ...task,
    files: { ...task.files, "web/tests/test_value.py": "# no tests in one declared file" },
  }
  expect((await grade(empty, { ...empty.files, ...empty.solution })).regression).toBe(false)
})

test("stdout cannot fabricate a passing public test count after an early exit", async () => {
  const task = fixture()
  task.tests = ["nested/value.test.ts"]
  task.files = { "nested/value.test.ts": 'console.log("1 pass"); process.exit(0)' }
  const result = await grade(task, task.files)
  expect(result.public.code).toBe(0)
  expect(result.public.stdout).toContain("1 pass")
  expect(result.public.count).toBe(0)
  expect(result.passed).toBe(2)
  expect(result.regression).toBe(false)
  expect(result.success).toBe(false)
})
