import { inflateRawSync } from "node:zlib"
import { maximum, type Page } from "@kilocode/forge/extract"
import { open } from "@/kilocode/tool/read-docx"

function check(bytes: Buffer) {
  const end = (() => {
    for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65_557); offset--) {
      if (bytes.readUInt32LE(offset) === 0x06054b50 && offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length) return offset
    }
    throw new Error("DOCX has no valid ZIP directory")
  })()
  const count = bytes.readUInt16LE(end + 10)
  if (bytes.readUInt32LE(end + 4) !== 0 || count > 2048 || count !== bytes.readUInt16LE(end + 8)) throw new Error("Multipart, ZIP64, or oversized DOCX archives are unsupported")
  let offset = bytes.readUInt32LE(end + 16)
  let total = 0
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error("Invalid DOCX ZIP directory")
    const flags = bytes.readUInt16LE(offset + 8)
    const method = bytes.readUInt16LE(offset + 10)
    const compressed = bytes.readUInt32LE(offset + 20)
    const expanded = bytes.readUInt32LE(offset + 24)
    const local = bytes.readUInt32LE(offset + 42)
    if ((flags & 1) || ![0, 8].includes(method) || expanded > maximum - total || local + 30 > offset || bytes.readUInt32LE(local) !== 0x04034b50) throw new Error("Encrypted, oversized, or invalid DOCX entry")
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28)
    if (start + compressed > offset) throw new Error("DOCX entry extends beyond its data region")
    const payload = bytes.subarray(start, start + compressed)
    const data = method === 8 ? inflateRawSync(payload, { maxOutputLength: maximum - total + 1 }) : payload
    total += data.byteLength
    if (data.byteLength !== expanded || total > maximum) throw new Error("DOCX decompression exceeds its declared size or the 20 MiB limit")
    offset += 46 + bytes.readUInt16LE(offset + 28) + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32)
  }
}

export async function document(name: string, input: Uint8Array, signal: AbortSignal): Promise<Page[]> {
  const bytes = Buffer.from(input)
  signal.throwIfAborted()
  check(bytes)
  const stream = await open(name, bytes)
  let text = ""
  for await (const part of stream) {
    signal.throwIfAborted()
    text += String(part)
    if (Buffer.byteLength(text) > maximum) throw new Error("Extracted DOCX text exceeds 20 MiB")
  }
  return [{ text }]
}
