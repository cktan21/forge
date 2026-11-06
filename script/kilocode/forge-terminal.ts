export function screen(reply: (data: string) => void, changed: () => void) {
  // Isolate the browser-oriented emulator's runtime and terminate it explicitly.
  const worker = new Worker(new URL("./forge-terminal-worker.ts", import.meta.url).href)
  const pending = new Map<number, ReturnType<typeof Promise.withResolvers<void>>>()
  let sequence = 0
  let text = ""
  let error: Error | undefined

  function fail(err: Error) {
    error = err
    for (const request of pending.values()) request.reject(err)
    pending.clear()
    changed()
  }

  worker.onerror = (event) => fail(new Error(event.message))
  worker.onmessage = (event: MessageEvent<{ id?: number; text?: string; reply?: string; error?: string }>) => {
    if (event.data.reply != null) reply(event.data.reply)
    if (event.data.error != null) return fail(new Error(event.data.error))
    if (event.data.text != null) text = event.data.text
    if (event.data.id != null) {
      pending.get(event.data.id)?.resolve()
      pending.delete(event.data.id)
    }
    changed()
  }

  function send(request: { data?: string; cols?: number; rows?: number }) {
    if (error) return Promise.reject(error)
    const ready = Promise.withResolvers<void>()
    const id = ++sequence
    pending.set(id, ready)
    worker.postMessage({ ...request, id })
    return ready.promise
  }

  return {
    text() {
      if (error) throw error
      return text
    },
    write(data: string) {
      return send({ data })
    },
    resize(cols: number, rows: number) {
      return send({ cols, rows })
    },
    [Symbol.dispose]() {
      fail(new Error("Terminal observer disposed"))
      worker.terminate()
    },
  }
}
