export type Fetch = ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) & {
  preconnect?: typeof globalThis.fetch.preconnect
}

const routes = new WeakMap<object, Readonly<{
  adapter: string
  endpoint: string
  issuer: string
  websocket: boolean
}>>()

// Only the built-in adapter registers its exact function identity. This metadata
// describes routing; final HTTP requests still pass through the transport guard.
export function codex<T extends { fetch: Fetch }>(
  value: T,
  endpoint: string,
  issuer: string,
  websocket: boolean,
) {
  routes.set(value.fetch, Object.freeze({ adapter: "openai-codex-v1", endpoint, issuer, websocket }))
  return value
}

export function route(value: object) {
  return routes.get(value)
}
