import { cmd } from "@/cli/cmd/cmd"

export const ForgeUsageCommand = cmd({
  command: "forge-usage <url>",
  describe: "export recorded collection embedding attempts from an existing backend (no model calls)",
  builder: (yargs) =>
    yargs
      .positional("url", {
        type: "string",
        demandOption: true,
        describe: "HTTP(S) backend origin; does not start a server",
      })
      .option("directory", { type: "string", default: process.cwd(), describe: "workspace directory on that backend" })
      .option("session", { type: "string", default: "", describe: "exact session scope; empty means workspace scope" })
      .option("max", {
        type: "number",
        default: 1000,
        describe: "maximum exported attempts (1-10000); output discloses truncation",
      })
      .option("after", { type: "string", describe: "resume from an earlier export's next cursor" })
      .option("before", {
        type: "number",
        describe: "preview pruning completed attempts before this Unix-millisecond cutoff",
      })
      .option("keep", {
        type: "number",
        describe: "retain at least the newest admitted attempts (0-1000000); required with --before",
      })
      .option("revision", {
        type: "string",
        describe: "apply a previously returned retention preview revision; requires --confirm DELETE",
      })
      .option("confirm", { type: "string", describe: "explicit DELETE confirmation for --revision; never inferred" })
      .option("timeout", { type: "number", default: 30, describe: "total read deadline in seconds (1-300)" })
      .option("output", {
        type: "string",
        describe: "new JSON file, owner-only and never overwritten; defaults to stdout",
      }),
  handler: async (args) => {
    const controller = new AbortController()
    const stop = () => controller.abort(new Error("Embedding export cancelled"))
    process.once("SIGINT", stop)
    process.once("SIGTERM", stop)
    try {
      if (args.before == null && (args.keep != null || args.revision != null || args.confirm != null))
        throw new Error("Retention options require --before and --keep")
      if (args.before != null && args.after != null)
        throw new Error("Retention cannot be combined with an export cursor")
      const value =
        args.before == null ? await collect(args, controller.signal) : await maintain(args, controller.signal)
      const content = JSON.stringify(value, null, 2) + "\n"
      if (args.output) {
        await save(args.output, content, controller.signal)
        return
      }
      controller.signal.throwIfAborted()
      process.stdout.write(content)
    } finally {
      process.removeListener("SIGINT", stop)
      process.removeListener("SIGTERM", stop)
    }
  },
})

async function connection(
  args: {
    url: string
    directory: string
    session: string
    timeout?: number
  },
  signal?: AbortSignal,
) {
  const url = (() => {
    try {
      return new URL(args.url)
    } catch {
      throw new Error("Invalid backend origin")
    }
  })()
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("Use an HTTP(S) backend origin without credentials, query or path")
  if (url.protocol === "http:" && !["127.0.0.1", "[::1]"].includes(url.hostname))
    throw new Error("Non-loopback backends require HTTPS")
  const timeout = args.timeout ?? 30
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 300)
    throw new Error("Export timeout must be 1-300 seconds")
  if (!args.directory) throw new Error("A backend workspace directory is required")
  const abort = AbortSignal.any([AbortSignal.timeout(timeout * 1000), ...(signal ? [signal] : [])])
  abort.throwIfAborted()
  const { createKiloClient } = await import("@kilocode/sdk/v2")
  const password = process.env.KILO_SERVER_PASSWORD
  const sdk = createKiloClient({
    baseUrl: url.origin,
    headers: password
      ? {
          authorization: `Basic ${Buffer.from(`${process.env.KILO_SERVER_USERNAME ?? "kilo"}:${password}`).toString("base64")}`,
        }
      : {},
    redirect: "error",
  })
  return { sdk, abort }
}

export async function collect(
  args: {
    url: string
    directory: string
    session: string
    max?: number
    after?: string
    timeout?: number
  },
  signal?: AbortSignal,
) {
  const { sdk, abort } = await connection(args, signal)
  const { exportEmbeddings } = await import("@kilocode/forge/embedding-export")
  const value = await exportEmbeddings({
    session: args.session,
    max: args.max,
    after: args.after,
    signal: abort,
    read: async (request, signal) => {
      const result = await sdk.forge.embeddingUsage(
        {
          directory: args.directory,
          session: request.session,
          after: request.after,
          limit: String(request.limit),
        },
        { signal },
      )
      if (!result.response) throw new Error("Embedding usage request failed before response")
      if (result.response.status !== 200)
        throw new Error(`Embedding usage request failed (HTTP ${result.response.status})`)
      return result.data
    },
  })
  return { ...value, directory: args.directory }
}

export async function maintain(
  args: {
    url: string
    directory: string
    session: string
    before?: number
    keep?: number
    revision?: string
    confirm?: string
    timeout?: number
  },
  signal?: AbortSignal,
) {
  if (!Number.isSafeInteger(args.before) || args.before! < 0)
    throw new Error("Retention --before must be a nonnegative Unix-millisecond cutoff")
  if (!Number.isInteger(args.keep) || args.keep! < 0 || args.keep! > 1_000_000)
    throw new Error("Retention --keep must be 0-1000000")
  if (args.revision == null && args.confirm != null)
    throw new Error("DELETE confirmation requires a reviewed --revision")
  if (args.revision != null && (!/^[0-9a-f]{64}$/.test(args.revision) || args.confirm !== "DELETE"))
    throw new Error("Applying retention requires a reviewed --revision and --confirm DELETE")
  const { sdk, abort } = await connection(args, signal)
  const request = { directory: args.directory, session: args.session, before: args.before!, keep: args.keep! }
  const options = { signal: abort, throwOnError: true as const }
  if (args.revision != null) {
    const result = await sdk.forge.embeddingPrune(
      { ...request, revision: args.revision, confirmation: "DELETE" },
      options,
    )
    return { directory: args.directory, session: args.session, ...result.data }
  }
  const result = await sdk.forge.embeddingRetention(request, options)
  return {
    directory: args.directory,
    ...result.data,
    warning:
      "Preview only. Applying requires this revision and --confirm DELETE. Deletes at most 100 completed ledger attempts; preserves pending attempts, originals and job history. Exported copies remain independent. A committed deletion cannot be cancelled.",
  }
}

export async function save(filename: string, content: string, signal?: AbortSignal) {
  const { open, link, rm } = await import("node:fs/promises")
  const path = await import("node:path")
  const { randomUUID } = await import("node:crypto")
  signal?.throwIfAborted()
  const target = path.resolve(filename)
  const temporary = path.join(path.dirname(target), `.forge-usage-${randomUUID()}.tmp`)
  const file = await open(temporary, "wx", 0o600)
  try {
    await file.writeFile(content)
    await file.sync()
    await file.close()
    signal?.throwIfAborted()
    // Linking publishes a complete file atomically and fails for existing files,
    // including symlinks. Never replace the user's previous export.
    await link(temporary, target)
  } finally {
    await file.close()
    await rm(temporary, { force: true })
  }
}
