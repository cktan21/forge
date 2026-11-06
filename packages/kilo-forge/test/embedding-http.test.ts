import { expect, test } from "bun:test"
import { rejects, throws } from "node:assert/strict"
import { embeddingHttp } from "../src/embedding-http"
import { createServer } from "node:http"

function fixture(respond: (request: Request) => Response | Promise<Response>) {
  const requests: Request[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      requests.push(request)
      return respond(request)
    },
  })
  const options = { endpoint: `${server.url}v1/embeddings`, model: "fixture", dimensions: 2 }
  return { requests, options, server }
}

test("fixed embedding endpoint sends exact inputs and restores provider output order", async () => {
  const received: unknown[] = []
  const server = fixture(async (request) => {
    received.push(await request.json())
    expect(request.headers.get("authorization")).toBe("Bearer secret-value")
    expect(request.headers.get("openai-organization")).toBe("team")
    expect(request.headers.get("openai-project")).toBe("project")
    return Response.json({
      data: [
        { index: 1, embedding: [0, 1] },
        { index: 0, embedding: [1, 0] },
      ],
    })
  })
  try {
    const options = { ...server.options, key: "secret-value", organization: "team", project: "project" }
    const transport = embeddingHttp(options)
    options.endpoint = "https://example.invalid/changed"
    options.model = "changed"
    options.key = "changed"
    expect(await transport.embed(["First original", "Second original"])).toEqual([
      [1, 0],
      [0, 1],
    ])
    expect(received).toEqual([
      {
        model: "fixture",
        input: ["First original", "Second original"],
        dimensions: 2,
        encoding_format: "float",
      },
    ])
    expect(JSON.stringify(transport)).not.toContain("secret-value")
    expect(server.requests).toHaveLength(1)
  } finally {
    await server.server.stop(true)
  }
})

test("routing identity binds endpoint, organization and project but not rotating secrets", () => {
  const options = { endpoint: "https://example.invalid/v1/embeddings", model: "fixture", dimensions: 2, key: "first" }
  const transport = embeddingHttp(options)
  expect(embeddingHttp({ ...options, key: "second" }).target).toEqual(transport.target)
  for (const change of [
    { endpoint: "https://other.invalid/v1/embeddings" },
    { endpoint: "https://example.invalid/other/embeddings" },
    { endpoint: `${options.endpoint}?api-version=next` },
    { authentication: "api-key" as const },
    { organization: "other" },
    { project: "other" },
  ])
    expect(embeddingHttp({ ...options, ...change }).target.fingerprint).not.toBe(transport.target.fingerprint)
  expect(embeddingHttp({ ...options, model: "other" }).target.model).toBe("other")
})

for (const endpoint of [
  "not a url",
  "file:///tmp/embeddings",
  "http://example.com/embeddings",
  "http://localhost/embeddings",
  "https://username:secret@example.com/embed",
  "https://example.com/embed#secret",
  "https://example.com/embed?key=secret",
  "https://example.com/embed?route=https://other.example",
]) {
  test(`rejects unsafe embedding endpoint ${endpoint.split("?").at(0)}`, () => {
    throws(() => embeddingHttp({ endpoint, model: "fixture", dimensions: 2 }))
  })
}

for (const status of [301, 302, 303, 307, 308]) {
  test(`HTTP ${status} cannot forward originals or credentials to another endpoint`, async () => {
    const sink = fixture(() => Response.json({ data: [{ index: 0, embedding: [1, 0] }] }))
    const source = fixture(() => new Response(null, { status, headers: { location: sink.options.endpoint } }))
    try {
      await rejects(
        embeddingHttp({ ...source.options, key: "secret" }).embed(["private-original"]),
        /redirects are not permitted/,
      )
      expect(source.requests).toHaveLength(1)
      expect(sink.requests).toHaveLength(0)
    } finally {
      await source.server.stop(true)
      await sink.server.stop(true)
    }
  })
}

for (const body of [
  "{invalid json secret-original",
  JSON.stringify({ error: "secret-original" }),
  JSON.stringify({ data: [{ index: 0, embedding: [0, 0] }] }),
  JSON.stringify({ data: [{ index: 0, embedding: [1] }] }),
  JSON.stringify({ data: [{ index: 1, embedding: [1, 0] }] }),
  JSON.stringify({ data: [{ index: -1, embedding: [1, 0] }] }),
  JSON.stringify({ data: [{ index: 0, embedding: [null, 1] }] }),
  JSON.stringify({ data: [{ index: 0, embedding: "base64" }] }),
]) {
  test("invalid embedding response fails without echoing provider content", async () => {
    const server = fixture(() => new Response(body))
    try {
      const result = await embeddingHttp(server.options)
        .embed(["secret-original"])
        .then(
          () => undefined,
          (err: unknown) => err,
        )
      expect(result).toBeInstanceOf(Error)
      expect(String(result)).not.toContain("secret-original")
      expect(server.requests).toHaveLength(1)
    } finally {
      await server.server.stop(true)
    }
  })
}

test("duplicate vector indices cannot silently bind another input's original", async () => {
  const server = fixture(() =>
    Response.json({
      data: [
        { index: 0, embedding: [1, 0] },
        { index: 0, embedding: [0, 1] },
      ],
    }),
  )
  try {
    await rejects(embeddingHttp(server.options).embed(["first", "second"]), /does not match/)
  } finally {
    await server.server.stop(true)
  }
})

test("HTTP failures have bounded diagnostics and do not automatically retry", async () => {
  const server = fixture(() => new Response("secret-original secret-key", { status: 429 }))
  try {
    await rejects(embeddingHttp(server.options).embed(["secret-original"]), {
      message: "Embedding endpoint returned HTTP 429",
    })
    expect(server.requests).toHaveLength(1)
  } finally {
    await server.server.stop(true)
  }
})

test("input limits and pre-aborted requests perform no network send", async () => {
  const server = fixture(() => new Response("unexpected"))
  try {
    const transport = embeddingHttp(server.options)
    expect(await transport.embed([])).toEqual([])
    await rejects(transport.embed([""]), /nonempty/)
    await rejects(transport.embed(Array.from({ length: 129 }, () => "item")), /1-128/)
    await rejects(transport.embed(["a".repeat(16 * 1024 * 1024)]), /exceeds/)
    const reason = new Error("Task cancelled")
    await rejects(transport.embed(["private"], AbortSignal.abort(reason)), (err) => err === reason)
    expect(server.requests).toHaveLength(0)
  } finally {
    await server.server.stop(true)
  }
})

test("oversized advertised response is rejected without waiting for its body", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-length": String(17 * 1024 * 1024) })
    response.flushHeaders()
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Missing fixture port")
    await rejects(
      embeddingHttp({
        endpoint: `http://127.0.0.1:${address.port}/embeddings`,
        model: "fixture",
        dimensions: 2,
      }).embed(["original"]),
      /exceeds/,
    )
  } finally {
    server.closeAllConnections()
    server.close()
  }
})

for (const mode of ["stream", "compression"] as const) {
  test(`response ${mode} limits reject before JSON admission`, async () => {
    const server = fixture(() => {
      if (mode === "compression") return new Response("compressed", { headers: { "content-encoding": "gzip" } })
      return new Response(
        new ReadableStream({
          start(controller) {
            for (let index = 0; index < 17; index++) controller.enqueue(new Uint8Array(1024 * 1024))
            controller.close()
          },
        }),
      )
    })
    try {
      await rejects(
        embeddingHttp(server.options).embed(["original"]),
        mode === "compression" ? /Compressed/ : /exceeds/,
      )
    } finally {
      await server.server.stop(true)
    }
  })
}

test("held response cancellation releases transport and another request before server release", async () => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let calls = 0
  const server = fixture(async () => {
    if (++calls === 1) {
      entered.resolve()
      await release.promise
    }
    return Response.json({ data: [{ index: 0, embedding: [1, 0] }] })
  })
  try {
    const transport = embeddingHttp(server.options)
    const controller = new AbortController()
    const reason = new Error("Stopped")
    const pending = transport.embed(["held"], controller.signal)
    const outcome = pending.then(
      () => undefined,
      (err: unknown) => err,
    )
    await entered.promise
    controller.abort(reason)
    expect(await outcome).toBe(reason)
    expect(await transport.embed(["fresh"])).toEqual([[1, 0]])
    expect(calls).toBe(2)
  } finally {
    release.resolve()
    await server.server.stop(true)
  }
})

test("total request timeout covers a held response body", async () => {
  const release = Promise.withResolvers<void>()
  const server = fixture(
    () =>
      new Response(
        new ReadableStream({
          async start(controller) {
            controller.enqueue(new TextEncoder().encode('{"data":'))
            await release.promise
            controller.close()
          },
        }),
      ),
  )
  try {
    await rejects(embeddingHttp({ ...server.options, timeout: 50 }).embed(["original"]), /timed out/)
  } finally {
    release.resolve()
    await server.server.stop(true)
  }
})

test("cancelling a streaming response closes the actual HTTP connection", async () => {
  const entered = Promise.withResolvers<void>()
  const closed = Promise.withResolvers<void>()
  const server = createServer((request, response) => {
    request.socket.once("close", () => closed.resolve())
    response.writeHead(200, { "content-type": "application/json" })
    response.write('{"data":')
    entered.resolve()
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Missing fixture port")
    const controller = new AbortController()
    const reason = new Error("Streaming request stopped")
    const pending = embeddingHttp({
      endpoint: `http://127.0.0.1:${address.port}/embeddings`,
      model: "fixture",
      dimensions: 2,
    }).embed(["original"], controller.signal)
    const outcome = pending.then(
      () => undefined,
      (err: unknown) => err,
    )
    await entered.promise
    controller.abort(reason)
    expect(await outcome).toBe(reason)
    await closed.promise
  } finally {
    server.closeAllConnections()
    server.close()
  }
})

test("invalid headers report no secret value", () => {
  throws(
    () =>
      embeddingHttp({
        endpoint: "https://example.invalid/embeddings",
        model: "fixture",
        dimensions: 2,
        key: "secret\r\ninjected",
      }),
    { message: "Invalid embedding header value" },
  )
})

test("proxy environment cannot reroute an approved embedding endpoint", async () => {
  const proxy = fixture(() => new Response("Unexpected proxy", { status: 502 }))
  const endpoint = fixture(() => Response.json({ data: [{ index: 0, embedding: [1, 0] }] }))
  try {
    const child = Bun.spawn(
      [
        process.execPath,
        "--eval",
        `
      const { embeddingHttp } = await import(${JSON.stringify(new URL("../src/embedding-http.ts", import.meta.url).href)});
      const transport = embeddingHttp({ endpoint: process.env.TEST_ENDPOINT, model: "fixture", dimensions: 2 });
      const vectors = await transport.embed(["approved original"]);
      if (JSON.stringify(vectors) !== "[[1,0]]") process.exit(1);
    `,
      ],
      {
        env: {
          ...process.env,
          TEST_ENDPOINT: endpoint.options.endpoint,
          HTTP_PROXY: proxy.server.url.href,
          HTTPS_PROXY: proxy.server.url.href,
          ALL_PROXY: proxy.server.url.href,
          http_proxy: proxy.server.url.href,
          https_proxy: proxy.server.url.href,
          all_proxy: proxy.server.url.href,
          NO_PROXY: "",
          no_proxy: "",
          NODE_USE_ENV_PROXY: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [code, errors] = await Promise.all([child.exited, new Response(child.stderr).text()])
    expect(errors).toBe("")
    expect(code).toBe(0)
    expect(endpoint.requests).toHaveLength(1)
    expect(proxy.requests).toHaveLength(0)
  } finally {
    await endpoint.server.stop(true)
    await proxy.server.stop(true)
  }
})

test("API-key authentication never adds a second bearer header", async () => {
  const server = fixture((request) => {
    expect(request.headers.get("api-key")).toBe("credential")
    expect(request.headers.has("authorization")).toBe(false)
    return Response.json({ data: [{ index: 0, embedding: [1, 0] }] })
  })
  try {
    expect(
      await embeddingHttp({ ...server.options, authentication: "api-key", key: "credential" }).embed(["original"]),
    ).toEqual([[1, 0]])
  } finally {
    await server.server.stop(true)
  }
})
