import { expect, test } from "bun:test"
import { request } from "node:https"
import { downloader } from "../src/download"

// Public test-only key, never used by an application or installed in a trust store.
// Self-signed certificate: public.example and second.example, valid through 2046.
const key = `-----BEGIN EC PRIVATE KEY-----
MHcCAQEEICdApn4y02CulAtm7nnttoQXQygkz/4OqMY9tNm0Ng6CoAoGCCqGSM49
AwEHoUQDQgAEW2GxQsOO4ND9S4Iewp/0ZDlY/LJf+5k7fAOsfyPmRU8fscmjJBgM
ycuPkmY0VHO1KTRJCvZI5Vrpz/FF1wWWYA==
-----END EC PRIVATE KEY-----`
const cert = `-----BEGIN CERTIFICATE-----
MIIB0TCCAXagAwIBAgIJAKpK/+HIlgGbMAoGCCqGSM49BAMCMDsxFzAVBgNVBAMM
DnB1YmxpYy5leGFtcGxlMSAwHgYDVQQKDBdGb3JnZSB0ZXN0IGZpeHR1cmUgb25s
eTAeFw0yNjEwMjUxNjIyNDVaFw00NjEwMjAxNjIyNDVaMDsxFzAVBgNVBAMMDnB1
YmxpYy5leGFtcGxlMSAwHgYDVQQKDBdGb3JnZSB0ZXN0IGZpeHR1cmUgb25seTBZ
MBMGByqGSM49AgEGCCqGSM49AwEHA0IABFthsULDjuDQ/UuCHsKf9GQ5WPyyX/uZ
O3wDrH8j5kVPH7HJoyQYDMnLj5JmNFRztSk0SQr2SOVa6c/xRdcFlmCjYzBhMCkG
A1UdEQQiMCCCDnB1YmxpYy5leGFtcGxlgg5zZWNvbmQuZXhhbXBsZTAPBgNVHRMB
Af8EBTADAQH/MA4GA1UdDwEB/wQEAwIChDATBgNVHSUEDDAKBggrBgEFBQcDATAK
BggqhkjOPQQDAgNJADBGAiEAnBKb1bMZTO1iT+b3qqwJcFX0C+6cF4K+q8hYwa3p
91kCIQD2GCokDq2Qabr2fjegZBay4RlE87Pnn8yBDoQOGloCuA==
-----END CERTIFICATE-----`

async function fixture(opts: { trusted?: boolean; redirect?: string; hold?: boolean } = {}) {
  const names: string[] = []
  const calls: Array<{ path: string; host: string | undefined }> = []
  const pins: string[] = []
  const errors: string[] = []
  const listeners = new Set<() => void>()
  const listening = Promise.withResolvers<number>()
  // Node provides an independent TLS observer; Bun's server SNICallback is not
  // invoked in the tested runtime. Client requests still use the production runtime.
  const child = Bun.spawn(["node", "--input-type=module", "-e", `
    import { createServer } from "node:https";
    import { createSecureContext } from "node:tls";
    const cfg = JSON.parse(process.env.FORGE_TLS_FIXTURE);
    const emit = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
    const context = createSecureContext(cfg);
    const server = createServer({
      key: cfg.key, cert: cfg.cert,
      SNICallback(name, callback) {
        emit({name});
        if (!cfg.hold) callback(null, context);
      },
    }, (req, res) => {
      emit({path: req.url, host: req.headers.host});
      if (req.url === "/start" && cfg.redirect) {
        res.writeHead(302, {Location: cfg.redirect}); res.end(); return;
      }
      res.writeHead(200, {"Content-Type": "text/plain"});
      res.end("verified TLS document");
    });
    server.on("tlsClientError", (err) => emit({error: err.message}));
    server.listen(0, "127.0.0.1", () => emit({port: server.address().port}));
  `], {
    env: { ...process.env, FORGE_TLS_FIXTURE: JSON.stringify({ ...opts, key, cert }) },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  })
  const stderr = new Response(child.stderr).text()
  let buffer = ""
  const reading = (async () => {
    const decoder = new TextDecoder()
    for await (const chunk of child.stdout) {
      buffer += decoder.decode(chunk, { stream: true })
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""
      for (const line of lines) {
        const value = JSON.parse(line) as { port?: number; name?: string; path?: string; host?: string; error?: string }
        if (value.port) listening.resolve(value.port)
        if (value.name) names.push(value.name)
        if (value.path) calls.push({ path: value.path, host: value.host })
        if (value.error) errors.push(value.error)
        for (const notify of listeners) notify()
      }
    }
  })().catch((err) => { listening.reject(err); errors.push(String(err)) })
  void child.exited.then(async (code) => listening.reject(new Error(`TLS fixture exited (${code}): ${await stderr}`)))
  const timer = setTimeout(() => { child.kill(); listening.reject(new Error("TLS fixture startup timed out")) }, 5000)
  const port = await listening.promise.catch(async (err) => {
    child.kill()
    await child.exited
    await reading
    throw err
  }).finally(() => clearTimeout(timer))
  const fetch = downloader({
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    request: (url, options, response) => {
      expect(url.protocol).toBe("https:")
      expect(options).not.toHaveProperty("rejectUnauthorized", false)
      expect(options).not.toHaveProperty("checkServerIdentity")
      expect(options).not.toHaveProperty("servername")
      const target = new URL(url)
      target.port = String(port)
      return request(target, {
        ...options,
        ...(opts.trusted === false ? {} : { ca: cert }),
        headers: { ...options.headers, Host: url.host },
        // Only remap the physical socket. Keep HTTPS, hostname checks, and SNI.
        lookup: (host, opts, callback) => {
          if (!options.lookup) throw new Error("Downloader did not pin DNS")
          options.lookup(host, opts, (err, value) => {
            if (err) { callback(err, "", 4); return }
            pins.push(...(typeof value === "string" ? [value] : value.map((item) => item.address)))
            if (opts.all) { callback(null, [{ address: "127.0.0.1", family: 4 }]); return }
            callback(null, "127.0.0.1", 4)
          })
        },
      }, response)
    },
  })
  return {
    fetch, names, calls, pins, errors,
    async observed(count: number, requests: number) {
      const done = Promise.withResolvers<void>()
      const check = () => { if (names.length >= count && calls.length >= requests) done.resolve() }
      listeners.add(check)
      const timer = setTimeout(() => done.reject(new Error("TLS fixture observations timed out")), 3000)
      try { check(); await done.promise } finally { clearTimeout(timer); listeners.delete(check) }
    },
    async [Symbol.asyncDispose]() {
      child.kill()
      await child.exited
      await reading
    },
  }
}

test("trusted HTTPS preserves original Host, SNI, and checked DNS address", async () => {
  await using f = await fixture()
  const value = await f.fetch("https://public.example/document", AbortSignal.timeout(3000))
  await f.observed(1, 1)
  expect(new TextDecoder().decode(value.bytes)).toBe("verified TLS document")
  expect(f.names).toEqual(["public.example"])
  expect(f.calls).toEqual([{ path: "/document", host: "public.example" }])
  expect(f.pins).toEqual(["93.184.216.34"])
  expect(f.errors).toEqual([])
})

test("an untrusted certificate rejects before any HTTP request is received", async () => {
  await using f = await fixture({ trusted: false })
  await expect(f.fetch("https://public.example/document", AbortSignal.timeout(3000))).rejects.toThrow(/certificate|self.signed/i)
  await f.observed(1, 0)
  expect(f.names).toEqual(["public.example"])
  expect(f.calls).toEqual([])
})

test("a trusted certificate for another hostname is rejected", async () => {
  await using f = await fixture()
  await expect(f.fetch("https://wrong.example/document", AbortSignal.timeout(3000))).rejects.toThrow(/hostname|altname|certificate/i)
  await f.observed(1, 0)
  expect(f.names).toEqual(["wrong.example"])
  expect(f.calls).toEqual([])
})

test("HTTPS redirect establishes a new verified hostname and SNI", async () => {
  await using f = await fixture({ redirect: "https://second.example/final" })
  const value = await f.fetch("https://public.example/start", AbortSignal.timeout(3000))
  await f.observed(2, 2)
  expect(new TextDecoder().decode(value.bytes)).toBe("verified TLS document")
  expect(f.names).toEqual(["public.example", "second.example"])
  expect(f.calls.map((call) => call.host)).toEqual(["public.example", "second.example"])
  expect(f.pins).toEqual(["93.184.216.34", "93.184.216.34"])
})

test("HTTPS redirect cannot reuse trust for a mismatched target identity", async () => {
  await using f = await fixture({ redirect: "https://wrong.example/final" })
  await expect(f.fetch("https://public.example/start", AbortSignal.timeout(3000))).rejects.toThrow(/hostname|altname|certificate/i)
  await f.observed(2, 1)
  expect(f.names).toEqual(["public.example", "wrong.example"])
  expect(f.calls).toEqual([{ path: "/start", host: "public.example" }])
})

test("a real HTTPS response cannot downgrade to HTTP", async () => {
  await using f = await fixture({ redirect: "http://second.example/final" })
  await expect(f.fetch("https://public.example/start", AbortSignal.timeout(3000))).rejects.toThrow("downgrade")
  await f.observed(1, 1)
  expect(f.names).toEqual(["public.example"])
  expect(f.calls).toHaveLength(1)
})

test("cancellation interrupts a stalled TLS handshake before document transmission", async () => {
  const abort = new AbortController()
  await using f = await fixture({ hold: true })
  const result = f.fetch("https://public.example/document", abort.signal)
  try {
    await f.observed(1, 0)
    abort.abort(new Error("Cancelled handshake"))
    await expect(result).rejects.toThrow(/abort|cancel/i)
    expect(f.calls).toEqual([])
  } finally { abort.abort(); await Promise.allSettled([result]) }
})
