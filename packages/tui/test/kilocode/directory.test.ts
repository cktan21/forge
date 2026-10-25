import { expect, test } from "bun:test"
import { mkdir, symlink } from "node:fs/promises"
import path from "node:path"
import { argument, complete, isCd, quote, resolve } from "../../src/kilocode/directory"
import { tmpdir } from "../fixture/fixture"

test("parse directory arguments without evaluating shell syntax", () => {
  expect(argument('"folder with spaces"')).toBe("folder with spaces")
  expect(argument("folder\\ with\\ spaces")).toBe("folder with spaces")
  expect(argument("'folder with spaces'")).toBe("folder with spaces")
  expect(argument("$(touch_pwned)")).toBe("$(touch_pwned)")
  expect(() => argument("one two")).toThrow("quotes")
  expect(() => argument('"unfinished')).toThrow("Close")
  expect(argument('"unfinished', true)).toBe("unfinished")
  for (const value of ["space name", 'quote"name', "single'name", "日本語", "back\\slash"])
    expect(argument(quote(value))).toBe(value)
  expect(isCd("/cd")).toBe(true)
  expect(isCd("/cd ../another")).toBe(true)
  expect(isCd("/cdir")).toBe(false)
  expect(isCd("tell me to /cd")).toBe(false)
})

test("resolve relative, home, parent, spaced and symlink directories; reject files and missing paths", async () => {
  await using root = await tmpdir()
  const child = path.join(root.path, "space project")
  await mkdir(child)
  await symlink(child, path.join(root.path, "linked"))
  await Bun.write(path.join(root.path, "file.txt"), "not a directory")
  expect(await resolve('"space project"', root.path, root.path)).toBe(child)
  expect(await resolve("..", child, root.path)).toBe(root.path)
  expect(await resolve("~", child, root.path)).toBe(root.path)
  expect(await resolve("", child, root.path)).toBe(root.path)
  expect(await resolve("linked", root.path, root.path)).toBe(child)
  const missing = await resolve("missing", root.path, root.path).catch((err: unknown) => err)
  const file = await resolve("file.txt", root.path, root.path).catch((err: unknown) => err)
  expect(missing).toBeInstanceOf(Error)
  expect(file).toBeInstanceOf(Error)
  expect(file instanceof Error ? file.message : "").toContain("Not a directory")
})

test("complete only directories with fuzzy matching, hidden-path opt-in, quoting and nested navigation", async () => {
  await using root = await tmpdir()
  for (const dir of ["alpha", "space project", ".hidden", "日本語"]) await mkdir(path.join(root.path, dir))
  await mkdir(path.join(root.path, "space project", "nested"))
  await symlink(path.join(root.path, "alpha"), path.join(root.path, "linked"))
  await symlink(path.join(root.path, "absent"), path.join(root.path, "broken"))
  await Bun.write(path.join(root.path, "alpha.txt"), "")
  const all = await complete("", root.path, root.path)
  expect(all.map((item) => item.name).sort()).toEqual(["alpha/", "linked/", "space project/", "日本語/"].sort())
  expect((await complete("sprj", root.path, root.path)).at(0)?.value).toBe('"space project/"')
  expect((await complete('"space project/ne', root.path, root.path)).at(0)?.value).toBe('"space project/nested/"')
  expect((await complete(".", root.path, root.path)).map((item) => item.name)).toEqual([".hidden/"])
  expect((await complete("~/al", root.path, root.path)).at(0)?.value).toBe("~/alpha/")
})
