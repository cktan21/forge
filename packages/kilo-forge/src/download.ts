import { lookup } from "node:dns/promises"
import type { LookupAddress } from "node:dns"
import { request as http, type ClientRequest, type IncomingMessage, type RequestOptions } from "node:http"
import { request as https } from "node:https"
import { BlockList, isIP } from "node:net"

const blocked = new BlockList()
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(address, prefix, "ipv4")
for (const [address, prefix] of [["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20]] as const) blocked.addSubnet(address, prefix, "ipv6")
const global = new BlockList()
global.addSubnet("2000::", 3, "ipv6")

export function publicAddress(address: string) {
  const family = isIP(address)
  if (family === 4) return !blocked.check(address, "ipv4")
  return family === 6 && global.check(address, "ipv6") && !blocked.check(address, "ipv6")
}

export function downloader(ports: {
  resolve?: (host: string) => Promise<LookupAddress[]>
  request?: (url: URL, options: RequestOptions, response: (value: IncomingMessage) => void) => ClientRequest
} = {}) {
  const resolve = ports.resolve ?? ((host: string) => lookup(host, { all: true }))
  const request = ports.request ?? ((url, options, response) => (url.protocol === "https:" ? https : http)(url, options, response))
  return async (location: string, abort: AbortSignal): Promise<{ bytes: Uint8Array; name: string }> => {
    const signal = AbortSignal.any([abort, AbortSignal.timeout(30_000)])
    async function addresses(host: string) {
      signal.throwIfAborted()
      const family = isIP(host)
      if (family) return [{ address: host, family }]
      const done = Promise.withResolvers<LookupAddress[]>()
      const cancel = () => done.reject(signal.reason)
      signal.addEventListener("abort", cancel, { once: true })
      try {
        void resolve(host).then(done.resolve, done.reject)
        return await done.promise
      } finally { signal.removeEventListener("abort", cancel) }
    }
    async function visit(location: string, redirects = 0): Promise<{ bytes: Uint8Array; name: string }> {
      signal.throwIfAborted()
      const url = new URL(location)
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || (url.port && !["80", "443"].includes(url.port))) throw new Error("Only public HTTP(S) URLs without credentials on standard ports are supported")
      const resolved = await addresses(url.hostname.replace(/^\[|\]$/g, ""))
      if (!resolved.length || resolved.some((item) => !publicAddress(item.address))) throw new Error("URL resolves to a private, local, or reserved address")
      signal.throwIfAborted()
      const address = resolved.at(0)!
      const done = Promise.withResolvers<{ bytes: Uint8Array; name: string } | { location: string }>()
      const req = request(url, {
        agent: false,
        signal,
        headers: { Accept: "text/plain, text/html, text/markdown, application/pdf", "Accept-Encoding": "identity" },
        // Pin the checked address while retaining the original Host and TLS identity.
        lookup: (_host, opts, callback) => {
          if (opts.all) { callback(null, [address]); return }
          callback(null, address.address, address.family)
        },
      }, (response) => {
        response.on("error", done.reject)
        response.on("aborted", () => done.reject(new Error("URL response was interrupted")))
        function reject(text: string) {
          done.reject(new Error(text))
          response.destroy()
        }
        if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
          if (!response.headers.location || redirects >= 3) { reject("URL redirect limit reached"); return }
          done.resolve({ location: response.headers.location })
          response.destroy()
          return
        }
        if (response.statusCode !== 200) { reject(`URL returned HTTP ${response.statusCode}`); return }
        const type = response.headers["content-type"]?.split(";").at(0)?.trim().toLowerCase()
        if (!["text/plain", "text/html", "text/markdown", "application/pdf"].includes(type ?? "")) { reject("URL must return text, HTML, Markdown, or PDF"); return }
        const encoding = response.headers["content-encoding"]?.trim().toLowerCase()
        if (encoding && encoding !== "identity") { reject("Encoded URL responses are not supported"); return }
        const limit = 2 * 1024 * 1024
        if (Number(response.headers["content-length"]) > limit) { reject("URL response exceeds 2 MiB"); return }
        const buffers: Buffer[] = []
        let size = 0
        response.on("data", (chunk: Buffer) => {
          size += chunk.length
          if (size > limit) { reject("URL response exceeds 2 MiB"); return }
          buffers.push(chunk)
        })
        response.on("end", () => done.resolve({ bytes: new Uint8Array(Buffer.concat(buffers)), name: type === "application/pdf" ? "document.pdf" : type === "text/html" ? "document.html" : "document.txt" }))
      })
      req.on("error", done.reject)
      req.end()
      const result = await done.promise
      if ("location" in result) {
        const target = new URL(result.location, url)
        if (url.protocol === "https:" && target.protocol !== "https:") throw new Error("HTTPS downgrade is not allowed")
        return visit(target.href, redirects + 1)
      }
      return result
    }
    return visit(location)
  }
}

export const download = downloader()
