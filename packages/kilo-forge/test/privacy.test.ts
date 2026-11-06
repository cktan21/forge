import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { engine } from "../src/engine"
import { source } from "../src/parse"
import { store } from "../src/store"
import { redact } from "../src/util"

test("redacts complete Bearer and Basic authorization values", () => {
  for (const scheme of ["Bearer", "Basic", "bEaReR", "bAsIc"]) {
    for (const credential of ["TOKEN", "dXNlcjpwYXNzL3dvcmQ+==", "a.b_c-123/~+=", "x"]) {
      for (const [prefix, suffix] of [
        ["Authorization: ", ""],
        ['{"Authorization": "', '", "safe": "keep"}'],
        ["'authorization' = '", "'; safe=keep"],
        ["PROXY-AUTHORIZATION:\t", "\r\nContent-Type: text/plain"],
      ]) {
        const input = `${prefix}${scheme}\t${credential}${suffix}`
        const expected = `${prefix}[REDACTED]${suffix}`
        expect(redact(input)).toBe(expected)
        expect(redact(redact(input))).toBe(expected)
        expect(source("headers.txt", input, "configuration").text).toBe(expected)
      }
    }
  }
})

test("redacts multiple authorization lines without swallowing adjacent content", () => {
  expect(redact("Authorization: Bearer bearer-canary\r\nAuthorization: Basic basic-canary\r\nAccept: application/json"))
    .toBe("Authorization: [REDACTED]\r\nAuthorization: [REDACTED]\r\nAccept: application/json")
  expect(redact("authorization: opaque-canary; password=secret-canary, api_key=private-canary"))
    .toBe("authorization: [REDACTED]; password=[REDACTED], api_key=[REDACTED]")
  expect(redact("https://user:credential@example.test sk-abcdefghijklmnopqrst"))
    .toBe("https://[REDACTED]@example.test [REDACTED]")
})

test("redacts authorization in JSON-serialized tool descriptions", () => {
  const description = 'Authorization: Bearer bearer-canary\r\nAuthorization: Basic basic-canary\nUse "Authorization: Bearer quoted-canary"'
  expect(redact(JSON.stringify({ description }))).toBe(JSON.stringify({
    description: 'Authorization: [REDACTED]\r\nAuthorization: [REDACTED]\nUse "Authorization: [REDACTED]"',
  }))
})

test("redacts escaped tabs and nested serialized credentials without losing useful content", () => {
  for (const separator of ["\t", String.raw`\t`, String.raw`\\t`]) {
    const text = `Authorization:${separator}Bearer${separator}escaped-canary; keep=this\nAccept: application/json`
    const expected = `Authorization:${separator}[REDACTED]; keep=this\nAccept: application/json`
    expect(redact(text)).toBe(expected)
    for (const depth of [1, 2, 3, 4]) {
      const input = Array.from({ length: depth }).reduce((value: string) => JSON.stringify({ description: value, safe: "keep" }), text)
      const output = Array.from({ length: depth }).reduce((value: string) => JSON.stringify({ description: value, safe: "keep" }), expected)
      expect(redact(input)).toBe(output)
      expect(redact(redact(input))).toBe(output)
      expect(source("nested.json", input, "configuration").text).toBe(output)
    }
  }
  const input = JSON.stringify({ headers: { Authorization: "Basic nested-canary" }, safe: ["keep", 42, false] })
  const expected = JSON.stringify({ headers: { Authorization: "[REDACTED]" }, safe: ["keep", 42, false] })
  expect(redact(`Example: ${JSON.stringify(input)}; retain this explanation`))
    .toBe(`Example: ${JSON.stringify(expected)}; retain this explanation`)
  expect(redact(String.raw`{"\u0041uthorization":"Basic unicode\u002dcanary","safe":"keep"}`))
    .toBe('{"Authorization":"[REDACTED]","safe":"keep"}')
  expect(redact('{"unfinished": true,\nAuthorization: Bearer fragment-canary\nKeep this incomplete excerpt'))
    .toBe('{"unfinished": true,\nAuthorization: [REDACTED]\nKeep this incomplete excerpt')
})

test.each(["Bearer", "Basic"])("redacts complete embedded JSON pairs with %s credentials", (scheme) => {
  for (const key of ["Authorization", String.raw`\u0041uthorization`, String.raw`Authoriz\u0061tion`, String.raw`PROXY-\u0041UTHORIZATION`]) {
    for (const credential of [
      "canary",
      String.raw`prefix\u002dcanary`,
      String.raw`\u0063anary`,
      String.raw`prefix\\canary`,
      String.raw`prefix\"canary`,
      String.raw`prefix\tcanary`,
      String.raw`prefix\ncanary`,
      String.raw`prefix\\u00canary`,
      String.raw`prefix\/canary`,
      String.raw`prefix\\`,
    ]) {
      const text = `Example: { "${key}" : "${scheme} ${credential}", "safe" : "keep" }; retain this explanation`
      const safe = `Example: { "${key}" : "[REDACTED]", "safe" : "keep" }; retain this explanation`
      for (const depth of [0, 1, 2, 3]) {
        const input = Array.from({ length: depth }).reduce((value: string) => JSON.stringify(value), text)
        const expected = Array.from({ length: depth }).reduce((value: string) => JSON.stringify(value), safe)
        const prose = `Tool description: ${input}; useful context`
        const output = `Tool description: ${expected}; useful context`
        expect(redact(prose)).toBe(output)
        expect(redact(redact(prose))).toBe(output)
        expect(source("example.txt", prose, "configuration").text).toBe(output)
      }
    }
  }
  expect(redact(String.raw`Example: {"\u0041uthorization":"` + scheme + String.raw`\u0020prefix\u002dcanary","safe":"keep"}`))
    .toBe(String.raw`Example: {"\u0041uthorization":"[REDACTED]","safe":"keep"}`)
  expect(redact(String.raw`Example: {"\u0070assword":"prefix\\canary", "description":"Use the queue"}`))
    .toBe(String.raw`Example: {"\u0070assword":"[REDACTED]", "description":"Use the queue"}`)
})

test("preserves harmless JSON strings and surrounding prose verbatim", () => {
  const text = String.raw`Before "quoted prose": {"safe" : "keep\u0020this", "path":"C:\\workspace", "script":"process.exit(1)"}; after`
  expect(redact(text)).toBe(text)
})

test.each(["Bearer", "Basic"])("failed engine completions persist redacted %s coverage in actual SQLite", async (scheme) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "forge-failure-privacy-")))
  const db = new Database(":memory:")
  const storage = store({
    all: async (query) => db.query<Record<string, unknown>, (string | number | null)[]>(query.text).all(...query.values ?? []),
    batch: async (queries) => { db.transaction(() => { for (const query of queries) db.query(query.text).run(...query.values ?? []) })() },
  })
  const text = `Example: {"\\u0041uthorization":"${scheme} failure-canary","safe":"keep"}\n` +
    `Example: {"Authorization":"${scheme} prefix\\u002dfailure-tail","safe":"keep"}\n` +
    `Example: {"Authorization":"${scheme} prefix\\\\failure-backslash","safe":"keep"}`
  const safe = String.raw`Example: {"\u0041uthorization":"[REDACTED]","safe":"keep"}` + "\n" +
    'Example: {"Authorization":"[REDACTED]","safe":"keep"}\n' +
    'Example: {"Authorization":"[REDACTED]","safe":"keep"}'
  const err = new Error(`Authorization: ${scheme} failure-canary\n${text}\nNested: ${JSON.stringify(text)}\nProvider rejected request; retry later.`)
  const api = engine({ root, store: storage, complete: async () => { throw err } })
  try {
    await writeFile(path.join(root, "README.md"), "A queue service with FIFO assignment.")
    expect(await api.overview().catch((failure: unknown) => failure)).toBe(err)
    const manifests = await storage.manifests(root)
    expect(manifests).toHaveLength(1)
    expect(manifests.at(0)?.state).toBe("failed")
    expect(manifests.at(0)?.coverage).toContain(`Request failed: Authorization: [REDACTED]\n${safe}\nNested: ${JSON.stringify(safe)}\nProvider rejected request; retry later.`)
    for (const canary of ["failure-canary", "failure-tail", "failure-backslash"]) {
      expect(db.serialize().includes(Buffer.from(canary))).toBe(false)
    }
  } finally {
    api.dispose()
    db.close()
    await rm(root, { recursive: true, force: true })
  }
})
