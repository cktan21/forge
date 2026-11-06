// The opt-in probe parses screen cells without opening a DOM.
import { Terminal } from "@xterm/xterm"

const terminal = new Terminal({ cols: 140, rows: 48, allowProposedApi: true })
terminal.onData((data) => self.postMessage({ reply: data }))
let queue = Promise.resolve()

self.onmessage = (event: MessageEvent<{ id: number; data?: string; cols?: number; rows?: number }>) => {
  const request = event.data
  // PTY writes and resizes must be applied in arrival order.
  queue = queue
    .then(async () => {
      if (request.data != null) {
        const ready = Promise.withResolvers<void>()
        terminal.write(request.data, ready.resolve)
        await ready.promise
      }
      if (request.cols != null && request.rows != null) terminal.resize(request.cols, request.rows)
      const buffer = terminal.buffer.active
      const text = Array.from(
        { length: terminal.rows },
        (_, row) => buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? "",
      ).join("\n")
      self.postMessage({ id: request.id, text })
    })
    .catch((err: unknown) => {
      self.postMessage({ id: request.id, error: String(err) })
    })
}
