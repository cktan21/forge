import { Schema } from "effect"
import { decode } from "../src/schema"
import { arms as legacy, variants, failure, unavailable } from "./harness"
import { assess, key as identity } from "./assessment"

const Row = Schema.Struct({
  task: Schema.String,
  trial: Schema.Finite,
  arm: Schema.Literals(variants),
  initial: Schema.String,
  success: Schema.Boolean,
  error: Schema.String,
  warnings: Schema.optional(Schema.Array(Schema.String)),
  blocked: Schema.Boolean,
  elapsed: Schema.Finite,
  preparation: Schema.Finite,
  tokens: Schema.NullOr(Schema.Finite),
  cost: Schema.NullOr(Schema.Finite),
  state: Schema.optional(Schema.Literals(["running", "completed"])),
  failure: Schema.optional(
    Schema.NullOr(Schema.Literals(["auth", "quota", "infrastructure", "workflow", "interrupted"])),
  ),
  known: Schema.optional(Schema.Struct({ preparation: Schema.Boolean, coding: Schema.Boolean })),
  reported: Schema.optional(Schema.Struct({ tokens: Schema.Finite, cost: Schema.Finite })),
  prepared: Schema.Struct({ input: Schema.Finite, output: Schema.Finite }),
  usage: Schema.Struct({ calls: Schema.Finite }),
  tools: Schema.optional(Schema.Array(Schema.Struct({ tool: Schema.String, status: Schema.String }))),
  grading: Schema.NullOr(
    Schema.Struct({
      passed: Schema.Finite,
      total: Schema.Finite,
      regression: Schema.Boolean,
      success: Schema.optional(Schema.Boolean),
      changed: Schema.Array(Schema.String),
    }),
  ),
})
const Report = Schema.Struct({
  version: Schema.optional(Schema.Number),
  billing: Schema.optional(Schema.Literals(["free", "chatgpt-subscription"])),
  arms: Schema.optional(Schema.Array(Schema.Literals(variants))),
  provenance: Schema.optional(Schema.Unknown),
  dataset: Schema.optional(Schema.Unknown),
  started: Schema.String,
  model: Schema.String,
  trials: Schema.Number,
  tasks: Schema.Number,
  fixture: Schema.String,
  limitations: Schema.Array(Schema.String),
  rows: Schema.Array(Row),
})

export function summarize(value: unknown, partial = false, assessments?: unknown) {
  const report = decode(Report, value)
  for (const count of [report.trials, report.tasks]) {
    if (!Number.isSafeInteger(count) || count < 1) throw new Error("Invalid planned task or trial count")
  }
  if (report.version != null && ![1, 2, 3, 4].includes(report.version)) throw new Error("Unsupported report version")
  const dataset =
    report.dataset === undefined
      ? null
      : decode(
          Schema.Struct({
            kind: Schema.Literals(["synthetic", "repository-subsets"]),
            tasks: Schema.Array(
              Schema.Struct({
                id: Schema.String,
                repository: Schema.optional(Schema.String),
                revision: Schema.optional(Schema.String),
                files: Schema.optional(Schema.Array(Schema.String)),
                relevant: Schema.optional(Schema.Array(Schema.String)),
                constraints: Schema.optional(Schema.Array(Schema.String)),
              }),
            ),
          }),
          report.dataset,
        )
  if (
    dataset &&
    (dataset.tasks.length !== report.tasks ||
      new Set(dataset.tasks.map((task) => task.id)).size !== dataset.tasks.length ||
      dataset.tasks.some((task) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(task.id)) ||
      report.rows.some((row) => !dataset.tasks.some((task) => task.id === row.task)))
  )
    throw new Error("Dataset task identities do not match report")
  if (
    dataset?.kind === "repository-subsets" &&
    dataset.tasks.some(
      (task) =>
        !task.repository?.trim() ||
        /[\u0000-\u001f\u007f]/.test(task.repository) ||
        !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(task.revision ?? "") ||
        !task.files?.length ||
        new Set(task.files.map((file) => file.toLowerCase())).size !== task.files.length ||
        task.files.some((file) => file.split("/").some((part) => !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(part))),
    )
  )
    throw new Error("Repository subset provenance requires a repository, full revision and unique selected file paths")
  const expected = report.version === 3 ? variants : report.version === 2 ? legacy : (["normal", "forge"] as const)
  if (report.arms && (report.arms.length !== expected.length || expected.some((arm) => !report.arms!.includes(arm))))
    throw new Error("Report arm declarations do not match its version")
  const observed = report.rows.map((row) => {
    const category = row.state === "running" ? "interrupted" : (row.failure ?? (row.error ? failure(row.error) : null))
    // Historical failed requests sometimes asserted zero usage when none was available.
    const unknown =
      row.state === "running" ||
      (row.known ? !row.known.preparation || !row.known.coding : Boolean(row.error && !row.blocked))
    return {
      ...row,
      failure: category,
      tokens: unknown ? null : row.tokens,
      cost: unknown ? null : row.cost,
      reported: row.reported ?? { tokens: row.tokens ?? 0, cost: row.cost ?? 0 },
    }
  })
  if (!observed.length && !partial) throw new Error("No completed runs to summarize")
  const groups = new Map<string, typeof observed>()
  for (const row of observed) {
    identity(row)
    if (row.trial > report.trials) throw new Error("Trial exceeds planned count")
    const numbers = [
      row.elapsed,
      row.preparation,
      row.tokens,
      row.cost,
      row.reported.tokens,
      row.reported.cost,
      row.prepared.input,
      row.prepared.output,
      row.usage.calls,
      row.grading?.passed,
      row.grading?.total,
    ]
    if (numbers.some((value) => value != null && (!Number.isFinite(value) || value < 0)))
      throw new Error("Report measurements must be finite and nonnegative")
    const grade = row.grading
    if (
      grade &&
      (!Number.isSafeInteger(grade.passed) ||
        !Number.isSafeInteger(grade.total) ||
        grade.total < 1 ||
        grade.passed > grade.total)
    )
      throw new Error("Invalid grading counts: require integer 0 <= passed <= total and positive total")
    const passed = grade != null && grade.passed === grade.total && grade.regression
    if (grade?.success && !passed) throw new Error("Grading success contradicts check counts or regressions")
    // A failed grader process can invalidate otherwise passing checks; legacy grades omit success.
    const success = passed && grade?.success !== false && !row.blocked && !row.error && !row.failure
    if (row.success !== success)
      throw new Error("Report success contradicts grading, blockers, errors or failure state")
    if (!expected.some((arm) => row.arm === arm)) throw new Error("Unexpected report arm")
    if (report.version === 4 && (row.preparation !== 0 || row.prepared.input !== 0 || row.prepared.output !== 0))
      throw new Error("Tools-only comparison must not include prompt preparation")
    if (
      (report.version === 3 || row.arm !== "forge") &&
      row.tools?.some((tool) => tool.tool.startsWith("forge_") && (report.version === 4 || tool.status === "completed"))
    ) {
      throw new Error(`${row.arm === "normal" ? "Normal" : "Generic"} baseline used a Forge tool`)
    }
    const key = JSON.stringify([row.task, row.trial])
    const group = groups.get(key) ?? []
    if (group.some((item) => item.arm === row.arm)) throw new Error("Duplicate arm in comparison")
    if (group.some((item) => item.initial !== row.initial))
      throw new Error("Compared runs started from different files")
    group.push(row)
    groups.set(key, group)
  }
  if (new Set(observed.map((row) => row.task)).size > report.tasks) throw new Error("Tasks exceed planned count")
  const complete = [...groups.values()].filter((group) => group.length === expected.length).flat()
  const unmatched = observed.length - complete.length
  if (unmatched && !partial)
    throw new Error(
      `Only complete ${expected.length === 2 ? "normal/Forge pairs" : expected.length === 3 ? "normal/generic/Forge triples" : "four-arm groups"} can be compared`,
    )
  const rows = [...groups.values()]
    .filter(
      (group) =>
        group.length === expected.length && group.every((row) => !unavailable(row.failure) && row.grading != null),
    )
    .flat()
  const assessment = assess(assessments, observed, rows, expected)
  for (const row of assessment.document?.rows ?? []) {
    const task = dataset?.tasks.find((task) => task.id === row.task)
    const same = (a: readonly string[], b: readonly string[]) =>
      JSON.stringify([...a].sort()) === JSON.stringify([...b].sort())
    if (row.retrieval && task?.relevant && !same(row.retrieval.expected, task.relevant))
      throw new Error("Assessment relevance differs from dataset labels")
    if (
      row.intent &&
      task?.constraints &&
      !same(
        row.intent.constraints.map((item) => item.text),
        task.constraints,
      )
    )
      throw new Error("Assessment intent rubric differs from dataset constraints")
  }
  const arms = expected.map((arm) => {
    const selected = rows.filter((row) => row.arm === arm)
    const sum = (fn: (row: (typeof observed)[number]) => number) => selected.reduce((value, row) => value + fn(row), 0)
    const tokens = selected.some((row) => row.tokens == null) ? null : sum((row) => row.tokens!)
    const cost = selected.some((row) => row.cost == null) ? null : sum((row) => row.cost!)
    return {
      arm,
      runs: selected.length,
      successes: selected.filter((row) => row.success).length,
      unavailable: observed.filter((row) => row.arm === arm && unavailable(row.failure)).length,
      passed: sum((row) => row.grading!.passed),
      checks: sum((row) => row.grading!.total),
      regressions: selected.filter((row) => row.grading!.regression).length,
      seconds: selected.length ? sum((row) => row.elapsed / 1000) / selected.length : null,
      tokens,
      average: tokens != null && selected.length ? tokens / selected.length : null,
      preparation: selected.length ? sum((row) => row.preparation / 1000) / selected.length : null,
      overhead: selected.some(
        (row) => row.known?.preparation === false || (row.arm !== "normal" && !row.known && row.tokens == null),
      )
        ? null
        : sum((row) => row.prepared.input + row.prepared.output),
      calls: sum((row) => row.usage.calls),
      forge: {
        attempted: sum((row) => row.tools?.filter((tool) => tool.tool.startsWith("forge_")).length ?? 0),
        completed: sum((row) => row.tools?.filter((tool) => tool.tool.startsWith("forge_") && tool.status === "completed").length ?? 0),
        runs: selected.filter((row) => row.tools?.some((tool) => tool.tool.startsWith("forge_") && tool.status === "completed")).length,
      },
      cost,
      documents: selected.filter((row) => row.grading!.changed.some((file) => file.startsWith("docs/"))).length,
      tests: selected.filter((row) => row.grading!.changed.some((file) => file.startsWith("tests/"))).length,
      errors: selected.filter((row) => row.error).length,
      blocked: selected.filter((row) => row.blocked).length,
      toolErrors: sum((row) => (row.tools ?? []).filter((tool) => tool.status === "error").length),
      assessment: assessment.arms.find((item) => item.arm === arm)!,
    }
  })
  const metric = (label: string, fn: (arm: (typeof arms)[number]) => string | number | null) =>
    `| ${label} | ${arms.map((arm) => fn(arm) ?? "unknown").join(" | ")} |`
  const units = expected.length === 2 ? "pairs" : expected.length === 3 ? "triples" : "four-arm groups"
  const missing = observed.filter((row) => row.tokens == null || row.cost == null).length
  const pairs = report.version !== 4 ? [] : [...groups.values()]
    .filter((group) => group.length === 2 && group.every((row) => rows.includes(row)))
    .map((group) => ({ normal: group.find((row) => row.arm === "normal")!, forge: group.find((row) => row.arm === "forge")! }))
  const solved = pairs.filter((pair) => pair.normal.success && pair.forge.success)
  const measured = solved.filter((pair) => pair.normal.tokens != null && pair.forge.tokens != null)
  const comparison = report.version !== 4 ? null : {
    pairs: pairs.length,
    wins: pairs.filter((pair) => pair.forge.success && !pair.normal.success).length,
    losses: pairs.filter((pair) => pair.normal.success && !pair.forge.success).length,
    both: solved.length,
    neither: pairs.filter((pair) => !pair.normal.success && !pair.forge.success).length,
    points: pairs.length ? 100 * pairs.reduce((sum, pair) => sum + Number(pair.forge.success) - Number(pair.normal.success), 0) / pairs.length : null,
    seconds: solved.length ? solved.reduce((sum, pair) => sum + (pair.forge.elapsed - pair.normal.elapsed) / 1000, 0) / solved.length : null,
    measured: measured.length,
    tokens: measured.length ? measured.reduce((sum, pair) => sum + pair.forge.tokens! - pair.normal.tokens!, 0) / measured.length : null,
  }
  const text = [
    `# ${expected.length === 2 ? "Forge vs Normal Kilo" : "Normal Kilo vs Generic Enhancer vs Forge"}: Live Coding Evaluation`,
    "",
    `Started: ${report.started}. Model/route: \`${report.model}\`.`,
    "",
    dataset?.kind === "repository-subsets"
      ? "This is an exploratory comparison on selected file subsets from pinned real repositories, as declared by the supplied provenance, not full-repository inputs or a general ranking of coding assistants. The renderer validates minimum provenance fields but does not authenticate repositories, resolve revisions or rehash selected files."
      : dataset?.kind === "synthetic"
        ? "This is a small exploratory end-to-end comparison on synthetic repositories, not a general ranking of coding assistants."
        : "Dataset metadata is absent. Historical harnesses used synthetic repositories; this report cannot establish real-repository provenance or full-repository coverage.",
    `Recorded ${observed.length} of ${report.tasks * report.trials * expected.length} planned attempts. The comparison table uses ${rows.length / expected.length} complete available ${units}. ${unmatched} unmatched attempt(s) are retained below but not included in comparable aggregates.`,
    `All recorded attempts include ${observed.reduce((sum, row) => sum + row.reported.tokens, 0)} reported tokens and $${observed.reduce((sum, row) => sum + row.reported.cost, 0).toFixed(4)} estimated reported charges, including unmatched and unavailable attempts.`,
    `${missing} attempt(s) have unknown token or cost totals. Reported amounts are lower bounds when usage is missing, not zero-cost claims.`,
    `${observed.filter((row) => unavailable(row.failure)).length} attempt(s) were unavailable due to infrastructure, authentication, quota or interruption. Their entire comparison group is excluded from success denominators; unavailable does not mean model failure.`,
    "",
    "## Results",
    "",
    `| Metric | ${expected.map((arm) => (arm === "normal" ? "Normal Kilo" : arm === "generic" ? "Generic Enhancer" : arm === "investigative" ? "Investigative Forge" : "Forge")).join(" | ")} |`,
    `|---|${expected.map(() => "---|").join("")}`,
    metric("Functional successes", (arm) => (arm.runs ? `${arm.successes}/${arm.runs}` : "not available")),
    metric("Independent checks passed", (arm) => (arm.checks ? `${arm.passed}/${arm.checks}` : "not available")),
    metric("Original regression suites passed", (arm) =>
      arm.runs ? `${arm.regressions}/${arm.runs}` : "not available",
    ),
    metric("Average time per attempt (including workflow failures)", (arm) => arm.seconds?.toFixed(1) ?? null),
    metric("Average tokens per attempt", (arm) => arm.average?.toFixed(0) ?? null),
    metric("Total tokens", (arm) => (arm.runs ? arm.tokens : null)),
    metric("Average preparation time (seconds)", (arm) => arm.preparation?.toFixed(1) ?? null),
    metric("Preparation tokens", (arm) => (arm.runs ? arm.overhead : null)),
    metric("Coding assistant turns recorded", (arm) => arm.calls),
    metric("Estimated model charge", (arm) => (arm.runs && arm.cost != null ? `$${arm.cost.toFixed(4)}` : null)),
    metric("Runs changing documentation", (arm) => `${arm.documents}/${arm.runs}`),
    metric("Runs changing tests", (arm) => `${arm.tests}/${arm.runs}`),
    metric("Runs with errors or blockers", (arm) => `${arm.errors}/${arm.runs}`),
    metric("Blocked awaiting clarification", (arm) => arm.blocked),
    metric("Tool calls ending in error", (arm) => arm.toolErrors),
    metric("Unavailable attempts (all recorded)", (arm) => arm.unavailable),
    metric("Retrieval reviewed / eligible runs", (arm) => `${arm.assessment.retrieval.reviewed}/${arm.runs}`),
    metric("Retrieval matched reviewed runs", (arm) => arm.assessment.retrieval.matched),
    metric("Retrieval precision (relevant / retrieved paths)", (arm) => {
      const item = arm.assessment.retrieval
      return item.precision == null ? null : `${item.precision.toFixed(3)} (${item.hits}/${item.retrieved})`
    }),
    metric("Retrieval recall (retrieved / expected relevant paths)", (arm) => {
      const item = arm.assessment.retrieval
      return item.recall == null ? null : `${item.recall.toFixed(3)} (${item.hits}/${item.expected})`
    }),
    metric("Intent reviewed / eligible runs", (arm) => `${arm.assessment.intent.reviewed}/${arm.runs}`),
    metric("Intent matched reviewed runs", (arm) => arm.assessment.intent.matched),
    metric("Intent constraints preserved", (arm) => {
      const item = arm.assessment.intent
      return item.preservation == null ? null : `${item.preservation.toFixed(3)} (${item.passed}/${item.total})`
    }),
    metric("All explicit intent constraints preserved", (arm) => {
      const item = arm.assessment.intent
      return item.preserved == null ? null : `${item.preserved}/${item.matched}`
    }),
    ...(comparison ? [
      "",
      "## Paired Effect",
      "",
      `Available pairs: ${comparison.pairs}. Forge-only successes: ${comparison.wins}; normal-only successes: ${comparison.losses}; both succeeded: ${comparison.both}; neither succeeded: ${comparison.neither}.`,
      `Functional success difference (Forge minus normal): ${comparison.points == null ? "unknown" : `${comparison.points.toFixed(1)} percentage points`}.`,
      `Mean paired time difference on the ${comparison.both} pairs where both succeeded: ${comparison.seconds == null ? "unknown" : `${comparison.seconds.toFixed(1)} seconds`} (negative favors Forge).`,
      `Mean paired token difference on ${comparison.measured} fully measured, jointly successful pairs: ${comparison.tokens == null ? "unknown" : comparison.tokens.toFixed(0)} (negative favors Forge).`,
      "These are descriptive differences. Repeated attempts on the same task are not independent tasks. Failed or incomplete solutions are never treated as efficiency wins.",
      "",
    ] : []),
    "",
    "Retrieval and intent labels are optional external human annotations from archived evidence, not automatically observed paths or model self-scores. Each metric uses only available comparison groups with that metric reviewed for every arm; reviewed counts also expose excluded incomplete annotation groups. Missing assessments are unknown, never zero or pass. Ratios pool path/constraint counts over matched reviewed runs, not independent trials.",
    "Empty observed retrieval has unknown precision and zero recall against nonempty relevant labels. A zero reviewed denominator is unknown. Expected relevant labels and explicit intent rubrics must agree across all assessed repetitions and arms for each task.",
    "No superiority decision is automated. Freeze the prospective protocol and rubric before trials; unknown usage or infrastructure gaps prevent a confirmatory conclusion.",
    "",
    rows.length && arms.every((arm) => arm.successes === arm.runs && arm.tokens != null)
      ? "All comparable attempts solved their tasks. These exploratory measurements do not establish general superiority."
      : "There is no like-for-like completed-solution efficiency comparison because some attempts did not complete the task.",
    "A document/test edit is not evidence of adequate content or coverage.",
    ...(report.version === 4 ? [
      "",
      "## Forge Tool Adoption",
      "",
      "| Arm | Runs using Forge | Attempted Forge calls | Completed Forge calls |",
      "|---|---|---|---|",
      ...arms.map((arm) => `| ${arm.arm} | ${arm.forge.runs}/${arm.runs} | ${arm.forge.attempted} | ${arm.forge.completed} |`),
      "",
      "This measures the effect of making Forge tools available, not forcing their use. No completed Forge calls means this run did not exercise the treatment. Do not infer tool efficacy from non-use.",
      "",
    ] : []),
    "Lower time or token use on blocked/failed attempts is not an efficiency win: those runs may never have reached coding. Existing regressions can pass without implementing the requested feature.",
    "Checks that pass on unchanged code reflect pre-existing behavior, not partial implementation of the new feature.",
    "",
    "## Individual Runs",
    "",
    "| Task | Trial | Arm | Functional result | Hidden checks | Seconds | Tokens |",
    "|---|---|---|---|---|---|---|",
    ...observed.map(
      (row) =>
        `| ${row.task} | ${row.trial} | ${row.arm} | ${unavailable(row.failure) ? "UNAVAILABLE" : row.success ? "PASS" : row.blocked ? "BLOCKED" : "FAIL"}${complete.includes(row) ? (rows.includes(row) ? "" : " (excluded group)") : " (unpaired)"} | ${row.grading ? `${row.grading.passed}/${row.grading.total}` : "not graded"} | ${row.state === "running" ? "incomplete" : (row.elapsed / 1000).toFixed(1)} | ${row.tokens ?? "unknown"} |`,
    ),
    "",
    "## Recorded Blockers",
    "",
    ...observed
      .filter((row) => row.error)
      .map(
        (row) =>
          `- ${row.task}, trial ${row.trial}, ${row.arm} (${row.failure}): ${row.error.includes("PROMOTION_MODEL_LIMIT_REACHED") ? "Anonymous model quota exhausted (HTTP 429). Provider access was unavailable; this is not a coding failure." : row.error.replaceAll("\n", " ").slice(0, 1800)}`,
      ),
    ...(observed.some((row) => row.error) ? [] : ["No runtime errors or clarification blockers were recorded."]),
    "",
    "## Recorded Warnings",
    "",
    ...observed.flatMap((row) =>
      (row.warnings ?? []).map(
        (warning) => `- ${row.task}, trial ${row.trial}, ${row.arm}: ${warning.replaceAll("\n", " ").slice(0, 1800)}`,
      ),
    ),
    ...(observed.some((row) => row.warnings?.length) ? [] : ["No warnings were recorded."]),
    "",
    "## Method",
    "",
    `Recorded ${observed.length} attempts over ${new Set(observed.map((row) => row.task)).size} tasks; ${rows.length} attempts form comparable ${units}. Requested ${report.trials} trial(s) per arm and task. Fixture digest: \`${report.fixture}\`.`,
    "",
    report.version === 4
      ? "Tools-only ablation: both arms receive the exact same raw task, with no prompt enhancement or investigation. Normal disables the four Forge coding tools; Forge enables them. The model chooses which tools to use."
      : expected.length === 4
      ? "Four preparation arms share identical standard coding tools. Investigative Forge records findings, selects the first non-contradicted direction under a predeclared protocol, writes and validates its prompt, and submits structured provenance. Empty findings and required clarifications remain blocked outcomes."
      : expected.length === 3
      ? "Normal uses the raw task and standard Kilo coding tools. Generic uses the unchanged existing enhancer and standard tools. Forge uses its real enhancement endpoint, validates the evidence, then submits the prepared prompt plus cited context with Forge tools available. Enhanced arms preserve the authoritative original request."
      : "Normal uses the raw task and standard Kilo tools. Forge uses preparation, freshness validation and cited context with Forge tools available. This legacy report contains no generic-enhancer arm.",
    report.version === 4
      ? `Both arms use identical initial file hashes, fresh directories/sessions, the same named model, 16 coding steps and a 240-second coding deadline. ${report.billing === "chatgpt-subscription" ? "The isolated ChatGPT launcher uses the existing OAuth subscription allowance, not a free-model promotion or pay-as-you-go API key. Zero backend rates are checked before each attempt; this does not measure remaining subscription quota." : "Free status and zero advertised prices are checked before each attempt."}`
      : report.version === 3
      ? "All arms use identical initial files, fresh sessions, the same requested coding model, 16 coding steps and a 240-second coding deadline. Investigative preparation uses at most 12 turns plus one writer call. All preparation and coding attempts count toward resource totals."
      : "All arms use identical initial file hashes, fresh directories/sessions, the same requested coding model, 16 model steps, a 240-second coding timeout, and identical coding permissions apart from Forge tools. Preparation has a separate 120-second deadline and counts in total latency/tokens.",
    expected.length === 4
      ? "A four-arm Williams square balances position and immediate predecessor over complete blocks. Small or interrupted batches may not be balanced."
      : expected.length === 3
      ? "Order rotates across tasks and trials using all six permutations, balancing each task's positions over three trials. Small or interrupted batches may not be fully balanced."
      : report.version === 4
      ? "Two-arm order alternates by task and reverses each trial. Complete even-sized blocks balance first position; incomplete runs may not be balanced."
      : "The legacy harness alternated two-arm order.",
    "Normal Kilo here means raw prompting under the same restricted evaluation policy, not an unrestricted production session. Recovered tool errors still count toward its elapsed time and tokens.",
    "Hidden checks and reference solutions are never copied into coding workspaces. Grading happens afterward in a separate copy; original public regression tests are restored. The graders were checked against unfixed inputs and reference fixes before model trials.",
    "Restored grader code is trusted local executable input, not a sandbox. Selected repository snapshots may lack dependencies; validate the local runtime and reference/negative controls before any authorized model trial.",
    "Functional success requires every independent behavioral check, the original regressions, and no runtime error. There is no human correction or automatic second attempt.",
    "",
    "## Limits",
    "",
    ...report.limitations.map((item) => `- ${item}`),
    "- No statistical significance is claimed from this small sample. Latency reflects gateway load and may be noisy.",
    "- Recorded assistant turns are not a count of underlying HTTP retries. Fixture copying, independent grading, and backend startup are outside per-attempt timing.",
    report.version === 2 || report.version === 3 || report.version === 4
      ? "- Failed phases retain elapsed time. Interrupted in-flight rows remain explicitly incomplete; unreported usage is unknown."
      : "- Legacy reports did not reliably measure failed-phase duration or missing usage. Zero phase times on failed calls are not evidence of free preparation.",
    "- The test does not measure architecture understanding, opportunity discovery, graph usability, or performance on large production repositories.",
    "",
    "## Provenance",
    "",
    report.provenance
      ? `\`\`\`json\n${JSON.stringify(report.provenance, null, 2)}\n\`\`\``
      : "Legacy report: revision and effective configuration provenance were not recorded.",
    "",
    "## Dataset",
    "",
    dataset ? `\`\`\`json\n${JSON.stringify(report.dataset, null, 2)}\n\`\`\`` : "Dataset metadata not recorded.",
    "",
    "## External Assessments",
    "",
    assessment.document
      ? `Manually annotated from archived evidence. Reviewer identities, artifact digests and protocol reference are supplied by the assessor, not independently verified by this renderer. A protocol reference alone does not prove prospective registration.\n\n\`\`\`json\n${JSON.stringify(assessment.document, null, 2)}\n\`\`\``
      : "No external assessments supplied. Retrieval relevance and intent preservation are unknown.",
    "",
    "## Next Step",
    "",
    "Repeat with an authenticated, explicitly pinned model and unseen real-repository tasks before claiming a general advantage. Deterministic regressions do not establish live coding superiority.",
    "",
  ].join("\n")
  return { arms, text, unmatched, comparison, assessments: assessment.document, dataset: report.dataset ?? null }
}

export function argumentsFor(args: readonly string[]) {
  const positional: string[] = []
  let partial = false
  let assessments: string | undefined
  for (let index = 0; index < args.length; index++) {
    const arg = args.at(index)!
    if (arg === "--partial") {
      if (partial) throw new Error("Duplicate --partial")
      partial = true
      continue
    }
    if (arg === "--assessments") {
      const file = args.at(++index)
      if (assessments || !file?.trim() || file.startsWith("--")) throw new Error("Expected one --assessments file")
      assessments = file
      continue
    }
    if (arg.startsWith("--")) throw new Error(`Unknown option: ${arg}`)
    positional.push(arg)
  }
  if (positional.length !== 2 || positional.some((value) => !value.trim()))
    throw new Error("Usage: bun benchmarks/report.ts results.json report.md [--partial] [--assessments file]")
  return { input: positional.at(0)!, output: positional.at(1)!, partial, assessments }
}

if (import.meta.main) {
  const args = argumentsFor(process.argv.slice(2))
  const report = summarize(
    await Bun.file(args.input).json(),
    args.partial,
    args.assessments ? await Bun.file(args.assessments).json() : undefined,
  )
  const output = args.output
  await Bun.write(output, report.text)
  console.log(JSON.stringify(report.arms, null, 2))
}
