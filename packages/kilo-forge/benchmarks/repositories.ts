import { spawnSync } from "node:child_process"
import { realpath } from "node:fs/promises"
import path from "node:path"
import { hash } from "../src/util"
import { preflight, publicTests } from "./grading"
import { tasks as synthetic, type Task } from "./tasks"

const cap = 50
const bytes = 1_000_000

// Deliberately narrow: these are source subsets, not runnable full-repository checkouts.
export function selection(file: string) {
  const parts = file.split("/")
  const name = parts.at(-1)!
  if (
    file.length > 240 ||
    parts.some(
      (part) => !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(part) || /^(?:node_modules|__pycache__|vendor)$/i.test(part),
    ) ||
    !/\.(?:[cm]?[jt]sx?|py|sql|md|txt|json)$/i.test(name) ||
    /^(?:agents|claude|gemini)\.md$/i.test(name) ||
    /^(?:(?:package|package-lock|tsconfig(?:\..*)?|jsconfig|opencode|kilo|kilocode)\.json|(?:sitecustomize|usercustomize|conftest)\.py)$/i.test(
      name,
    ) ||
    /(?:^|[.-])config[.-]/i.test(name)
  )
    throw new Error(`Unsafe repository selection: ${file}`)
  return file
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value == null || typeof value !== "object" || Array.isArray(value)) throw new Error(`Expected ${label} object`)
  return Object.fromEntries(Object.entries(value))
}

function fields(value: Record<string, unknown>, allowed: string[]) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`Unknown manifest field: ${key}`)
}

function text(value: unknown, label: string, limit = 100_000) {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > limit || value.includes("\0"))
    throw new Error(`Invalid ${label}`)
  return value
}

function list(value: unknown, label: string, limit: number) {
  if (!Array.isArray(value) || !value.length || value.length > limit) throw new Error(`Expected 1-${limit} ${label}`)
  return value as unknown[]
}

function unique(values: string[], label: string) {
  if (new Set(values.map((value) => value.toLowerCase())).size !== values.length) throw new Error(`Duplicate ${label}`)
  return values
}

function git(repository: string, args: string[]) {
  const result = spawnSync("git", ["--no-replace-objects", "--literal-pathspecs", "-C", repository, ...args], {
    env: {
      PATH: process.env.PATH,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_NO_LAZY_FETCH: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_ALLOW_PROTOCOL: "",
    },
    maxBuffer: bytes + 1024,
    timeout: 5000,
  })
  if (result.error || result.status !== 0)
    throw new Error(
      `Local Git object access failed (${args.at(0)}): ${result.error?.message ?? result.stderr.toString().slice(0, 1000)}`,
    )
  return result.stdout
}

function utf8(data: Uint8Array, label: string) {
  if (data.byteLength > bytes) throw new Error(`${label} exceeds file size limit`)
  const value = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data)
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw new Error(`Non-text ${label}`)
  return value
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value != null && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`
  return JSON.stringify(value)
}

export function dataset(tasks: Task[]) {
  const pinned = tasks.every((task) => task.provenance != null)
  if (!pinned && tasks.some((task) => task.provenance != null)) throw new Error("Mixed dataset kinds")
  return {
    kind: pinned ? ("repository-subsets" as const) : ("synthetic" as const),
    hash: hash(canonical(tasks)),
    tasks: tasks.map((task) => ({
      id: task.id,
      language: task.language,
      relevant: task.relevant,
      constraints: task.constraints,
      ...(task.provenance ?? {
        scope: "synthetic-template" as const,
        files: Object.keys(task.files).sort(),
        snapshot: hash(canonical(task.files)),
        definition: hash(canonical(task)),
      }),
    })),
  }
}

/** Read trusted local inputs only. Preflight executes their code; it is not an OS sandbox. */
export async function load(manifest?: string) {
  if (manifest == null) return { tasks: synthetic, dataset: dataset(synthetic) }
  const source = Bun.file(manifest)
  if ((await source.stat()).size > 5 * bytes) throw new Error("Manifest exceeds size limit")
  const input = object(await source.json(), "manifest")
  fields(input, ["version", "tasks"])
  if (input.version !== 1) throw new Error("Expected manifest version 1")
  const entries = list(input.tasks, "tasks", cap).map((entry) => object(entry, "task"))
  unique(
    entries.map((entry) => text(entry.id, "task id", 80)),
    "task ids",
  )
  const tasks: Task[] = []
  let total = 0
  for (const entry of entries) {
    fields(entry, [
      "id",
      "repository",
      "revision",
      "files",
      "tests",
      "language",
      "prompt",
      "checks",
      "solution",
      "relevant",
      "constraints",
    ])
    const id = text(entry.id, "task id", 80)
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id)) throw new Error(`Unsafe task id: ${id}`)
    const location = text(entry.repository, "repository")
    if (!path.isAbsolute(location)) throw new Error("Repository must be an absolute local path")
    const repository = await realpath(location)
    if (git(repository, ["rev-parse", "--show-prefix"]).toString().trim())
      throw new Error("Repository path must identify the Git repository root")
    const revision = text(entry.revision, "revision").toLowerCase()
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision))
      throw new Error("Revision must be an immutable full commit hash")
    if (git(repository, ["cat-file", "-t", revision]).toString().trim() !== "commit")
      throw new Error("Revision must identify a commit object")
    const language = entry.language
    if (language !== "typescript" && language !== "python") throw new Error("Unsupported task language")
    const prompt = text(entry.prompt, "prompt")
    const selected = unique(
      list(entry.files, "selected files", 200).map((file) => selection(text(file, "selected file", 240))),
      "selected files",
    ).sort()
    const names = new Set(selected)
    const folded = new Map<string, string>()
    for (const file of selected) {
      const parts = file.split("/")
      for (let length = 1; length <= parts.length; length++) {
        const prefix = parts.slice(0, length).join("/")
        const previous = folded.get(prefix.toLowerCase())
        if (previous != null && previous !== prefix) throw new Error("Case-colliding selected paths")
        folded.set(prefix.toLowerCase(), prefix)
        if (length < parts.length && names.has(prefix)) throw new Error("Conflicting selected paths")
      }
    }
    const files: Record<string, string> = {}
    let size = 0
    for (const file of selected) {
      const tree = git(repository, ["ls-tree", "-z", revision, "--", file]).toString("utf8")
      const match = /^(100644|100755) blob ([a-f0-9]{40}|[a-f0-9]{64})\t([^\0]+)\0$/.exec(tree)
      if (!match || match[3] !== file) throw new Error(`Selection must be a regular committed file: ${file}`)
      const oid = match[2]!
      const length = Number(git(repository, ["cat-file", "-s", oid]).toString())
      if (!Number.isSafeInteger(length) || length < 0 || length > bytes)
        throw new Error(`Selection exceeds file size limit: ${file}`)
      size += length
      total += length
      if (size > 5 * bytes || total > 50 * bytes) throw new Error("Repository snapshots exceed size limit")
      files[file] = utf8(git(repository, ["cat-file", "blob", oid]), file)
    }
    const tests =
      entry.tests === undefined
        ? undefined
        : publicTests({
            id,
            language,
            files,
            tests: unique(
              list(entry.tests, "public tests", 200).map((file) => selection(text(file, "public test", 240))),
              "public tests",
            ),
          })
    const checks = list(entry.checks, "checks", 100).map((value) => {
      const check = object(value, "check")
      fields(check, ["name", "code"])
      return { name: text(check.name, "check name", 200), code: text(check.code, "check code") }
    })
    unique(
      checks.map((check) => check.name),
      "check names",
    )
    const solution = Object.fromEntries(
      Object.entries(object(entry.solution, "solution"))
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([file, value]) => {
          selection(file)
          if (!names.has(file) || file.startsWith("tests/") || tests?.includes(file))
            throw new Error(`Reference path must be selected non-test source: ${file}`)
          if (typeof value !== "string") throw new Error(`Invalid reference text: ${file}`)
          return [file, utf8(new TextEncoder().encode(value), `reference ${file}`)]
        }),
    )
    if (!Object.keys(solution).length) throw new Error("Expected reference solution overrides")
    const relevant =
      entry.relevant == null
        ? undefined
        : unique(
            list(entry.relevant, "relevant paths", 200).map((value) => {
              const file = text(value, "relevant path", 240)
              if (!names.has(file)) throw new Error(`Relevant path is not selected: ${file}`)
              return file
            }),
            "relevant paths",
          ).sort()
    const constraints =
      entry.constraints == null
        ? undefined
        : list(entry.constraints, "intent constraints", 100).map((value) => text(value, "intent constraint"))
    const task: Task = {
      id,
      language,
      prompt,
      files,
      checks,
      solution,
      relevant,
      constraints,
      ...(tests === undefined ? {} : { tests }),
    }
    task.provenance = {
      repository,
      revision,
      files: selected,
      scope: "selected-files",
      snapshot: hash(canonical(files)),
      definition: hash(canonical(task)),
    }
    tasks.push(task)
  }
  return { tasks, dataset: dataset(tasks) }
}

if (import.meta.main) {
  const manifest = process.argv.at(2) ?? process.env.FORGE_EVAL_MANIFEST
  const loaded = await load(manifest)
  const baseline = await preflight(loaded.tasks)
  console.log(JSON.stringify({ dataset: loaded.dataset, baseline }, null, 2))
}
