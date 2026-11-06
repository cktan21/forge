import { describe, expect, test } from "bun:test"
import { rejects } from "node:assert/strict"
import { prepared, requirements } from "../../src/kilocode/forge/draft"
import { displaySlice, promptOffsetWidth } from "../../src/prompt/display"
import { type PromptInfo } from "../../src/prompt/history"
import { lineage } from "@kilocode/forge/lineage"
import { responses, transcript, identity, edits } from "../../src/kilocode/forge/conversation"
import { pathToFileURL } from "node:url"
import { attachments } from "../../src/kilocode/forge/attachment"
import { Database } from "bun:sqlite"
import { store } from "@kilocode/forge/store"
import { knowledge } from "@kilocode/forge/knowledge"

describe("draft", () => {
  test("requirements expand tracked duplicate paste labels at display offsets without changing the draft", () => {
    const marker = "[Pasted ~5 lines]"
    const prefix = `/enhance \u4e2d\n${marker} `
    const middle = `${prefix}${marker}\n`
    const input = `${middle}${marker}`
    const draft: PromptInfo = {
      input,
      mode: "shell",
      parts: [
        {
          type: "text",
          text: "First requirements\ncontinued",
          source: {
            text: { value: marker, start: promptOffsetWidth(prefix), end: promptOffsetWidth(prefix + marker) },
          },
        },
        {
          type: "text",
          text: "Second requirements",
          source: { text: { value: marker, start: promptOffsetWidth(middle), end: promptOffsetWidth(input) } },
        },
      ],
    }
    const before = structuredClone(draft)
    expect(requirements(draft)).toBe(`/enhance \u4e2d\n${marker} First requirements\ncontinued\nSecond requirements`)
    expect(draft).toEqual(before)
  })

  test("obsolete paste ranges cannot replace unrelated requirements", () => {
    const input = "/enhance Keep these requirements"
    const draft: PromptInfo = {
      input,
      parts: [
        { type: "text", text: "Wrong", source: { text: { value: "[Pasted]", start: 0, end: 8 } } },
        { type: "text", text: "Wrong", source: { text: { value: input, start: -1, end: input.length } } },
        { type: "text", text: "Wrong", source: { text: { value: input, start: 0, end: 999 } } },
      ],
    }
    expect(requirements(draft)).toBe(input)
  })

  test("prepared drafts discard paste offsets and re-anchor files, resources, and agents without changing attachment data", () => {
    const draft: PromptInfo = {
      input: "[Pasted] @review @code [Image]",
      mode: "shell",
      parts: [
        { type: "text", text: "Requirements", source: { text: { value: "[Pasted]", start: 0, end: 8 } } },
        { type: "agent", name: "review", source: { value: "@review", start: 9, end: 16 } },
        {
          type: "file",
          mime: "text/plain",
          url: "file:///project/code.ts",
          source: { type: "file", path: "/project/code.ts", text: { value: "@code", start: 17, end: 22 } },
        },
        {
          type: "file",
          mime: "image/png",
          url: "data:image/png;base64,dGVzdA==",
          source: { type: "file", path: "", text: { value: "[Image]", start: 23, end: 30 } },
        },
        {
          type: "file",
          mime: "text/plain",
          url: "mcp://docs/item",
          source: {
            type: "resource",
            clientName: "docs",
            uri: "mcp://docs/item",
            text: { value: "@docs", start: 0, end: 5 },
          },
        },
        { type: "file", mime: "application/pdf", filename: "guide.pdf", url: "file:///project/guide.pdf" },
        { type: "agent", name: "build" },
      ],
    }
    const before = structuredClone(draft)
    const request = "26996be9-bc68-4dfa-bf80-0de3ff999412"
    const result = prepared(draft, "Reviewed \u4e2d task", "Supporting source", request)
    expect(result.mode).toBe("normal")
    expect(result.input).toStartWith("Reviewed \u4e2d task\n\n<forge-preparation")
    expect(lineage([{ role: "user", content: result.input }])).toBe(request)
    expect(lineage([{ role: "user", content: prepared(draft, "Legacy", "Evidence").input }])).toBeUndefined()
    expect(result.parts).toHaveLength(6)
    for (const part of result.parts) {
      if (part.type === "text") throw new Error("Paste offsets must not survive preparation")
      const range = part.type === "agent" ? part.source : part.source?.text
      expect(range).toBeDefined()
      expect(displaySlice(result.input, range!.start, range!.end)).toBe(range!.value)
    }
    expect(result.parts.at(3)).toMatchObject({
      type: "file",
      url: "mcp://docs/item",
      source: { type: "resource", clientName: "docs", uri: "mcp://docs/item" },
    })
    expect(result.parts.at(4)).toMatchObject({ type: "file", filename: "guide.pdf", url: "file:///project/guide.pdf" })
    expect(requirements(result)).toBe(result.input)
    expect(draft).toEqual(before)
  })
})

describe("conversation", () => {
  const items = [
    {
      id: "audience",
      question: "Which audience?",
      impact: "Sets the examples.",
      options: ["Developers", "Users"],
      optional: true,
    },
  ]

  test("comments-only and skipped answers preserve their meaning without selecting an option", () => {
    expect(JSON.parse(responses(items, { audience: { comment: "Documentation maintainers." } }))).toMatchObject({
      option: null,
      comment: "Documentation maintainers.",
      skipped: false,
    })
    expect(JSON.parse(responses(items, {}))).toMatchObject({ option: null, skipped: true })
    expect(
      JSON.parse(responses(items, { audience: { option: "Users", comment: "Include screenshots." } })),
    ).toMatchObject({
      option: "Users",
      comment: "Include screenshots.",
      skipped: false,
    })
  })

  test("answers cannot silently use an option from a different revision", () => {
    expect(() => responses(items, { audience: { option: "Administrators" } })).toThrow("no longer available")
  })

  test("feedback history retains all entries or reports its limit instead of dropping earlier requirements", () => {
    expect(transcript(["Keep the API.", "", "Add tests."])).toBe("Keep the API.\n\nAdd tests.")
    expect(() => transcript(["a".repeat(30_001)])).toThrow("too long")
  })

  test("question identity ignores cosmetic whitespace and ordering but never merges blockers or changed choices", () => {
    const item = items.at(0)!
    expect(identity(item)).toBe(
      identity({ ...item, id: "different", question: " WHICH  audience? ", options: [" Users ", " developers"] }),
    )
    expect(identity(item)).not.toBe(identity({ ...item, optional: false }))
    expect(identity(item)).not.toBe(identity({ ...item, options: ["Developers", "Administrators"] }))
    expect(identity(item)).not.toBe(identity({ ...item, question: "Which deployment environment?" }))
  })

  test("human edit patches preserve additions and removals without promoting untouched AI notes", () => {
    const before = "User: include screenshots\nAI assumption: use a hosted service\nUser: preserve compatibility\n"
    const after =
      "User: no screenshots\nAI assumption: use a hosted service\nUser: preserve compatibility\nSupport offline usage\n"
    expect(edits(before, after)).toEqual([
      { before: "User: include screenshots\n", after: "User: no screenshots\n" },
      { before: "", after: "Support offline usage\n" },
    ])
    expect(JSON.stringify(edits(before, after))).not.toContain("hosted service")
    expect(edits(before, before)).toEqual([])
  })
})

describe("attachment", () => {
  const file = (url: string, filename = "guide.md"): PromptInfo["parts"][number] => ({
    type: "file",
    filename,
    mime: "text/markdown",
    url,
  })

  test("attachment enrollment maps one explicit file, never its parent or mutable source metadata", () => {
    const part = file(pathToFileURL("/project/docs/guide.md").href)
    const before = structuredClone(part)
    expect(attachments([part]).at(0)?.registration).toEqual({
      kind: "file",
      label: "guide.md",
      location: "/project/docs/guide.md",
      session: "",
      watch: false,
    })
    expect(part).toEqual(before)
    expect(attachments([file("file:///project/docs/guide.md?start=2&end=4")]).at(0)?.reason).toContain("part of a file")
    expect(attachments([file("file://remote/project/docs/guide.md")]).at(0)?.registration).toBeUndefined()
    expect(attachments([file("file:///project/docs/code.ts")]).at(0)?.registration).toBeUndefined()
  })

  test("attachment bytes are bounded, validated, and kept unchanged for explicit upload", () => {
    const content = Buffer.from("# Private guide\nUse epoch leases.").toString("base64")
    const part = file(`data:text/markdown;base64,${content}`)
    const before = structuredClone(part)
    expect(attachments([part]).at(0)?.registration).toEqual({
      kind: "upload",
      label: "guide.md",
      location: "guide.md",
      content,
      session: "",
      watch: false,
    })
    expect(part).toEqual(before)
    for (const url of [
      "data:text/markdown;base64,@",
      "data:text/markdown;base64,Zg=",
      "data:text/markdown;base64,",
      "data:text/plain,hello",
    ]) {
      expect(attachments([file(url)]).at(0)?.registration).toBeUndefined()
    }
    expect(attachments([file(part.type === "file" ? part.url : "", "../guide.md")]).at(0)?.registration).toBeUndefined()
    expect(attachments([file(`data:text/plain;base64,${"A".repeat(28_000_000)}`)]).at(0)?.reason).toContain("20 MiB")
  })

  test("images, resources, symbols, and remote URLs remain task-only without implicit fetching", () => {
    const source = { text: { value: "@docs", start: 0, end: 5 } }
    const parts: PromptInfo["parts"] = [
      file("data:image/png;base64,dGVzdA==", "image.png"),
      file("https://public.example/guide.md"),
      {
        type: "file",
        mime: "text/plain",
        url: "file:///project/guide.md",
        source: { ...source, type: "resource", clientName: "docs", uri: "mcp://docs" },
      },
      {
        type: "file",
        mime: "text/plain",
        url: "file:///project/guide.md",
        source: {
          ...source,
          type: "symbol",
          path: "/project/guide.md",
          name: "symbol",
          kind: 1,
          range: { start: { line: 1, character: 0 }, end: { line: 2, character: 0 } },
        },
      },
      { type: "text", text: "Ordinary pasted requirements" },
      { type: "agent", name: "build" },
    ]
    expect(attachments(parts)).toHaveLength(4)
    expect(attachments(parts).every((item) => !item.registration && item.reason)).toBe(true)
  })

  test("enrolled attachment bytes enter the real registry without indexing or sharing approval", async () => {
    const db = new Database(":memory:")
    const storage = store({
      all: async (query) =>
        db.query<Record<string, unknown>, (string | number | null)[]>(query.text).all(...(query.values ?? [])),
      batch: async (queries) => {
        db.transaction(() => {
          for (const query of queries) db.query(query.text).run(...(query.values ?? []))
        })()
      },
    })
    const root = "/attachment-registry"
    const library = knowledge(root, storage)
    const content = Buffer.from("# Attachment\nPrivate ownership contract.").toString("base64")
    try {
      const registration = attachments([file(`data:text/markdown;base64,${content}`)]).at(0)?.registration
      if (!registration) throw new Error("Expected supported attachment")
      const item = await library.register(registration)
      expect(item).toMatchObject({ kind: "upload", session: "", approved: false, providers: [], state: "registered" })
      expect(await storage.contents(root, item.id)).toBe(content)
      expect((await storage.view(root)).sources).toEqual([])
      await rejects(library.index(item.id), /Approve/)
      await library.approve(item.id)
      await library.index(item.id)
      expect((await storage.view(root)).sources.some((item) => item.text.includes("Private ownership"))).toBe(true)
      expect(await storage.knowledge(root, "", "unapproved-provider")).toEqual([])
      expect((await library.register(registration)).id).toBe(item.id)
      expect(await storage.collections(root)).toHaveLength(1)
    } finally {
      await library.dispose()
      db.close()
    }
  })
})
