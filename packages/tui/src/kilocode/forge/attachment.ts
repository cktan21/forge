import path from "node:path"
import { fileURLToPath } from "node:url"
import type { Registration } from "@kilocode/forge/schema"
import type { PromptInfo } from "../../prompt/history"

const formats = /\.(?:mdx?|rst|txt|pdf|docx|html?)$/i
const maximum = 20 * 1024 * 1024
type Input = Pick<Registration, "kind" | "label" | "location" | "content" | "session" | "watch">

export function attachments(parts: PromptInfo["parts"]) {
  return parts.flatMap((part, index): Array<{ index: number; label: string; registration?: Input; reason: string }> => {
    if (part.type !== "file") return []
    const label = (part.filename || part.source?.text.value || `Attachment ${index + 1}`).slice(0, 200)
    const convert = (): Input => {
      if (part.source && part.source.type !== "file") throw new Error("Symbol and resource references stay task-only. Register an explicit document separately.")
      if (part.url.startsWith("file:")) {
        const url = new URL(part.url)
        if (url.search || url.hash) throw new Error("This attachment selects part of a file. Register an explicit document to enroll the whole file.")
        const location = fileURLToPath(url)
        if (!formats.test(location)) throw new Error("This file format is not supported by the document library.")
        return { kind: "file", label: path.basename(location).slice(0, 200), location, session: "", watch: false }
      }
      if (!part.url.startsWith("data:")) throw new Error("Only explicit local files and attached document bytes can be enrolled. URLs and resources are not fetched automatically.")
      const filename = part.filename
      if (!filename || filename !== path.basename(filename) || filename.includes("\\") || !formats.test(filename)) throw new Error("Document bytes need a supported plain filename, such as guide.pdf or notes.md.")
      if (part.url.length > Math.ceil(maximum / 3) * 4 + 256) throw new Error("Attachments are limited to 20 MiB.")
      const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(part.url)
      if (!match) throw new Error("This attachment is not a supported base64 document.")
      const content = match.at(2)!
      const bytes = Buffer.from(content, "base64")
      if (!bytes.length || bytes.length > maximum || bytes.toString("base64") !== content) throw new Error("Attachment bytes are empty, oversized, or malformed.")
      return { kind: "upload", label: filename.slice(0, 200), location: filename, content, session: "", watch: false }
    }
    try { return [{ index, label, registration: convert(), reason: "" }] } catch (err) {
      return [{ index, label, registration: undefined, reason: err instanceof Error ? err.message : "Unsupported attachment" }]
    }
  })
}
