import { createKiloClient, type AssistantMessage, type Config } from "@kilocode/sdk/v2"
import { mkdir, mkdtemp, realpath, rename, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { files, grade, materialize, preflight } from "./grading"
import { dataset, load } from "./repositories"
import { hash, message } from "../src/util"
import { decode, Proposal, usage, Manifest, RequestObservation } from "../src/schema"
import { Schema } from "effect"
import {
  arms,
  baseline as enhance,
  covered,
  describe,
  failure,
  order,
  prompt as compose,
  recover,
  response,
  timed,
  unavailable,
  type Arm,
  type Failure,
} from "./harness"
import { isDeepStrictEqual } from "node:util"

type Row = {
  task: string
  trial: number
  arm: Arm
  root: string
  session?: string
  initial: string
  success: boolean
  error: string
  blocked: boolean
  state: "running" | "completed"
  failure: Failure | null
  phase: "setup" | "preparation" | "coding" | "grading"
  elapsed: number
  preparation: number
  coding: number
  prepared: ReturnType<typeof usage>
  usage: ReturnType<typeof accounting>
  tokens: number | null
  cost: number | null
  reported: { tokens: number; cost: number }
  known: { preparation: boolean; coding: boolean }
  transport: {
    preparation: ReturnType<typeof recover> | null
    coding: ReturnType<typeof recover> | null
    extra: ReturnType<typeof recover> | null
  }
  observation: {
    initial: RequestObservation | null
    before: RequestObservation | null
    after: RequestObservation | null
    complete: boolean
  }
  models: { preparation: string[]; coding: string[] }
  warnings: string[]
  tools: Array<{ tool: string; status: string }>
  grading: Awaited<ReturnType<typeof grade>> | null
}

const model = process.env.FORGE_EVAL_MODEL ?? "kilo/openai/gpt-4.1-mini"
const split = model.indexOf("/")
const reference = { providerID: model.slice(0, split), modelID: model.slice(split + 1) }
const forge = ["forge_search_code", "forge_search_docs", "forge_get_symbol", "forge_relationships"]
const allowed = ["read", "edit", "write", "apply_patch", "glob", "grep", "list", "todowrite", ...forge]

export const settings: Config = {
  model,
  small_model: model,
  snapshot: false,
  share: "disabled",
  autoupdate: false,
  indexing: { enabled: false },
  lsp: false,
  formatter: false,
  plugin: [],
  permission: {
    "*": "deny",
    ...Object.fromEntries(allowed.map((key) => [key, "allow" as const])),
    bash: { "*": "deny", "bun test*": "allow", "python3 -m unittest*": "allow" },
    external_directory: "deny",
  },
  agent: {
    build: {
      steps: 16,
      temperature: 0,
      prompt:
        "Implement the requested change in this repository. Use the existing local tests at their repository-relative paths. Run bun test --no-install ./path/to/file.test.ts for TypeScript, or python3 -m unittest discover -s path/to/tests -p test_file.py for Python. Run those commands directly in the current directory, without cd, pipes, or redirection. Do not access other directories or the network. Do not delegate work. Do not commit. Finish with a short summary.",
    },
  },
}

function accounting(messages: AssistantMessage[]) {
  return messages.reduce(
    (total, item) => ({
      calls: total.calls + 1,
      input: total.input + item.tokens.input,
      output: total.output + item.tokens.output,
      reasoning: total.reasoning + item.tokens.reasoning,
      cached: total.cached + item.tokens.cache.read,
      written: total.written + item.tokens.cache.write,
      cost: total.cost + item.cost,
    }),
    { calls: 0, input: 0, output: 0, reasoning: 0, cached: 0, written: 0, cost: 0 },
  )
}

function observed(item: AssistantMessage) {
  const value = item.tokens
  // The backend defaults absent usage to zero, including on completed messages.
  return value.input > 0 || value.output > 0 || value.reasoning > 0 || value.cache.read > 0 || value.cache.write > 0
}

export async function evaluate(
  input: { base?: string; password?: string; trials?: number; limit?: number; manifest?: string } = {},
) {
  const base = input.base ?? process.env.FORGE_EVAL_URL
  const password = input.password ?? process.env.FORGE_EVAL_PASSWORD
  if (!base || !password) throw new Error("Set FORGE_EVAL_URL and FORGE_EVAL_PASSWORD for a local source backend")
  const url = new URL(base)
  if (
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("Evaluation requires a loopback backend")
  const loaded = await load(input.manifest ?? process.env.FORGE_EVAL_MANIFEST)
  const trials = input.trials ?? Number(process.env.FORGE_EVAL_TRIALS ?? 2)
  const limit = input.limit ?? Number(process.env.FORGE_EVAL_TASKS ?? loaded.tasks.length)
  if (
    !Number.isInteger(trials) ||
    trials < 1 ||
    trials > 3 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > loaded.tasks.length
  ) {
    throw new Error(`Use 1-3 trials and 1-${loaded.tasks.length} tasks`)
  }
  const tasks = loaded.tasks.slice(0, limit)
  const metadata = dataset(tasks)
  const baseline = await preflight(tasks)
  const output = await realpath(await mkdtemp(path.join(tmpdir(), "forge-evaluation-")))
  const authorization = `Basic ${Buffer.from(`kilo:${password}`).toString("base64")}`
  const client = createKiloClient({
    baseUrl: base,
    headers: { Authorization: authorization },
    fetch: Object.assign(
      async (request: RequestInfo | URL) => {
        const result = await fetch(request, { redirect: "error" })
        if (!result.ok) await response(result)
        return result
      },
      { preconnect: fetch.preconnect },
    ),
  })
  // Use fresh signals for each operation, never one shared timeout for the experiment.
  const options = {
    throwOnError: true as const,
    get signal() {
      return AbortSignal.timeout(15000)
    },
  }
  const config = (await client.config.get({ directory: output }, options)).data
  const effective = new Map(Object.entries(config))
  const agent = new Map(Object.entries(config.agent?.build ?? {}))
  if (
    Object.entries(settings).some(([key, value]) => key !== "agent" && !isDeepStrictEqual(effective.get(key), value)) ||
    Object.entries(settings.agent!.build!).some(([key, value]) => !isDeepStrictEqual(agent.get(key), value))
  ) {
    throw new Error("Backend config does not match evaluation model, permissions and limits")
  }
  if (Object.values(config.mcp ?? {}).some((value) => value.enabled !== false))
    throw new Error("Disable MCP servers for the controlled local baseline")
  const providers = (await client.provider.list({ directory: output }, options)).data
  const pricing = providers.all.find((item) => item.id === reference.providerID)?.models[reference.modelID]?.cost
  if (!pricing) throw new Error("Pinned model is not available")
  const rows: Row[] = []
  const started = new Date().toISOString()
  const cwd = path.resolve(import.meta.dir, "../../..")
  const revision = Bun.spawn(["git", "rev-parse", "HEAD"], { cwd, stdout: "pipe", stderr: "pipe" })
  const dirty = Bun.spawn(["git", "status", "--porcelain"], { cwd, stdout: "pipe", stderr: "pipe" })
  const [commit, status] = await Promise.all([new Response(revision.stdout).text(), new Response(dirty.stdout).text()])
  const provenance = {
    revision: (await revision.exited) === 0 ? commit.trim() : null,
    dirty: (await dirty.exited) === 0 ? Boolean(status.trim()) : null,
    backendRevision: process.env.FORGE_EVAL_BACKEND_REVISION ?? null,
    runtime: Bun.version,
    configuration: hash(JSON.stringify(config)),
    harness: hash(
      (
        await Promise.all(
          ["evaluate.ts", "harness.ts", "grading.ts", "tasks.ts", "repositories.ts"].map((file) =>
            Bun.file(path.join(import.meta.dir, file)).text(),
          ),
        )
      ).join("\n"),
    ),
    preparation: {
      generic: { model: config.small_model, temperature: 0.7, retries: 3, outputLimit: "provider default" },
      forge: { model: config.small_model, temperature: 0.1, retries: 1, outputLimit: 5000 },
    },
  }
  console.log(`Results: ${output}`)
  const save = async () => {
    const report = {
      version: 2,
      started,
      model,
      trials,
      tasks: limit,
      fixture: metadata.hash,
      dataset: metadata,
      configuration: settings,
      pricing,
      arms,
      provenance,
      baseline,
      rows,
      limitations: [
        metadata.kind === "repository-subsets"
          ? "User-supplied pinned local repository subsets, not full repositories or a curated representative dataset. No dependency provisioning is performed."
          : "Four synthetic tasks across two small repository templates, not an independent real-world benchmark.",
        ...(reference.modelID.includes("auto/")
          ? [
              "The selected model is an automatic router. The same route is used for all arms, but the underlying model is not guaranteed to be fixed.",
            ]
          : []),
        "Normal means the same local Kilo build with Forge preparation and Forge tools disabled for that session.",
        "Generic uses the unchanged existing enhancer via /forge/baseline and standard coding tools; the original request remains authoritative.",
        "Forge includes repository preparation, selected evidence, and optional Forge tools; no external docs or embeddings.",
        "Per-run end-to-end latency includes setup, preparation and coding, but excludes independent grading and server startup.",
        "Unknown totals are null; reported fields retain measurable lower bounds, not zero-cost claims. Costs are estimates, not invoices.",
        "Zero-only usage is conservatively unknown because the backend may normalize missing provider usage to zero.",
        "Transport observations reconcile retained HTTP attempts, including retries. Legacy, discarded, failed or unconsumed reports block complete token claims; bounded request history is not a durable all-resource ledger.",
        "Preparation cost uses advertised input/output/cache-read rates; its usage schema omits cache-write and reasoning breakdowns.",
        "Existing enhancers retain their own temperature, retry and output defaults; coding model, limits and graders are identical.",
        "The generic HTTP deadline bounds the client, but the existing backend does not guarantee cancellation of its provider call.",
        "Local revision and dirty state describe the harness checkout, not verified backend identity; backendRevision is operator-supplied.",
        "Separate temporary directories and fresh sessions isolate files and conversation; provider caches may still be shared.",
        "Tool permissions deny external paths, network tools and arbitrary shell commands; this is not full OS-level isolation.",
        "No human clarifications or second attempts are added; unresolved Forge questions count as blocked.",
      ],
    }
    await writeFile(path.join(output, "results.tmp"), JSON.stringify(report, null, 2))
    await rename(path.join(output, "results.tmp"), path.join(output, "results.json"))
  }
  await save()
  for (let trial = 1; trial <= trials; trial++) {
    for (const [index, task] of tasks.entries()) {
      // Counterbalance order across tasks and repetitions to reduce cache/order bias.
      for (const arm of order(index, trial)) {
        const root = await realpath(await mkdtemp(path.join(tmpdir(), "forge-work-")))
        await materialize(root, task.files)
        const initial = hash(JSON.stringify(await files(root)))
        const name = `${task.id}-${trial}-${arm}`
        const archive = path.join(output, name)
        await mkdir(archive)
        const start = performance.now()
        console.log(`START ${name}`)
        const row: Row = {
          task: task.id,
          trial,
          arm,
          root,
          initial,
          success: false,
          error: "",
          blocked: false,
          state: "running",
          failure: "interrupted",
          phase: "setup",
          elapsed: 0,
          preparation: 0,
          coding: 0,
          prepared: usage(model),
          usage: accounting([]),
          tokens: null,
          cost: null,
          reported: { tokens: 0, cost: 0 },
          known: { preparation: arm === "normal", coding: false },
          transport: { preparation: null, coding: null, extra: null },
          observation: { initial: null, before: null, after: null, complete: false },
          models: { preparation: [], coding: [] },
          warnings: [],
          tools: [],
          grading: null,
        }
        rows.push(row)
        await writeFile(path.join(archive, "original.txt"), task.prompt)
        await save()
        let since = 0
        let coded = 0
        let invoked = false
        let reply: AssistantMessage | undefined
        try {
          const created = await client.session.create(
            { directory: root, title: `Evaluation ${name}`, agent: "build" },
            options,
          )
          row.session = created.data.id
          row.observation.initial = decode(
            RequestObservation,
            (await client.forge.requestObservation({ directory: root }, options)).data,
          )
          let prompt = task.prompt
          if (arm !== "normal") {
            row.phase = "preparation"
            since = Date.now()
            await save()
            prompt = await timed(
              async () => {
                const signal = AbortSignal.timeout(120000)
                if (arm === "generic") {
                  const proposal = await enhance(base, authorization, root, task.prompt, signal)
                  row.prepared = proposal.usage
                  await writeFile(path.join(archive, "proposal.json"), JSON.stringify(proposal, null, 2))
                  if (hash(JSON.stringify(await files(root))) !== initial)
                    throw new Error("Preparation changed project files")
                  return compose(task.prompt, proposal.text)
                }
                const proposal = (
                  await client.forge.enhance(
                    { directory: root, text: task.prompt, session: row.session },
                    { ...options, signal },
                  )
                ).data
                decode(Proposal, proposal)
                row.prepared = proposal.usage
                row.warnings.push(...proposal.warnings)
                await writeFile(path.join(archive, "proposal.json"), JSON.stringify(proposal, null, 2))
                if (proposal.original !== task.prompt) throw new Error("Preparation changed the original request")
                if (proposal.status !== "ready" || proposal.task.questions.length) {
                  row.blocked = true
                  throw new Error(`Clarification required: ${proposal.task.questions.join("; ")}`)
                }
                const checked = await client.forge.validate({ ...proposal, directory: root }, { ...options, signal })
                if (!checked.data.valid) throw new Error("Prepared evidence failed freshness validation")
                if (hash(JSON.stringify(await files(root))) !== initial)
                  throw new Error("Preparation changed project files")
                return compose(task.prompt, proposal.prompt, proposal.context.text)
              },
              (value) => {
                row.preparation = value
              },
            )
          }
          await writeFile(path.join(archive, "prompt.txt"), prompt)
          row.phase = "coding"
          row.elapsed = performance.now() - start
          row.reported.tokens = row.prepared.input + row.prepared.output
          await save()
          coded = Date.now()
          invoked = true
          const result = await timed(
            () =>
              client.session.prompt(
                {
                  directory: root,
                  sessionID: row.session!,
                  agent: "build",
                  model: reference,
                  tools: Object.fromEntries(forge.map((key) => [key, arm === "forge"])),
                  parts: [{ type: "text", text: prompt }],
                },
                { ...options, signal: AbortSignal.timeout(240000) },
              ),
            (value) => {
              row.coding = value
            },
          )
          reply = result.data.info
          await writeFile(path.join(archive, "response.json"), JSON.stringify(result.data, null, 2))
          if (result.data.info.error) row.error = JSON.stringify(result.data.info.error)
        } catch (err) {
          row.error = describe(err)
          if (row.session)
            await client.session.abort({ directory: root, sessionID: row.session }, options).catch((err) => {
              row.warnings.push(`Abort unavailable: ${describe(err)}`)
              row.failure = "infrastructure"
            })
        }
        row.elapsed = performance.now() - start
        if (!since) row.known.preparation = true
        const inspect = () =>
          client.forge
            .requestObservation({ directory: root }, options)
            .then((result) => decode(RequestObservation, result.data))
            .catch((err) => {
              row.warnings.push(`Request history observation unavailable: ${describe(err)}`)
              return null
            })
        row.observation.before = await inspect()
        const records: readonly Manifest[] | null = await client.forge
          .requests({ directory: root }, options)
          .then((result) => decode(Schema.Array(Manifest), result.data))
          .catch((err) => {
            row.warnings.push(`Transport usage unavailable: ${describe(err)}`)
            return null
          })
        row.observation.after = await inspect()
        row.observation.complete = covered(
          row.observation.initial,
          row.observation.before,
          row.observation.after,
          records,
          root,
        )
        if (!row.observation.complete)
          row.warnings.push(
            "Request history coverage is incomplete or changed during inspection; retained records are lower bounds.",
          )
        await writeFile(path.join(archive, "requests.json"), JSON.stringify(records, null, 2))
        if (since && records) {
          const recovered = recover(
            records,
            root,
            row.session ?? "",
            since,
            arm === "generic" ? "generic-enhance" : "enhance",
          )
          row.transport.preparation = recovered
          if (
            recovered.records.length &&
            recovered.usage.input + recovered.usage.output >= row.prepared.input + row.prepared.output
          )
            row.prepared = recovered.usage
          row.known.preparation = row.observation.complete && recovered.complete
        }
        const history = row.session
          ? await client.session
              .messages({ directory: root, sessionID: row.session }, options)
              .then((result) => result.data)
              .catch((err) => {
                const error = `Coding history unavailable: ${describe(err)}`
                row.warnings.push(error)
                row.error ||= error
                row.failure = "infrastructure"
                return null
              })
          : null
        await writeFile(path.join(archive, "messages.json"), JSON.stringify(history, null, 2))
        const assistants = (history ?? []).flatMap((item) => (item.info.role === "assistant" ? [item.info] : []))
        // A prompt response is also a history message, not an additional provider call.
        if (reply) {
          const index = assistants.findIndex((item) => item.id === reply.id)
          if (index < 0) assistants.push(reply)
          if (index >= 0 && !observed(assistants.at(index)!) && observed(reply)) {
            const item = assistants.at(index)!
            assistants[index] = { ...item, tokens: reply.tokens, cost: Math.max(item.cost, reply.cost) }
          }
        }
        const stats = accounting(assistants)
        row.usage = stats
        const coding =
          coded && records ? recover(records, root, row.session ?? "", coded, ["coding", "compaction"]) : null
        row.transport.coding = coding
        const purposes = [
          ...new Set(
            records
              ?.filter(
                (record) =>
                  (record.attempts?.length || record.usage.measured) &&
                  ![arm === "generic" ? "generic-enhance" : "enhance", "coding", "compaction"].includes(record.purpose),
              )
              .map((record) => record.purpose) ?? [],
          ),
        ]
        const extra = records && purposes.length ? recover(records, root, row.session ?? "", 0, purposes) : null
        row.transport.extra = extra
        if (extra != null)
          row.warnings.push(
            "Unexpected model transport phase is not reconciled; complete resource totals are unavailable.",
          )
        row.known.coding =
          !invoked ||
          (history != null &&
            !row.error &&
            extra == null &&
            row.observation.complete &&
            coding?.complete === true &&
            coding.usage.input >= stats.input + stats.cached + stats.written &&
            coding.usage.output >= stats.output + stats.reasoning &&
            coding.records.length === assistants.length &&
            assistants.length > 0 &&
            assistants.every((item) => !item.error && item.time.completed != null))
        if (!row.known.preparation)
          row.warnings.push("Preparation usage is incomplete or unavailable; reported amounts are lower bounds.")
        if (!row.known.coding)
          row.warnings.push("Coding usage is incomplete or unavailable; reported amounts are lower bounds.")
        row.tools = (history ?? []).flatMap((item) =>
          item.parts.flatMap((part) =>
            part.type === "tool"
              ? [
                  {
                    tool: part.tool,
                    status: part.state.status,
                  },
                ]
              : [],
          ),
        )
        const prepared = row.prepared
        const priced = !prepared.measured || prepared.model === model
        const rate =
          row.transport.preparation?.priced === true
            ? pricing.input
            : Math.min(pricing.input, pricing.cache.read, pricing.cache.write)
        const cost = !priced
          ? 0
          : (Math.max(0, prepared.input - prepared.cached) * rate +
              prepared.cached * pricing.cache.read +
              prepared.output * pricing.output) /
            1_000_000
        const recorded = stats.input + stats.output + stats.reasoning + stats.cached + stats.written
        const consumed = coding ? coding.usage.input + coding.usage.output : 0
        const tokens =
          Math.max(recorded, consumed) +
          prepared.input +
          prepared.output +
          (extra ? extra.usage.input + extra.usage.output : 0)
        row.reported = { tokens, cost: stats.cost + cost }
        row.tokens = row.known.preparation && row.known.coding ? tokens : null
        // Assistant costs cover exposed final outcomes, not additional HTTP retries.
        const matched = consumed === recorded
        row.cost =
          row.tokens != null && priced && matched && (arm === "normal" || row.transport.preparation?.priced === true)
            ? row.reported.cost
            : null
        row.models = {
          preparation: prepared.measured ? [prepared.model] : [],
          coding: [...new Set(assistants.map((item) => `${item.providerID}/${item.modelID}`))],
        }
        row.failure = row.failure === "infrastructure" ? row.failure : row.error ? failure(row.error) : null
        if (
          row.models.coding.some((value) => value !== model) ||
          row.models.preparation.some((value) => value !== model)
        ) {
          row.error ||= "Observed model differs from the pinned evaluation configuration"
          row.failure = "infrastructure"
        }
        try {
          const patched = await files(root)
          await writeFile(path.join(archive, "files.json"), JSON.stringify(patched, null, 2))
          row.grading = await grade(task, patched)
          if (!row.grading.success) row.failure ??= "workflow"
        } catch (err) {
          row.warnings.push(`Grading unavailable: ${message(err)}`)
          row.failure = "infrastructure"
          row.phase = "grading"
        }
        row.state = "completed"
        row.success = Boolean(row.grading?.success && !row.error && !row.blocked && !row.failure)
        await save()
        console.log(
          `DONE ${name}: ${unavailable(row.failure) ? "UNAVAILABLE" : row.success ? "PASS" : "FAIL"} tokens=${row.tokens ?? "unknown"} seconds=${(row.elapsed / 1000).toFixed(1)} cost=${row.cost?.toFixed(4) ?? "unknown"}${row.error ? ` error=${row.error.slice(0, 180)}` : ""}`,
        )
        for (const warning of row.warnings) console.warn(`${name}: ${warning}`)
        // Avoid continuing to spend on a broken provider or systemic auth problem.
        if (unavailable(row.failure))
          throw new Error(`Provider or infrastructure unavailable; partial report saved at ${output}`)
      }
    }
  }
  await save()
  return output
}

if (import.meta.main) console.log(`Completed: ${await evaluate()}`)
