import type { Destination } from "@kilocode/forge/schema"

// Only the runtime fetch present at module initialization can enforce Request.redirect.
// Provider-defined functions can rewrite destinations or ignore that policy.
const native = globalThis.fetch

export function outbound(
  destination: Destination | undefined,
  fetcher: typeof globalThis.fetch,
  input: RequestInfo | URL,
  init?: RequestInit,
) {
  if (!destination?.origins.length) throw new Error("Forge knowledge has no reviewed provider origins. Configure an explicit endpoint and review sharing again.")
  if (fetcher !== native) throw new Error("Forge knowledge cannot use a custom fetch transport. Use a provider with the standard runtime transport.")
  // Snapshot caller-owned URL, headers, and options before asynchronous authorization.
  const url = new URL(input instanceof Request ? input.url : String(input))
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || !destination.origins.includes(url.origin)) {
    throw new Error("Forge knowledge request destination is outside the reviewed provider origins.")
  }
  // Runtime-only knobs must not redirect the connection or relax TLS identity.
  for (const key of ["proxy", "unix", "tls", "connect", "dispatcher", "agent"]) {
    if (init && key in init) throw new Error("Forge knowledge does not support request-specific transport overrides.")
  }
  const request = new Request(input instanceof Request ? input : url.href, { ...init, redirect: "error" })
  if (request.headers.has("host")) {
    throw new Error("Forge knowledge cannot override the destination Host header.")
  }
  return request
}
