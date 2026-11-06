import { expect, test } from "bun:test"
import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js"
import { document } from "../../src/kilocode/forge/documents"
import { extract } from "../../src/kilocode/forge/extract"

async function archive() {
  const writer = new ZipWriter(new Uint8ArrayWriter())
  await writer.add("[Content_Types].xml", new TextReader(
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  ))
  await writer.add("_rels/.rels", new TextReader(
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  ))
  await writer.add("word/document.xml", new TextReader(
    '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Queue ownership requires epoch leases.</w:t></w:r></w:p><w:unsupported/></w:body></w:document>',
  ))
  return writer.close()
}

test("bounded Forge DOCX adapter reuses paragraph extraction and preserves warnings", async () => {
  const pages = await document("policy.docx", await archive(), AbortSignal.timeout(5000))
  expect(pages.at(0)?.text).toContain("Queue ownership requires epoch leases")
  expect(pages.at(0)?.text).toContain("DOCX extraction warnings")
})

test("Forge DOCX adapter rejects malformed, oversized, and cancelled input", async () => {
  await expect(document("invalid.docx", new Uint8Array([80, 75]), AbortSignal.timeout(5000))).rejects.toThrow("ZIP directory")
  const bytes = Buffer.from(await archive())
  const offset = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
  expect(offset).toBeGreaterThan(0)
  bytes.writeUInt32LE(21 * 1024 * 1024, offset + 24)
  await expect(document("large.docx", bytes, AbortSignal.timeout(5000))).rejects.toThrow("oversized")
  await expect(document("cancelled.docx", await archive(), AbortSignal.abort(new Error("cancelled")))).rejects.toThrow("cancelled")
})

test("the production worker extracts DOCX and recovers after cancellation or parser failure", async () => {
  const bytes = await archive()
  const controller = new AbortController()
  const pending = extract("policy.docx", bytes, controller.signal)
  setTimeout(() => controller.abort(new Error("cancel worker")), 1)
  await expect(pending).rejects.toThrow("cancel worker")
  await expect(extract("broken.pdf", new TextEncoder().encode("%PDF-broken"), AbortSignal.timeout(5000))).rejects.toThrow()
  const pages = await extract("policy.docx", bytes, AbortSignal.timeout(5000))
  expect(pages.at(0)?.text).toContain("epoch leases")
})
