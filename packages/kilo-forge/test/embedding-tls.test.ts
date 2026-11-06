import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:https"
import os from "node:os"
import path from "node:path"

for (const mode of ["trusted", "untrusted", "hostname"] as const) {
  test(`HTTPS embedding transport ${mode} certificate boundary`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "forge-embedding-tls-"))
    const cert = path.join(root, "cert.pem")
    const key = path.join(root, "key.pem")
    const received: { authorization: string | undefined; body: string }[] = []
    const children: ReturnType<typeof Bun.spawn>[] = []
    const timers: ReturnType<typeof setTimeout>[] = []
    let server: ReturnType<typeof createServer> | undefined
    async function run(command: string[], env: Record<string, string | undefined>) {
      const child = Bun.spawn(command, { env, stdout: "pipe", stderr: "pipe" })
      children.push(child)
      const timer = setTimeout(() => child.kill("SIGKILL"), 20_000)
      timers.push(timer)
      const [code, output, errors] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      clearTimeout(timer)
      if (code !== 0) throw new Error(`TLS fixture command exited ${code}: ${errors}`)
      return output
    }
    try {
      await run(
        [
          "openssl",
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-days",
          "1",
          "-config",
          path.join(import.meta.dir, "embedding-tls.cnf"),
          "-extensions",
          mode === "hostname" ? "wrong" : "extensions",
          "-keyout",
          key,
          "-out",
          cert,
        ],
        { ...process.env },
      )
      server = createServer({
        cert: await Bun.file(cert).text(),
        key: await Bun.file(key).text(),
      })
      server.on("request", async (request, response) => {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        received.push({ authorization: request.headers.authorization, body: Buffer.concat(chunks).toString("utf8") })
        response.writeHead(200, { "content-type": "application/json" })
        response.end(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }))
      })
      const ready = Promise.withResolvers<void>()
      server.once("error", ready.reject)
      server.listen(0, "127.0.0.1", () => ready.resolve())
      await ready.promise
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("Missing TLS fixture address")
      const output = await run([process.execPath, path.join(import.meta.dir, "embedding-tls-child.ts")], {
        ...process.env,
        NODE_EXTRA_CA_CERTS: mode === "untrusted" ? undefined : cert,
        // The transport's explicit rejectUnauthorized must override this unsafe
        // process-level setting. Never change it in the parent test process.
        NODE_TLS_REJECT_UNAUTHORIZED: "0",
        SSL_CERT_FILE: undefined,
        SSL_CERT_DIR: undefined,
        FORGE_TEST_ENDPOINT: `https://127.0.0.1:${address.port}/v1/embeddings`,
        FORGE_TEST_ACCEPT: mode === "trusted" ? "1" : "0",
      })
      expect(output.trim()).toBe("TLS transport assertion passed")
      expect(received).toEqual(
        mode === "trusted"
          ? [
              {
                authorization: "Bearer local-tls-test-key",
                body: JSON.stringify({
                  model: "tls-fixture",
                  input: ["TLS exact original"],
                  dimensions: 2,
                  encoding_format: "float",
                }),
              },
            ]
          : [],
      )
    } finally {
      for (const timer of timers) clearTimeout(timer)
      for (const child of children) if (child.exitCode == null) child.kill("SIGKILL")
      await Promise.all(children.map((child) => child.exited))
      if (server) {
        server.closeAllConnections()
        const closed = Promise.withResolvers<void>()
        server.close(() => closed.resolve())
        await closed.promise
      }
      await rm(root, { recursive: true, force: true })
    }
  }, 50_000)
}
