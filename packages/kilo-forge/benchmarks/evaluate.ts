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
import { randomUUID } from "node:crypto"
import { Investigation } from "../src/investigation"
import { Prepared, type PreparationBinding } from "../src/writing"
import { metadata as handoff } from "../src/handoff"
import { variants } from "./harness"
import { arms as paired, free, subscription, plugins, order as alternate, tools as forge } from "./ablation"
import type { Task } from "./tasks"

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
  investigation?: { state: string; turns: number; calls: number; findings: number; selected: string[]; words: number }
}

const model = process.env.FORGE_EVAL_MODEL ?? "kilo/openai/gpt-4.1-mini"
const split = model.indexOf("/")
const reference = { providerID: model.slice(0, split), modelID: model.slice(split + 1) }
const allowed = ["read", "edit", "write", "apply_patch", "glob", "grep", "list", "todowrite", ...forge, "forge_investigate", "forge_share", "forge_read_file", "forge_lookup"]

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
  input: { base?: string; password?: string; trials?: number; limit?: number; manifest?: string; investigative?: boolean; tools?: boolean; output?: string; subscription?: boolean; preparation?: boolean; tasks?: Task[] } = {},
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
  const loaded = input.tasks ? { tasks: input.tasks, dataset: dataset(input.tasks) } : await load(input.manifest ?? process.env.FORGE_EVAL_MANIFEST)
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
  const investigative = input.investigative ?? process.env.FORGE_EVAL_INVESTIGATIVE === "1"
  const tools = input.tools ?? process.env.FORGE_EVAL_TOOLS === "1"
  const preparation = input.preparation ?? false
  if (preparation && (tools || investigative)) throw new Error("Preparation-only evaluation requires the three-arm enhancement protocol")
  if (input.subscription && !tools && !preparation) throw new Error("Subscription evaluation requires a tools-only or preparation-only comparison")
  const billing = input.subscription ? "chatgpt-subscription" : "free"
  if (tools && investigative) throw new Error("Tools-only and investigative evaluation cannot be combined")
  const tasks = loaded.tasks.slice(0, limit).map((task) => investigative
    ? { ...task, files: { ...task.files, ".kilo/forge.jsonc": '{"investigation":true,"exclude":[".kilo/**"]}' } }
    : task)
  const metadata = dataset(loaded.tasks.slice(0, limit))
  const baseline = await preflight(tasks)
  const output = input.output
    ? await realpath(input.output)
    : await realpath(await mkdtemp(path.join(tmpdir(), "forge-evaluation-")))
  if (await Bun.file(path.join(output, "results.json")).exists()) throw new Error("Evaluation output already exists")
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
  const configuration = { ...settings, ...(input.subscription ? { plugin: plugins } : {}) }
  const effective = new Map(Object.entries(config))
  const agent = new Map(Object.entries(config.agent?.build ?? {}))
  const differences = [
    ...Object.entries(configuration).filter(([key, value]) => key !== "agent" && !isDeepStrictEqual(effective.get(key), value)).map(([key]) => key),
    ...Object.entries(settings.agent!.build!).filter(([key, value]) => !isDeepStrictEqual(agent.get(key), value)).map(([key]) => `agent.build.${key}`),
  ]
  if (differences.length) {
    throw new Error(`Backend config does not match evaluation model, permissions and limits: ${differences.join(", ")}`)
  }
  if (Object.values(config.mcp ?? {}).some((value) => value.enabled !== false))
    throw new Error("Disable MCP servers for the controlled local baseline")
  const providers = (await client.provider.list({ directory: output }, options)).data
  const selected = providers.all.find((item) => item.id === reference.providerID)?.models[reference.modelID]
  await writeFile(path.join(output, "model.json"), JSON.stringify({
    provider: reference.providerID, id: selected?.id, api: selected?.api, cost: selected?.cost, isFree: selected?.isFree,
  }, null, 2))
  if (tools || preparation) {
    if (input.subscription) subscription(selected, reference.providerID)
    if (!input.subscription) free(selected)
  }
  const pricing = selected?.cost
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
          ["evaluate.ts", "harness.ts", "grading.ts", "tasks.ts", "repositories.ts", "ablation.ts", "free.ts", "chatgpt.ts", "preparation.ts"].map((file) =>
            Bun.file(path.join(import.meta.dir, file)).text(),
          ),
        )
      ).join("\n"),
    ),
    preparation: tools ? null : {
      generic: { model: config.small_model, temperature: input.subscription ? "provider default" : 0.7, retries: input.subscription ? 0 : 3, outputLimit: input.subscription ? 5000 : "provider default" },
      forge: { model: config.small_model, temperature: 0.1, retries: 0, outputLimit: 12000 },
      ...(investigative ? { investigative: { model, turns: 12, calls: 24, retries: 0, outputLimit: 4000, selection: "Select the first non-contradicted finding. Required questions and empty findings are blocked outcomes; no second attempt." } } : {}),
    },
  }
  console.log(`Results: ${output}`)
  const save = async () => {
    const report = {
      version: preparation ? 5 : tools ? 4 : investigative ? 3 : 2,
      started,
      model,
      trials,
      tasks: limit,
      fixture: metadata.hash,
      dataset: metadata,
      configuration,
      pricing,
      arms: tools ? paired : investigative ? variants : arms,
      ...(tools ? { comparison: "tools-only", billing, treatment: [...forge], free: { verified: !input.subscription, model: selected?.id, pricing } } : {}),
      ...(preparation ? { comparison: "preparation-only", billing, treatment: "/forge/enhance with selected repository evidence" } : {}),
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
        ...(tools ? [
          "Both arms receive identical raw prompts, standard coding tools, model and limits. Only the four Forge coding tools differ. No enhancement, investigation, external documentation or embeddings are used.",
          input.subscription
            ? "Direct ChatGPT OAuth uses subscription allowance, not a globally free model. Zero backend input/output/cache rates are required before each attempt. The isolated launcher imports only the OpenAI OAuth credential, never an API key; quota errors stop the run."
            : "Free model status and zero input/output/cache prices are required before each attempt. Advertised rates and reported usage are not a provider invoice.",
          "Tool availability is the treatment; the model chooses whether to use Forge. Zero Forge calls means no observed tool use, not evidence of the tools' efficacy when used.",
        ] : [
        "Generic uses the existing enhancer via /forge/baseline with OAuth-compatible request preparation; the original request remains authoritative.",
        investigative ? "All four arms use the same standard coding tools. Forge tools are disabled during coding to isolate preparation quality. A common excluded .kilo/forge.jsonc enables the workshop in every disposable fixture."
          : preparation ? "All three arms use identical standard coding tools with Forge coding tools disabled. The Forge treatment explicitly invokes /forge/enhance and submits the validated prompt plus cited local context. Repository documentation is available to all arms. No external docs or embeddings."
          : "Forge includes repository preparation, selected evidence, and optional Forge tools; no external docs or embeddings.",
        ]),
        "Per-run end-to-end latency includes setup, preparation and coding, but excludes independent grading and server startup.",
        "Unknown totals are null; reported fields retain measurable lower bounds, not zero-cost claims. Costs are estimates, not invoices.",
        "Zero-only usage is conservatively unknown because the backend may normalize missing provider usage to zero.",
        "Transport observations reconcile retained HTTP attempts, including retries. Legacy, discarded, failed or unconsumed reports block complete token claims; bounded request history is not a durable all-resource ledger.",
        "Preparation cost uses advertised input/output/cache-read rates; its usage schema omits cache-write and reasoning breakdowns.",
        ...(!tools ? [
          "Existing enhancers retain their own temperature, retry and output defaults; coding model, limits and graders are identical.",
          "The generic HTTP deadline bounds the client, but the existing backend does not guarantee cancellation of its provider call.",
        ] : []),
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
      for (const arm of tools ? alternate(index, trial) : order(index, trial, investigative)) {
        if (tools || preparation) {
          const current = (await client.provider.list({ directory: output }, options)).data
          const selected = current.all.find((item) => item.id === reference.providerID)?.models[reference.modelID]
          if (input.subscription) subscription(selected, reference.providerID)
          if (!input.subscription) free(selected)
        }
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
        let binding: PreparationBinding | undefined
        const purposes = tools ? [] : arm === "investigative" ? ["investigate", "investigation-write"] : [arm === "generic" ? "generic-enhance" : "enhance"]
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
          if (!tools && arm !== "normal") {
            row.phase = "preparation"
            since = Date.now()
            await save()
            prompt = await timed(
              async () => {
                const signal = AbortSignal.timeout(arm === "investigative" ? 260000 : 120000)
                if (arm === "generic") {
                  const proposal = await enhance(base, authorization, root, task.prompt, signal)
                  row.prepared = proposal.usage
                  await writeFile(path.join(archive, "proposal.json"), JSON.stringify(proposal, null, 2))
                  if (hash(JSON.stringify(await files(root))) !== initial)
                    throw new Error("Preparation changed project files")
                  return compose(task.prompt, proposal.text)
                }
                if (arm === "investigative") {
                  const record = decode(Investigation, (await client.forge.investigate(
                    { directory: root, key: randomUUID(), text: task.prompt, session: row.session, model: reference }, { ...options, signal },
                  )).data)
                  await writeFile(path.join(archive, "investigation.json"), JSON.stringify(record, null, 2))
                  row.prepared = record.usage
                  row.investigation = { state: record.state, turns: record.turns, calls: record.calls, findings: record.findings.length, selected: [], words: 0 }
                  const selected = record.findings.find((item) => item.support !== "contradicted")
                  if (record.state !== "findings_ready" || !selected) {
                    row.blocked = true
                    throw new Error("Investigation has no selectable direction or needs clarification")
                  }
                  row.investigation.selected = [selected.id]
                  const direction = (await client.forge.chooseDirection({
                    directory: root, key: randomUUID(), investigation: record.id, revision: record.revision,
                    selected: [selected.id], session: row.session,
                  }, { ...options, signal })).data
                  const prepared = decode(Prepared, (await client.forge.writePrompt({
                    directory: root, id: direction.id, revision: direction.revision, key: randomUUID(), session: row.session,
                  }, { ...options, signal })).data)
                  if (prepared.state !== "ready") throw new Error("Investigative writer did not return a ready prompt")
                  row.prepared = { ...prepared.usage, input: record.usage.input + prepared.usage.input, output: record.usage.output + prepared.usage.output, cached: record.usage.cached + prepared.usage.cached, measured: record.usage.measured && prepared.usage.measured }
                  binding = (await client.forge.bindPrompt({
                    directory: root, binding: { id: prepared.id, revision: prepared.revision, hash: prepared.hash },
                    text: prepared.prompt, session: row.session!, model: reference,
                  }, { ...options, signal })).data
                  row.investigation.words = prepared.prompt.trim().split(/\s+/).length
                  await writeFile(path.join(archive, "preparation.json"), JSON.stringify(prepared, null, 2))
                  if (hash(JSON.stringify(await files(root))) !== initial) throw new Error("Preparation changed project files")
                  return prepared.prompt
                }
                const proposal = (
                  await client.forge.enhance(
                    { directory: root, text: task.prompt, session: row.session, model: reference },
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
                  tools: Object.fromEntries(forge.map((key) => [key, !investigative && !preparation && arm === "forge"])),
                  parts: [{ type: "text", text: prompt, ...(binding ? { metadata: handoff(binding) } : {}) }],
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
        // The API defaults to the empty session, not all workspace requests.
        const records: readonly Manifest[] | null = await Promise.all(
          [...new Set(["", row.session ?? ""])].map(async (session) =>
            decode(Schema.Array(Manifest), (await client.forge.requests({ directory: root, session, limit: "100" }, options)).data),
          ),
        )
          .then((groups) => [...new Map(groups.flat().map((record) => [record.id, record])).values()])
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
            purposes,
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
        const unexpected = [
          ...new Set(
            records
              ?.filter(
                (record) =>
                  (record.attempts?.length || record.usage.measured) &&
                  ![...purposes, "coding", "compaction"].includes(record.purpose),
              )
              .map((record) => record.purpose) ?? [],
          ),
        ]
        const extra = records && unexpected.length ? recover(records, root, row.session ?? "", 0, unexpected) : null
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
        if (((tools && arm === "normal") || preparation) && row.tools.some((item) => item.tool.startsWith("forge_"))) {
          row.error ||= "Baseline attempted a Forge tool; comparison is contaminated"
          row.failure = "infrastructure"
        }
        if (tools && arm === "forge" && !row.tools.some((item) => item.tool.startsWith("forge_") && item.status === "completed"))
          row.warnings.push("Forge tools were available but no completed Forge tool use was observed.")
        if ((tools || preparation) && stats.cost > 0) {
          row.error ||= "Free-only evaluation observed nonzero model cost; refusing further attempts"
          row.failure = "infrastructure"
        }
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
          row.tokens != null && priced && matched && (tools || arm === "normal" || row.transport.preparation?.priced === true)
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
