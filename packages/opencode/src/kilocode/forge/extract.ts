import { extract as text, maximum, type Page } from "@kilocode/forge/extract"

declare global {
  const KILO_FORGE_DOCUMENT_WORKER_PATH: string
}

let queue = Promise.resolve()

export async function extract(name: string, bytes: Uint8Array, signal: AbortSignal): Promise<Page[]> {
  signal.throwIfAborted()
  if (bytes.byteLength > maximum) throw new Error("Document exceeds the 20 MiB limit")
  if (!/\.(?:pdf|docx)$/i.test(name)) return text(name, bytes, signal)
  const previous = queue
  const done = Promise.withResolvers<void>()
  queue = done.promise
  await previous
  try {
    signal.throwIfAborted()
    const file = typeof KILO_FORGE_DOCUMENT_WORKER_PATH !== "undefined" ? KILO_FORGE_DOCUMENT_WORKER_PATH : new URL("./document-worker.ts", import.meta.url)
    const worker = new Worker(file)
    const result = Promise.withResolvers<Page[]>()
    const timeout = setTimeout(() => result.reject(new Error("Document extraction exceeded 30 seconds")), 30_000)
    const abort = () => result.reject(signal.reason ?? new Error("Document extraction cancelled"))
    signal.addEventListener("abort", abort, { once: true })
    worker.onmessage = (event: MessageEvent<{ pages?: Page[]; error?: string }>) => {
      if (event.data.error) { result.reject(new Error(event.data.error)); return }
      if (!event.data.pages) { result.reject(new Error("Document worker returned no pages")); return }
      result.resolve(event.data.pages)
    }
    worker.onerror = (event) => result.reject(event.error ?? new Error(event.message))
    worker.addEventListener("close", () => result.reject(new Error("Document worker closed before extraction completed")))
    try {
      worker.postMessage({ name, bytes })
      return await result.promise
    } finally {
      clearTimeout(timeout)
      signal.removeEventListener("abort", abort)
      worker.terminate()
    }
  } finally {
    done.resolve()
  }
}
