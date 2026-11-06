import path from "node:path"
import { createHash } from "node:crypto"
import { Lexer, Tokenizer } from "marked"
import type { Collection, Source } from "./schema"
import { source } from "./parse"
import { id } from "./util"
import { briefs } from "./briefs"

export type Page = { text: string; page?: number }
export type Extractor = (name: string, bytes: Uint8Array, signal: AbortSignal) => Promise<Page[]>
export const maximum = 20 * 1024 * 1024

export async function extract(name: string, bytes: Uint8Array, signal: AbortSignal, docx?: Extractor): Promise<Page[]> {
  signal.throwIfAborted()
  if (bytes.byteLength > maximum) throw new Error("Document exceeds the 20 MiB limit")
  const ext = path.extname(name).toLowerCase()
  if (ext === ".docx") {
    if (!docx) throw new Error("DOCX extraction is unavailable in this host")
    return docx(name, bytes, signal)
  }
  if (ext !== ".pdf") {
    if (![".md", ".mdx", ".txt", ".rst", ".html", ".htm"].includes(ext)) throw new Error(`Unsupported document format: ${ext || "no extension"}`)
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    if (text.includes("\0")) throw new Error("Document contains binary data")
    return [{ text: ext.startsWith(".htm") ? html(text) : text }]
  }
  if (new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-") throw new Error("File is not a PDF")
  const { getDocumentProxy } = await import("unpdf")
  const pdf = await getDocumentProxy(bytes.slice(), { useWorkerFetch: false, useSystemFonts: false, disableFontFace: true })
  const abort = () => { void pdf.loadingTask.destroy().catch(() => console.warn("PDF cleanup failed")) }
  signal.addEventListener("abort", abort, { once: true })
  try {
    signal.throwIfAborted()
    if (pdf.numPages > 1000) throw new Error("PDF exceeds the 1000 page limit")
    const pages: Page[] = []
    let size = 0
    for (let index = 1; index <= pdf.numPages; index++) {
      signal.throwIfAborted()
      const page = await pdf.getPage(index)
      const content = await page.getTextContent()
      const text = content.items.map((item) => "str" in item ? `${item.str}${item.hasEOL ? "\n" : " "}` : "").join("")
      size += text.length
      if (size > maximum) throw new Error("Extracted PDF text exceeds the size limit")
      pages.push({ text, page: index })
      page.cleanup()
    }
    if (!pages.some((page) => page.text.trim())) throw new Error("PDF has no extractable text. Scanned documents require opt-in OCR, which is not enabled.")
    return pages
  } finally {
    signal.removeEventListener("abort", abort)
    await pdf.loadingTask.destroy()
  }
}

export function html(text: string) {
  return text.replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|svg|iframe)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<\/(?:p|div|section|article|h[1-6]|li|tr)>|<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(?:amp|lt|gt|quot|apos|nbsp);/g, (entity) => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&nbsp;": " " })[entity] ?? entity)
    .replace(/[ \t]+/g, " ").trim()
}

export function version(name: string) {
  return /\.mdx?$/i.test(name) ? "forge-markdown-v2" : "forge-document-v2"
}

function outline(text: string) {
  const tokenizer = new Tokenizer()
  const parser = new Lexer({
    tokenizer,
    extensions: {
      renderers: {}, childTokens: {},
      block: [(text) => {
        // Keep even duplicate link definitions in the token stream so line
        // positions remain tied to the original; no rendering is performed.
        const token = tokenizer.def(text)
        return token ? { ...token, type: "forge-definition" } : undefined
      }],
    },
  })
  const result = new Map<number, { level: number; title: string }>()
  let line = 0
  for (const token of parser.lex(text.replace(/\r\n/g, "\n").replace(/\r/g, " "))) {
    if (token.type === "heading") result.set(line, { level: token.depth, title: token.text })
    line += token.raw.split("\n").length - 1
  }
  return result
}

export function chunks(collection: Collection, name: string, bytes: Uint8Array, pages: readonly Page[]): Source[] {
  const fingerprint = createHash("sha256").update(bytes).digest("hex")
  const uri = `knowledge:${collection.id}/${name}`
  const parent = id(collection.id, name)
  const detail = {
    collection: collection.id, session: collection.session, providers: JSON.stringify(collection.providers),
    location: collection.location, document: name, fileHash: fingerprint, extractor: version(name),
  }
  const markdown = detail.extractor === "forge-markdown-v2"
  const sources: Source[] = [source(uri, "", "document", { id: parent, label: `${collection.label}: ${name}`, method: "collection-document", hash: fingerprint, detail })]
  let ordinal = 0
  for (const page of pages) {
    const lines = page.text.split("\n")
    const headings: { level: number; title: string }[] = []
    const parsed = markdown ? outline(page.text) : undefined
    let buffer: string[] = []
    let start = 1
    let length = 0
    function flush(end: number) {
      const text = buffer.join("\n").trim()
      const heading = headings.map((item) => item.title).join(" / ")
      if (text) sources.push(source(uri, text, "document", {
        id: id(parent, String(page.page ?? 0), String(start), String(ordinal++)), label: `${collection.label}: ${heading || name}${page.page ? ` (page ${page.page})` : ""}`,
        start, end, method: "collection-section", evidence: [parent],
        detail: { ...detail, heading, ...(page.page ? { page: String(page.page) } : {}) },
      }))
      buffer = []
      length = 0
    }
    for (const [index, line] of lines.entries()) {
      const heading = markdown ? parsed!.get(index) : (() => {
        const match = line.match(/^(#{1,6})\s+(.+)/)
        return match ? { level: match[1]!.length, title: match[2]!.trim() } : undefined
      })()
      if (heading) {
        flush(index)
        if (markdown) {
          while (headings.length && headings.at(-1)!.level >= heading.level) headings.pop()
        }
        if (!markdown) headings.length = Math.min(headings.length, heading.level - 1)
        headings.push(heading)
        start = index + 1
      }
      // Split unusually long lines as well as normal paragraphs to bound each passage.
      for (let offset = 0; offset < Math.max(1, line.length); offset += 2400) {
        if (length >= 2400) { flush(offset ? index + 1 : index); start = index + 1 }
        const part = line.slice(offset, offset + 2400)
        buffer.push(part)
        length += part.length + 1
      }
    }
    flush(lines.length)
  }
  return briefs(sources)
}
