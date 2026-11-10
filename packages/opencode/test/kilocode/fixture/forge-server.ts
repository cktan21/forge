import path from "node:path"
import { createKiloClient } from "@kilocode/sdk/v2"

export async function backend(
  root: string,
  opts: { home: string; endpoint: string; provider?: string; binary?: string },
) {
  const provider = opts.provider ?? "probe"
  const ready = Promise.withResolvers<string>()
  const headers = { Authorization: `Basic ${Buffer.from("kilo:workshop-fixture").toString("base64")}` }
  const proc = Bun.spawn(
    [
      ...(opts.binary
        ? [opts.binary]
        : [process.execPath, "run", "--conditions=node", path.resolve(import.meta.dir, "../../../src/index.ts")]),
      "serve",
      "--hostname",
      "127.0.0.1",
      "--port",
      "0",
    ],
    {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
      env: {
        ...process.env,
        HOME: opts.home,
        KILO_TEST_HOME: opts.home,
        XDG_DATA_HOME: `${opts.home}/data`,
        XDG_STATE_HOME: `${opts.home}/state`,
        XDG_CONFIG_HOME: `${opts.home}/config`,
        XDG_CACHE_HOME: `${opts.home}/cache`,
        KILO_AUTH_CONTENT: "{}",
        KILO_DB: `${opts.home}/kilo.db`,
        KILO_SERVER_PASSWORD: "workshop-fixture",
        KILO_SERVER_USERNAME: "kilo",
        KILO_DISABLE_PROJECT_CONFIG: "1",
        KILO_DISABLE_MODELS_FETCH: "1",
        KILO_DISABLE_DEFAULT_PLUGINS: "1",
        KILO_DISABLE_EXTERNAL_SKILLS: "1",
        KILO_DISABLE_CLAUDE_CODE: "1",
        KILO_DISABLE_AUTOUPDATE: "1",
        KILO_NO_DAEMON: "1",
        KILO_TELEMETRY_LEVEL: "off",
        KILO_CONFIG_CONTENT: JSON.stringify({
          model: `${provider}/test`,
          small_model: `${provider}/test`,
          enabled_providers: [provider],
          snapshot: false,
          formatter: false,
          lsp: false,
          plugin: [],
          indexing: { enabled: false },
          permission: { "*": "allow", bash: "deny", edit: "deny", write: "deny", task: "deny" },
          provider: {
            [provider]: {
              npm: "@ai-sdk/openai-compatible",
              options: { baseURL: opts.endpoint, apiKey: "fixture" },
              models: { test: { name: "Local fixture", tool_call: true, limit: { context: 128000, output: 8000 } } },
            },
          },
        }),
      },
    },
  )
  let output = ""
  const drains = [proc.stdout, proc.stderr].map(async (stream) => {
    for await (const chunk of stream) {
      output = (output + new TextDecoder().decode(chunk)).slice(-20_000)
      const url = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.at(0)
      if (url) ready.resolve(url)
    }
  })
  async function close() {
    if (proc.exitCode == null) proc.kill()
    const timer = setTimeout(() => proc.kill("SIGKILL"), 8000)
    try {
      await proc.exited
      await Promise.all(drains)
    } finally {
      clearTimeout(timer)
    }
  }
  const timer = setTimeout(() => ready.reject(new Error(`Backend readiness deadline: ${output}`)), 30_000)
  try {
    const url = await Promise.race([
      ready.promise,
      proc.exited.then((code) => {
        throw new Error(`Backend exited ${code}: ${output}`)
      }),
    ])
    return {
      url,
      headers,
      proc,
      client: createKiloClient({ baseUrl: url, directory: root, headers }),
      [Symbol.asyncDispose]: close,
    }
  } catch (err) {
    await close()
    throw err
  } finally {
    clearTimeout(timer)
  }
}
