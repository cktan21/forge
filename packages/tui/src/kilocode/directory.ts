import { access, readdir, realpath, stat } from "node:fs/promises"
import { constants } from "node:fs"
import path from "node:path"
import fuzzysort from "fuzzysort"

export function isCd(text: string) {
  return /^\/cd(?:[ \t]|$)/.test(text)
}

export function argument(text: string, partial = false) {
  let quote = ""
  let value = ""
  let ended = false
  const chars = Array.from(text.trimStart())
  for (let index = 0; index < chars.length; index++) {
    const char = chars.at(index)!
    if (!quote && /\s/.test(char)) {
      ended = true
      continue
    }
    if (ended) throw new Error("Use quotes or backslashes for a directory containing spaces.")
    if (char === "\\" && quote !== "'" && /[\s"'\\]/.test(chars.at(index + 1) ?? "")) {
      value += chars.at(++index)
      continue
    }
    if (char === quote) {
      quote = ""
      continue
    }
    if (!quote && (char === "'" || char === '"')) {
      quote = char
      continue
    }
    value += char
  }
  if (quote && !partial) throw new Error("Close the directory path's quote before switching projects.")
  return value
}

function expand(value: string, home: string) {
  if (value === "~") return home
  if (value.startsWith("~/") || value.startsWith("~\\")) return path.join(home, value.slice(2))
  return value
}

export function quote(value: string) {
  return /[\s"'\\]/.test(value) ? `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : value
}

export async function resolve(text: string, cwd: string, home: string) {
  const value = argument(text)
  const target = path.resolve(cwd, expand(value || home, home))
  const dir = await realpath(target)
  if (!(await stat(dir)).isDirectory()) throw new Error(`Not a directory: ${target}`)
  await access(dir, constants.R_OK | constants.X_OK)
  return dir
}

export async function complete(text: string, cwd: string, home: string) {
  const value = argument(text, true)
  if (value === "~") return [{ name: "~/", value: "~/", description: home }]
  const index = Math.max(value.lastIndexOf("/"), path.sep === "\\" ? value.lastIndexOf("\\") : -1)
  const prefix = value.slice(0, index + 1)
  const fragment = value.slice(index + 1)
  const dir = path.resolve(cwd, expand(prefix || ".", home))
  const entries = await readdir(dir, { withFileTypes: true })
  const candidates = entries.filter((entry) => !entry.name.startsWith(".") || fragment.startsWith("."))
  const ranked = fragment
    ? fuzzysort.go(fragment, candidates, { key: "name" }).map((entry) => entry.obj)
    : candidates.sort((a, b) => a.name.localeCompare(b.name))
  const result: { name: string; value: string; description: string }[] = []
  for (const entry of ranked) {
    const target = path.join(dir, entry.name)
    if (
      !entry.isDirectory() &&
      !(
        entry.isSymbolicLink() &&
        (await stat(target).then(
          (info) => info.isDirectory(),
          () => false,
        ))
      )
    )
      continue
    result.push({ name: entry.name + path.sep, value: quote(prefix + entry.name + path.sep), description: target })
    if (result.length === 50) break
  }
  return result
}
