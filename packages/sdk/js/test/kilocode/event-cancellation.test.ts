import { expect, test } from "bun:test"
import { createKiloClient } from "../../src/v2/client"

test("aborting an active generated event stream observes reader cancellation", async () => {
  const closed = Promise.withResolvers<void>()
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request) {
      request.signal.addEventListener("abort", () => closed.resolve(), { once: true })
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"directory":"global","payload":{"type":"server.connected","properties":{}}}\n\n'))
        },
      }), { headers: { "content-type": "text/event-stream" } })
    },
  })
  const controller = new AbortController()
  const errors: unknown[] = []
  try {
    const client = createKiloClient({ baseUrl: server.url.toString(), directory: "/fixture" })
    const events = await client.global.event({ signal: controller.signal, sseMaxRetryAttempts: 0, onSseError: (err) => errors.push(err) })
    expect((await events.stream.next()).value).toMatchObject({ payload: { type: "server.connected" } })
    const pending = events.stream.next()
    controller.abort()
    expect((await pending).done).toBe(true)
    await closed.promise
    // Surface detached rejection callbacks before the test ends.
    await Bun.sleep(10)
    expect(errors.every((err) => err instanceof DOMException && err.name === "AbortError")).toBe(true)
  } finally {
    controller.abort()
    await server.stop(true)
  }
})

test("generated event cancellation observes rejection when the response body errors first", async () => {
  const controller = new AbortController()
  let body: ReadableStreamDefaultController<Uint8Array> | undefined
  const fetch = Object.assign(async () => new Response(new ReadableStream<Uint8Array>({
    start(value) {
      body = value
      value.enqueue(new TextEncoder().encode('data: {"directory":"global","payload":{"type":"server.connected","properties":{}}}\n\n'))
    },
  }), { headers: { "content-type": "text/event-stream" } }), { preconnect: globalThis.fetch.preconnect.bind(globalThis.fetch) })
  const client = createKiloClient({ baseUrl: "http://fixture.local", fetch })
  const events = await client.global.event({ signal: controller.signal, sseMaxRetryAttempts: 0 })
  expect((await events.stream.next()).done).toBe(false)
  const reason = new DOMException("Response body aborted", "AbortError")
  body!.error(reason)
  // Let the decoder observe the network failure while the generator is suspended.
  await Bun.sleep(1)
  controller.abort(reason)
  expect((await events.stream.next()).done).toBe(true)
  await Bun.sleep(10)
})
