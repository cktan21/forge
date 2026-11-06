import { gzip, gunzip } from "node:zlib"
import { promisify } from "node:util"
import { Snapshot, decode } from "./schema"
import { checkpoint } from "./cooperate"

const compress = promisify(gzip)
const expand = promisify(gunzip)
const maximum = 512 * 1024 * 1024

export async function pack(snapshot: Snapshot) {
  const text = await (async () => {
    if (snapshot.sources.length + snapshot.relations.length < 1000) return JSON.stringify(snapshot)
    const pause = checkpoint()
    const fields: string[] = []
    for (const [key, value] of Object.entries(snapshot)) {
      if (key !== "sources" && key !== "relations") {
        const text = JSON.stringify(value)
        if (text != null) fields.push(`${JSON.stringify(key)}:${text}`)
        continue
      }
      const items = key === "sources" ? snapshot.sources : snapshot.relations
      const chunks: string[] = []
      for (let offset = 0; offset < items.length; offset += 200) {
        chunks.push(JSON.stringify(items.slice(offset, offset + 200)).slice(1, -1))
        await pause()
      }
      fields.push(`${JSON.stringify(key)}:[${chunks.join(",")}]`)
      await pause()
    }
    return `{${fields.join(",")}}`
  })()
  const bytes = Buffer.byteLength(text)
  if (bytes < 1024 * 1024 || bytes > maximum) return text
  const data = await compress(text, { level: 1 })
  return JSON.stringify({
    root: snapshot.root, generation: snapshot.generation, revision: snapshot.revision,
    observed: snapshot.observed, files: snapshot.files, partial: snapshot.partial, warnings: snapshot.warnings,
    encoding: "gzip-v1", bytes, data: data.toString("base64"),
  })
}

export async function unpack(value: unknown): Promise<Snapshot> {
  if (value == null || typeof value !== "object" || !("encoding" in value)) return decode(Snapshot, value)
  if (value.encoding !== "gzip-v1" || !("bytes" in value) || typeof value.bytes !== "number" ||
    !Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > maximum ||
    !("data" in value) || typeof value.data !== "string" || value.data.length > Math.ceil(maximum / 3) * 4)
    throw new Error("Invalid compressed Forge snapshot")
  const text = await expand(Buffer.from(value.data, "base64"), { maxOutputLength: value.bytes })
  if (text.byteLength !== value.bytes) throw new Error("Forge snapshot size mismatch")
  const snapshot = decode(Snapshot, JSON.parse(text.toString("utf8")))
  if (!("generation" in value) || snapshot.generation !== value.generation ||
    !("root" in value) || snapshot.root !== value.root)
    throw new Error("Forge snapshot header mismatch")
  return snapshot
}
