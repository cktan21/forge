import { extract } from "@kilocode/forge/extract"
import { document } from "./documents"

onmessage = (event: MessageEvent<{ name: string; bytes: Uint8Array }>) => {
  void extract(event.data.name, event.data.bytes, AbortSignal.timeout(30_000), document).then(
    (pages) => postMessage({ pages }),
    (err: unknown) => postMessage({ error: err instanceof Error ? err.message : String(err) }),
  )
}
