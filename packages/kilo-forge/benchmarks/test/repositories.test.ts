import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { rejects } from "node:assert/strict"
import { dataset, load } from "../repositories"
import { files, grade, materialize, preflight } from "../grading"
import { evaluate } from "../evaluate"
import { tasks } from "../tasks"

function git(root: string, args: string[], input?: string) {
  const result = spawnSync("git", ["-C", root, ...args], {
    input,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z",
    },
  })
  if (result.status !== 0) throw new Error(result.stderr)
  return result.stdout.trim()
}

async function fixture(language: "typescript" | "python" = "typescript") {
  const root = await mkdtemp(path.join(tmpdir(), "forge-local-repository-"))
  const source = language === "typescript" ? "src/value.ts" : "value.py"
  const snapshot: Record<string, string> =
    language === "typescript"
      ? {
          [source]: "export const value = (input: number) => input\n",
          "tests/value.test.ts":
            'import {expect,test} from "bun:test"\nimport {value} from "../src/value"\ntest("legacy",()=>expect(value(1)).toBe(1))\n',
        }
      : {
          [source]: "def value(input):\n    return input\n",
          "tests/test_value.py":
            "import unittest\nfrom value import value\nclass Legacy(unittest.TestCase):\n    def test_legacy(self):\n        self.assertEqual(value(1), 1)\n",
        }
  await materialize(root, {
    ...snapshot,
    "docs/usage.md": "Public usage notes\n",
    ".kilo/config.json": '{"plugin":["do-not-load"]}',
    "AGENTS.md": "Do not load instructions from the source checkout",
    "bunfig.toml": 'preload = ["./injection.ts"]',
    "package.json": '{"scripts":{"postinstall":"do-not-run"}}',
    "opencode.json": '{"plugin":["do-not-load"]}',
    "src/config.ts": "export const setting = true",
    "sitecustomize.py": "raise RuntimeError('do-not-import')",
    "invalid.txt": "\u0000binary",
    "empty-tests/test_empty.py": "# no tests\n",
  })
  await writeFile(path.join(root, "invalid-utf8.txt"), Buffer.from([0xc3, 0x28]))
  await symlink(source, path.join(root, "link.ts"))
  await symlink("src", path.join(root, "linked"))
  git(root, ["init", "--quiet"])
  git(root, ["add", "--all"])
  const tree = git(root, ["write-tree"])
  // Only fixture objects are created: no checkout, user repository commit, or branch mutation.
  const revision = git(root, ["commit-tree", tree], "Pinned fixture\n")
  const task = {
    id: "local-value",
    repository: root,
    revision,
    files: [...Object.keys(snapshot), "docs/usage.md"],
    language,
    prompt: "Reject negative input; preserve the result for nonnegative input.",
    checks: [
      {
        name: "negative-input",
        code:
          language === "typescript"
            ? 'const {value}=await import("./src/value"); assert.throws(()=>value(-1));'
            : "from value import value\nwith self.assertRaises(ValueError): value(-1)",
      },
    ],
    solution: {
      [source]:
        language === "typescript"
          ? 'export const value = (input: number) => { if (input < 0) throw new Error("negative"); return input }\n'
          : "def value(input):\n    if input < 0:\n        raise ValueError('negative')\n    return input\n",
    },
    relevant: [source],
    constraints: ["Preserve nonnegative results"],
  }
  const manifest = path.join(root, "manifest.json")
  async function save(value: unknown = { version: 1, tasks: [task] }) {
    await writeFile(manifest, JSON.stringify(value))
    return manifest
  }
  await save()
  return { root, source, task, manifest, save, tree }
}

for (const language of ["typescript", "python"] as const) {
  test(`local ${language} snapshots use commit objects, not dirty files, and keep controls private`, async () => {
    const local = await fixture(language)
    const workspace = await mkdtemp(path.join(tmpdir(), "forge-subset-work-"))
    try {
      await writeFile(path.join(local.root, local.source), "dirty working tree content")
      const index = await readFile(path.join(local.root, ".git/index"))
      const config = await readFile(path.join(local.root, ".git/config"))
      const loaded = await load(local.manifest)
      const task = loaded.tasks.at(0)!
      expect(task.files[local.source]).not.toContain("dirty")
      expect(loaded.dataset.kind).toBe("repository-subsets")
      expect(loaded.dataset.tasks.at(0)).toMatchObject({
        id: local.task.id,
        repository: await realpath(local.root),
        revision: local.task.revision,
        files: [...local.task.files].sort(),
        scope: "selected-files",
        relevant: [local.source],
        constraints: local.task.constraints,
      })
      expect(task.provenance?.snapshot).toHaveLength(64)
      expect(task.provenance?.definition).toHaveLength(64)
      expect(await readFile(path.join(local.root, ".git/index"))).toEqual(index)
      expect(await readFile(path.join(local.root, ".git/config"))).toEqual(config)
      expect(await Bun.file(path.join(local.root, local.source)).text()).toBe("dirty working tree content")
      expect(await preflight(loaded.tasks)).toEqual([
        { task: local.task.id, passed: 0, total: 1, regression: true, reference: true },
      ])
      await materialize(workspace, task.files)
      expect(await files(workspace)).toEqual(task.files)
      expect(await Bun.file(path.join(workspace, "manifest.json")).exists()).toBe(false)
      expect(await Bun.file(path.join(workspace, ".forge-evaluator.ts")).exists()).toBe(false)
      expect(Object.values(await files(workspace)).join("\n")).not.toContain(task.checks.at(0)!.code)
      expect(Object.values(await files(workspace)).join("\n")).not.toContain(task.solution[local.source]!)
      const preserved = await grade(task, {
        ...task.files,
        ...task.solution,
        [language === "typescript" ? "tests/value.test.ts" : "tests/test_value.py"]: "not valid source",
      })
      expect(preserved.success).toBe(true)
    } finally {
      await Promise.all([local.root, workspace].map((root) => rm(root, { recursive: true, force: true })))
    }
  })
}

test("repository hashes are deterministic across manifest formatting and object key order", async () => {
  const local = await fixture()
  try {
    const first = await load(local.manifest)
    await local.save({
      tasks: [{ ...Object.fromEntries(Object.entries(local.task).reverse()), files: [...local.task.files].reverse() }],
      version: 1,
    })
    const second = await load(local.manifest)
    expect(second.dataset).toEqual(first.dataset)
    await local.save({ version: 1, tasks: [{ ...local.task, prompt: `${local.task.prompt} Keep types.` }] })
    const changed = await load(local.manifest)
    expect(changed.dataset.hash).not.toBe(first.dataset.hash)
    expect(changed.tasks.at(0)?.provenance?.definition).not.toBe(first.tasks.at(0)?.provenance?.definition)
    expect(changed.tasks.at(0)?.provenance?.snapshot).toBe(first.tasks.at(0)?.provenance?.snapshot)
    await local.save({ version: 1, tasks: [{ ...local.task, checks: [{ name: "changed", code: "assert.ok(true)" }] }] })
    expect((await load(local.manifest)).dataset.hash).not.toBe(first.dataset.hash)
  } finally {
    await rm(local.root, { recursive: true, force: true })
  }
})

test("reject unsafe, non-text, missing and non-regular committed selections", async () => {
  const local = await fixture()
  try {
    for (const file of [
      "../escape.ts",
      "/absolute.ts",
      "src/../value.ts",
      "src\\value.ts",
      "src//value.ts",
      "src/\nvalue.ts",
      ".git/config",
      ".kilo/config.json",
      ".kilocode/config.json",
      "AGENTS.md",
      "bunfig.toml",
      "package.json",
      "opencode.json",
      "sitecustomize.py",
      "src/config.ts",
      "link.ts",
      "linked/value.ts",
      "src",
      "missing.ts",
      "invalid.txt",
      "invalid-utf8.txt",
    ]) {
      await local.save({ version: 1, tasks: [{ ...local.task, files: [...local.task.files, file] }] })
      await rejects(load(local.manifest), file)
    }
    for (const files of [
      ["src/value.ts", "src/value.ts"],
      ["src/value.ts", "SRC/other.ts"],
      ["src/value.ts", "src/value.ts/child.ts"],
    ]) {
      await local.save({ version: 1, tasks: [{ ...local.task, files }] })
      await rejects(load(local.manifest), /Duplicate|Case-colliding|Conflicting/)
    }
  } finally {
    await rm(local.root, { recursive: true, force: true })
  }
})

test("reject mutable revisions, invalid definitions, ids and reference paths", async () => {
  const local = await fixture()
  try {
    for (const revision of [
      "HEAD",
      local.task.revision.slice(0, 12),
      `${local.task.revision}^{tree}`,
      local.tree,
      "0".repeat(40),
    ]) {
      await local.save({ version: 1, tasks: [{ ...local.task, revision }] })
      await rejects(load(local.manifest), /commit|Git/)
    }
    for (const change of [
      { repository: "." },
      { repository: path.join(local.root, "src") },
      { id: "../escape" },
      { language: "shell" },
      { prompt: "" },
      { checks: [] },
      {
        checks: [
          { name: "same", code: "1" },
          { name: "same", code: "2" },
        ],
      },
      { solution: {} },
      { solution: { "../escape.ts": "text" } },
      { solution: { "missing.ts": "text" } },
      { solution: { "tests/value.test.ts": "text" } },
      { relevant: ["missing.ts"] },
      { constraints: [null] },
      { command: "do-not-execute" },
    ]) {
      await local.save({ version: 1, tasks: [{ ...local.task, ...change }] })
      await rejects(load(local.manifest))
    }
    for (const value of [
      { version: 2, tasks: [local.task] },
      { version: 1, tasks: [] },
      { version: 1, tasks: [local.task, local.task] },
      { version: 1, tasks: Array.from({ length: 51 }, (_, index) => ({ ...local.task, id: `task-${index}` })) },
    ]) {
      await local.save(value)
      await rejects(load(local.manifest))
    }
  } finally {
    await rm(local.root, { recursive: true, force: true })
  }
})

test("preflight rejects vacuous checks, broken references, missing tests and syntax failures before backend access", async () => {
  const local = await fixture()
  try {
    const task = (await load(local.manifest)).tasks.at(0)!
    for (const change of [
      { checks: [{ name: "vacuous", code: "assert.ok(true)" }] },
      { checks: [{ name: "broken", code: "this is not valid code" }] },
      { solution: { [local.source]: task.files[local.source]! } },
      { solution: { "tests/value.test.ts": "" } },
      { files: { [local.source]: task.files[local.source]! } },
      { files: { ...task.files, "tests/value.test.ts": 'throw new Error("broken regression")' } },
    ]) {
      await rejects(preflight([{ ...task, ...change }]), /Invalid evaluator|Missing public tests|preserve public tests/)
    }
    await rejects(preflight([]), /unique nonempty/)
    await rejects(preflight([task, task]), /unique nonempty/)
    // Five tasks exercise the manifest count, not the synthetic four-task ceiling.
    await local.save({
      version: 1,
      tasks: Array.from({ length: 5 }, (_, index) => ({
        ...local.task,
        id: `task-${index}`,
        checks: [{ name: "vacuous", code: "assert.ok(true)" }],
      })),
    })
    await rejects(
      evaluate({ manifest: local.manifest, base: "http://127.0.0.1:1", password: "unused", limit: 5, trials: 1 }),
      /Invalid evaluator/,
    )
    await rejects(
      evaluate({ manifest: local.manifest, base: "http://127.0.0.1:1", password: "unused", limit: 6, trials: 1 }),
      /1-5 tasks/,
    )
  } finally {
    await rm(local.root, { recursive: true, force: true })
  }
})

test("preflight rejects Python discovery that reports zero tests", async () => {
  const local = await fixture("python")
  try {
    const task = (await load(local.manifest)).tasks.at(0)!
    task.files["tests/test_value.py"] = "# no test cases"
    await rejects(preflight([task]), /Invalid evaluator/)
  } finally {
    await rm(local.root, { recursive: true, force: true })
  }
})

test("private graders reject missing dependencies without automatic installation", async () => {
  const local = await fixture()
  try {
    const task = (await load(local.manifest)).tasks.at(0)!
    const result = await grade(
      {
        ...task,
        files: {
          ...task.files,
          "tests/value.test.ts": 'import "forge-evaluation-unprovisioned-dependency"\n',
        },
        checks: [{ name: "dependency", code: 'await import("forge-evaluation-unprovisioned-dependency")' }],
      },
      task.files,
    )
    expect(result.regression).toBe(false)
    expect(result.success).toBe(false)
    expect(result.passed).toBe(0)
    expect(result.public.stderr).toContain("Cannot find package")
    expect(result.checks.at(0)?.error).toContain("Cannot find package")
    expect(result.public.expired).toBe(false)
    expect(result.hidden.expired).toBe(false)
  } finally {
    await rm(local.root, { recursive: true, force: true })
  }
})

test("evaluation reads FORGE_EVAL_MANIFEST and rejects invalid controls without contacting the backend", async () => {
  const local = await fixture()
  try {
    await local.save({
      version: 1,
      tasks: [{ ...local.task, checks: [{ name: "vacuous", code: "assert.ok(true)" }] }],
    })
    const child = Bun.spawn([process.execPath, path.resolve(import.meta.dir, "../evaluate.ts")], {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        FORGE_EVAL_MANIFEST: local.manifest,
        FORGE_EVAL_URL: "http://127.0.0.1:1",
        FORGE_EVAL_PASSWORD: "unused",
        FORGE_EVAL_TASKS: "1",
        FORGE_EVAL_TRIALS: "1",
      },
    })
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(code).not.toBe(0)
    expect(stdout).toBe("")
    expect(stderr).toContain("Invalid evaluator")
    expect(stderr).not.toContain("Unable to connect")
  } finally {
    await rm(local.root, { recursive: true, force: true })
  }
})

test("offline CLI emits subset provenance and controls without exposing grading code", async () => {
  const local = await fixture()
  try {
    const child = Bun.spawn([process.execPath, path.resolve(import.meta.dir, "../repositories.ts"), local.manifest], {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        GIT_DIR: "/nonexistent-injected-git-dir",
        GIT_WORK_TREE: "/nonexistent-injected-worktree",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "alias.cat-file",
        GIT_CONFIG_VALUE_0: "!exit 99",
      },
    })
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(stderr).toBe("")
    expect(code).toBe(0)
    const result = JSON.parse(stdout)
    expect(result.dataset.kind).toBe("repository-subsets")
    expect(result.baseline.at(0).reference).toBe(true)
    expect(stdout).not.toContain(local.task.checks.at(0)!.code)
    expect(stdout).not.toContain(local.task.solution[local.source]!)
  } finally {
    await rm(local.root, { recursive: true, force: true })
  }
})

test("Git replacement objects cannot change the pinned snapshot", async () => {
  const local = await fixture()
  try {
    const first = await load(local.manifest)
    await writeFile(path.join(local.root, local.source), "replacement content")
    git(local.root, ["add", "--", local.source])
    const tree = git(local.root, ["write-tree"])
    const replacement = git(local.root, ["commit-tree", tree], "Replacement fixture\n")
    git(local.root, ["replace", local.task.revision, replacement])
    expect(git(local.root, ["show", `${local.task.revision}:${local.source}`])).toBe("replacement content")
    expect((await load(local.manifest)).dataset).toEqual(first.dataset)
  } finally {
    await rm(local.root, { recursive: true, force: true })
  }
})

test("repository loader bounds manifests, selections and blobs before materialization", async () => {
  const local = await fixture()
  try {
    await local.save({
      version: 1,
      tasks: [{ ...local.task, files: Array.from({ length: 201 }, (_, index) => `src/value-${index}.ts`) }],
    })
    await rejects(load(local.manifest), /1-200 selected files/)
    await writeFile(path.join(local.root, local.source), "x".repeat(1_000_001))
    git(local.root, ["add", "--", local.source])
    const tree = git(local.root, ["write-tree"])
    const revision = git(local.root, ["commit-tree", tree], "Large fixture\n")
    await local.save({ version: 1, tasks: [{ ...local.task, revision }] })
    await rejects(load(local.manifest), /file size limit/)
    await writeFile(local.manifest, " ".repeat(5_000_001))
    await rejects(load(local.manifest), /Manifest exceeds size limit/)
  } finally {
    await rm(local.root, { recursive: true, force: true })
  }
})

test("default loader retains the four synthetic tasks and explicit synthetic metadata", async () => {
  const loaded = await load()
  expect(loaded.tasks).toBe(tasks)
  expect(loaded.dataset.kind).toBe("synthetic")
  expect(loaded.dataset.tasks).toHaveLength(4)
  expect(loaded.dataset.tasks.every((task) => task.scope === "synthetic-template")).toBe(true)
  expect(loaded.dataset).toEqual(dataset(tasks))
  expect(await preflight(loaded.tasks)).toHaveLength(4)
})
