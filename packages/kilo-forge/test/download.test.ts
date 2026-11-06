import { expect, test } from "bun:test"
import { createServer, request, type IncomingMessage, type ServerResponse } from "node:http"
import type { LookupAddress } from "node:dns"
import type { Socket } from "node:net"
import { download, downloader, publicAddress } from "../src/download"

async function fixture(
  serve: (request: IncomingMessage, response: ServerResponse) => void,
  resolve: (host: string) => Promise<LookupAddress[]> = async () => [{ address: "93.184.216.34", family: 4 }],
) {
  const sockets = new Set<Socket>()
  const calls: Array<{ url: string; headers: IncomingMessage["headers"] }> = []
  const pins: Array<string | LookupAddress[]> = []
  const hosts: string[] = []
  const server = createServer((request, response) => {
    calls.push({ url: request.url ?? "", headers: request.headers })
    serve(request, response)
  })
  server.on("connection", (socket) => {
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
  })
  const listening = Promise.withResolvers<void>()
  server.once("error", listening.reject)
  server.listen(0, "127.0.0.1", listening.resolve)
  await listening.promise
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Expected TCP listener")
  const fetch = downloader({
    resolve: async (host) => { hosts.push(host); return resolve(host) },
    request: (url, options, response) => {
      // Exercise the real request/parser over a local socket. Only the final physical
      // connection is redirected; the downloader's checked-address callback still runs.
      const target = new URL(url)
      target.protocol = "http:"
      target.port = String(address.port)
      return request(target, {
        ...options,
        headers: { ...options.headers, Host: url.host },
        lookup: (host, opts, callback) => {
          if (!options.lookup) throw new Error("Downloader did not pin DNS")
          options.lookup(host, opts, (err, value) => {
            if (err) { callback(err, "", 4); return }
            pins.push(value)
            if (opts.all) { callback(null, [{ address: "127.0.0.1", family: 4 }]); return }
            callback(null, "127.0.0.1", 4)
          })
        },
      }, response)
    },
  })
  return {
    fetch, calls, pins, hosts,
    async [Symbol.asyncDispose]() {
      const done = Promise.withResolvers<void>()
      server.close(() => done.resolve())
      for (const socket of sockets) socket.destroy()
      await done.promise
    },
  }
}

test("public-address validation rejects alternate local spellings before opening a socket", async () => {
  for (const host of ["127.1", "2130706433", "0x7f000001", "[::1]", "[::ffff:127.0.0.1]", "169.254.169.254"]) {
    await expect(download(`http://${host}/secret`, AbortSignal.timeout(1000))).rejects.toThrow("private")
  }
  for (const address of ["0.0.0.0", "10.1.2.3", "100.64.0.1", "172.16.1.1", "192.88.99.1", "192.168.1.1", "198.18.0.1", "224.0.0.1", "::", "fe80::1", "fc00::1", "2001:20::1", "2002:7f00:1::1", "3fff::1"]) {
    expect(publicAddress(address)).toBe(false)
  }
})

test("redirects preserve only safe request headers and pin one checked DNS result per hop", async () => {
  let lookups = 0
  await using f = await fixture((req, res) => {
    if (req.url === "/start") {
      res.writeHead(302, { Location: "http://other.example/final", "Set-Cookie": "private=canary" })
      res.end()
      return
    }
    res.writeHead(200, { "Content-Type": "Text/Markdown; charset=utf-8" })
    res.end("# Local fixture")
  }, async () => [{ address: ++lookups === 1 ? "93.184.216.34" : "8.8.8.8", family: 4 }])
  const result = await f.fetch("http://public.example/start", AbortSignal.timeout(3000))
  expect(new TextDecoder().decode(result.bytes)).toBe("# Local fixture")
  expect(f.hosts).toEqual(["public.example", "other.example"])
  expect(f.pins.flatMap((value) => typeof value === "string" ? [value] : value.map((item) => item.address))).toEqual(["93.184.216.34", "8.8.8.8"])
  expect(f.calls.map((call) => call.headers.host)).toEqual(["public.example", "other.example"])
  for (const call of f.calls) {
    expect(call.headers.authorization).toBeUndefined()
    expect(call.headers.cookie).toBeUndefined()
    expect(call.headers.referer).toBeUndefined()
    expect(call.headers["accept-encoding"]).toBe("identity")
  }
})

test.each([
  "http://127.0.0.1/secret",
  "http://[::ffff:127.0.0.1]/secret",
  "http://169.254.169.254/latest/meta-data",
  "http://user:password@other.example/secret",
  "http://other.example:8080/secret",
  "file:///etc/passwd",
])("redirect target is revalidated: %s", async (target) => {
  await using f = await fixture((_req, res) => { res.writeHead(302, { Location: target }); res.end() })
  await expect(f.fetch("http://public.example/start", AbortSignal.timeout(3000))).rejects.toThrow()
  expect(f.calls).toHaveLength(1)
})

test("HTTPS downgrade is rejected before the next request", async () => {
  await using f = await fixture((_req, res) => { res.writeHead(302, { Location: "http://other.example/plain" }); res.end() })
  await expect(f.fetch("https://public.example/start", AbortSignal.timeout(3000))).rejects.toThrow("downgrade")
  expect(f.calls).toHaveLength(1)
})

test("same-host redirect rechecks DNS and rejects a rebound private answer", async () => {
  let count = 0
  await using f = await fixture((_req, res) => { res.writeHead(307, { Location: "/next" }); res.end() },
    async () => [{ address: ++count === 1 ? "93.184.216.34" : "127.0.0.1", family: 4 }])
  await expect(f.fetch("http://public.example/start", AbortSignal.timeout(3000))).rejects.toThrow("private")
  expect(f.hosts).toEqual(["public.example", "public.example"])
  expect(f.calls).toHaveLength(1)
})

test.each([{ addresses: [] }, { addresses: [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.1", family: 4 }] }])("empty or mixed DNS answer never connects", async (input) => {
  await using f = await fixture((_req, res) => res.end("must not be reached"), async () => [...input.addresses])
  await expect(f.fetch("http://public.example/", AbortSignal.timeout(3000))).rejects.toThrow("private")
  expect(f.calls).toEqual([])
  expect(f.pins).toEqual([])
})

test("redirect cycles stop after three hops", async () => {
  await using f = await fixture((_req, res) => { res.writeHead(308, { Location: "/loop" }); res.end() })
  await expect(f.fetch("http://public.example/start", AbortSignal.timeout(3000))).rejects.toThrow("redirect limit")
  expect(f.calls).toHaveLength(4)
})

test("redirect closes an unfinished body and continues to a valid relative target", async () => {
  const closed = Promise.withResolvers<void>()
  await using f = await fixture((req, res) => {
    if (req.url === "/start") {
      res.on("close", closed.resolve)
      res.writeHead(303, { Location: "/final" })
      res.flushHeaders()
      return
    }
    res.writeHead(200, { "Content-Type": "text/plain" })
    res.end("complete")
  })
  expect(new TextDecoder().decode((await f.fetch("http://public.example/start", AbortSignal.timeout(3000))).bytes)).toBe("complete")
  await closed.promise
  expect(f.calls.map((call) => call.url)).toEqual(["/start", "/final"])
})

test("malformed redirect location is a handled failure", async () => {
  await using f = await fixture((_req, res) => { res.writeHead(302, { Location: "http://[" }); res.end() })
  await expect(f.fetch("http://public.example/", AbortSignal.timeout(3000))).rejects.toThrow()
  expect(f.calls).toHaveLength(1)
})

test("pre-cancelled requests do not resolve DNS or connect", async () => {
  await using f = await fixture((_req, res) => res.end("must not be reached"))
  await expect(f.fetch("http://public.example/", AbortSignal.abort(new Error("Already cancelled")))).rejects.toThrow("Already cancelled")
  expect(f.hosts).toEqual([])
  expect(f.calls).toEqual([])
})

test("cancellation during unresolved DNS returns without a late connection", async () => {
  const pending = Promise.withResolvers<LookupAddress[]>()
  const entered = Promise.withResolvers<void>()
  const abort = new AbortController()
  await using f = await fixture((_req, res) => res.end("must not be reached"), async () => {
    entered.resolve()
    return pending.promise
  })
  const result = f.fetch("http://public.example/", abort.signal)
  await entered.promise
  abort.abort(new Error("Cancelled DNS"))
  try { await expect(result).rejects.toThrow("Cancelled DNS") } finally { pending.resolve([{ address: "93.184.216.34", family: 4 }]) }
  expect(f.calls).toEqual([])
  expect(f.pins).toEqual([])
})

test("deadline covers unresolved DNS without waiting for its eventual result", async () => {
  const pending = Promise.withResolvers<LookupAddress[]>()
  await using f = await fixture((_req, res) => res.end("must not be reached"), () => pending.promise)
  try {
    await expect(f.fetch("http://public.example/", AbortSignal.timeout(25))).rejects.toThrow()
    expect(f.calls).toEqual([])
  } finally { pending.resolve([{ address: "93.184.216.34", family: 4 }]) }
})

test.each([
  { type: "text/plain", name: "document.txt" },
  { type: "text/html", name: "document.html" },
  { type: "application/pdf", name: "document.pdf" },
])("supported response preserves bytes: $type", async (input) => {
  const bytes = Buffer.from([0, 1, 2, 0xff])
  await using f = await fixture((_req, res) => {
    res.writeHead(200, { "Content-Type": input.type, "Content-Length": String(bytes.length) })
    res.end(bytes)
  })
  const value = await f.fetch("http://public.example/", AbortSignal.timeout(3000))
  expect(value.name).toBe(input.name)
  expect(value.bytes).toEqual(new Uint8Array(bytes))
})

test("exactly two MiB is accepted", async () => {
  await using f = await fixture((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" })
    res.end(Buffer.alloc(2 * 1024 * 1024, "x"))
  })
  const value = await f.fetch("http://public.example/", AbortSignal.timeout(3000))
  expect(value.bytes.length).toBe(2 * 1024 * 1024)
})

test.each(["status", "type", "encoding", "length", "redirect"] as const)("rejected %s headers close an unfinished response", async (mode) => {
  const closed = Promise.withResolvers<void>()
  await using f = await fixture((_req, res) => {
    res.on("close", closed.resolve)
    res.writeHead(mode === "status" ? 403 : mode === "redirect" ? 302 : 200, {
      "Content-Type": mode === "type" ? "application/octet-stream" : "text/plain",
      ...(mode === "encoding" ? { "Content-Encoding": "gzip" } : {}),
      ...(mode === "length" ? { "Content-Length": String(2 * 1024 * 1024 + 1) } : {}),
    })
    res.flushHeaders()
    // Never finish: rejecting headers must close the socket, not drain forever.
  })
  await expect(f.fetch("http://public.example/", AbortSignal.timeout(3000))).rejects.toThrow()
  await closed.promise
})

test("streamed size limit closes the response without buffering excess content", async () => {
  const closed = Promise.withResolvers<void>()
  await using f = await fixture((_req, res) => {
    res.on("close", closed.resolve)
    res.writeHead(200, { "Content-Type": "text/plain" })
    res.write(Buffer.alloc(2 * 1024 * 1024 + 1, "x"))
  })
  await expect(f.fetch("http://public.example/", AbortSignal.timeout(3000))).rejects.toThrow("2 MiB")
  await closed.promise
})

test("a truncated response fails instead of publishing partial content", async () => {
  await using f = await fixture((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain", "Content-Length": "100" })
    res.write("short", () => res.socket?.destroy())
  })
  await expect(f.fetch("http://public.example/", AbortSignal.timeout(3000))).rejects.toThrow(/interrupted|aborted|socket hang up/)
})

test("abort during body streaming closes the live socket", async () => {
  const entered = Promise.withResolvers<void>()
  const closed = Promise.withResolvers<void>()
  const abort = new AbortController()
  await using f = await fixture((_req, res) => {
    res.on("close", closed.resolve)
    res.writeHead(200, { "Content-Type": "text/plain" })
    res.write("partial")
    entered.resolve()
  })
  const result = f.fetch("http://public.example/", abort.signal)
  await entered.promise
  abort.abort(new Error("Cancelled body"))
  await expect(result).rejects.toThrow()
  await closed.promise
})
