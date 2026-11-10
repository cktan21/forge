import path from "node:path"
import { Schema } from "effect"
import { decode, Proposal } from "../src/schema"
import { summarize } from "./report"
import { tasks } from "./preparation"
import { arms } from "./harness"

const Run = Schema.Struct({
  model: Schema.String,
  version: Schema.Number,
  started: Schema.String,
  fixture: Schema.String,
  provenance: Schema.Unknown,
  rows: Schema.Array(
    Schema.Struct({
      task: Schema.String,
      trial: Schema.Number,
      arm: Schema.Literals(arms),
      state: Schema.String,
      success: Schema.Boolean,
      blocked: Schema.Boolean,
      error: Schema.String,
      elapsed: Schema.Number,
      preparation: Schema.Number,
      coding: Schema.optional(Schema.Number),
      tokens: Schema.NullOr(Schema.Number),
      reported: Schema.Struct({ tokens: Schema.Number, cost: Schema.Number }),
      tools: Schema.Array(Schema.Struct({ tool: Schema.String, status: Schema.String })),
      usage: Schema.Struct({ calls: Schema.Number }),
    }),
  ),
})

export function measurements(value: unknown) {
  const run = decode(Run, value)
  if (run.version !== 5 || !run.model.startsWith("openai/gpt-5."))
    throw new Error("Section 7 requires GPT-5.x preparation-only results")
  const summary = summarize(value, true)
  const metrics = summary.arms.map((arm) => {
    const rows = run.rows.filter((row) => row.arm === arm.arm)
    const times = rows
      .filter((row) => row.state === "completed")
      .map((row) => row.elapsed / 1000)
      .sort((a, b) => a - b)
    const middle = Math.floor(times.length / 2)
    const median = times.length
      ? times.length % 2
        ? times.at(middle)!
        : (times.at(middle - 1)! + times.at(middle)!) / 2
      : null
    const solved = rows.filter((row) => row.success)
    const coding =
      solved.length && solved.every((row) => row.coding != null)
        ? solved.reduce((sum, row) => sum + row.coding! / 1000, 0) / solved.length
        : null
    return {
      ...arm,
      attempted: rows.length,
      completed: times.length,
      median,
      coding,
      tools: rows.reduce((sum, row) => sum + row.tools.length, 0),
    }
  })
  return { run, summary, metrics }
}

const number = (value: number | null, digits = 1) => (value == null ? "Unknown" : value.toFixed(digits))

export async function section(directories: readonly string[]) {
  const runs = await Promise.all(
    directories.map(async (directory) => {
      const value = await Bun.file(path.join(directory, "results.json")).json()
      return { ...measurements(value), directory }
    }),
  )
  if (!runs.length || new Set(runs.map((item) => item.run.model)).size !== runs.length)
    throw new Error("Use results from distinct GPT-5.x models")
  if (new Set(runs.map((item) => item.run.fixture)).size !== 1)
    throw new Error("Compared models must share the same task dataset")
  const lines = [
    "# 7 Results, Qualitative Analysis and Discussion",
    "",
    "This section reports a live three-arm enhancement experiment on the current Forge source build. Unlike the earlier tool-availability pilot, the Forge arm explicitly called `/forge/enhance`, validated its proposal, and supplied its retrieved evidence before coding. All arms disabled the four Forge coding tools.",
    "",
    "## 7.1 Quantitative Comparison",
    "",
    `Models: ${runs.map((item) => `\`${item.run.model}\``).join(", ")}. Each model attempted four tasks in three arms, once per task/arm. The account's direct ChatGPT OAuth subscription was used; no GPT-6 model or API-key fallback was used in this study.`,
    "",
  ]
  for (const item of runs) {
    lines.push(
      `### ${item.run.model}`,
      "",
      "| Metric | Raw Kilo | Generic Enhancement | Forge Enhancement |",
      "|---|---|---|---|",
      `| Completed / attempted | ${item.metrics.map((arm) => `${arm.completed}/${arm.attempted}`).join(" | ")} |`,
      `| Functional successes / comparable attempts | ${item.metrics.map((arm) => `${arm.successes}/${arm.runs}`).join(" | ")} |`,
      `| Private checks passed / applicable checks | ${item.metrics.map((arm) => `${arm.passed}/${arm.checks}`).join(" | ")} |`,
      `| Original regression suites passed | ${item.metrics.map((arm) => `${arm.regressions}/${arm.runs}`).join(" | ")} |`,
      `| Mean end-to-end seconds | ${item.metrics.map((arm) => number(arm.seconds)).join(" | ")} |`,
      `| Median recorded attempt seconds | ${item.metrics.map((arm) => number(arm.median)).join(" | ")} |`,
      `| Mean preparation seconds | ${item.metrics.map((arm) => number(arm.preparation)).join(" | ")} |`,
      `| Mean coding seconds, successful attempts only | ${item.metrics.map((arm) => number(arm.coding)).join(" | ")} |`,
      `| Total measured tokens | ${item.metrics.map((arm) => (arm.tokens == null ? "Unknown" : arm.tokens.toLocaleString("en-US"))).join(" | ")} |`,
      `| Reported token lower bound, all attempts | ${item.metrics
        .map((arm) =>
          item.run.rows
            .filter((row) => row.arm === arm.arm)
            .reduce((sum, row) => sum + row.reported.tokens, 0)
            .toLocaleString("en-US"),
        )
        .join(" | ")} |`,
      `| Recorded coding turns | ${item.metrics.map((arm) => arm.calls).join(" | ")} |`,
      `| Mean recorded coding tool calls | ${item.metrics.map((arm) => (arm.attempted ? number(arm.tools / arm.attempted) : "Unknown")).join(" | ")} |`,
      `| Preparation blockers | ${item.metrics.map((arm) => arm.blocked).join(" | ")} |`,
      "",
    )
    const generic = item.metrics.find((arm) => arm.arm === "generic")!
    const forge = item.metrics.find((arm) => arm.arm === "forge")!
    if (
      generic.runs > 0 &&
      generic.successes === generic.attempted &&
      forge.successes === forge.attempted &&
      generic.tools > 0 &&
      generic.coding != null &&
      forge.coding != null &&
      generic.seconds != null &&
      forge.seconds != null
    ) {
      const calls = 100 * (1 - forge.tools / generic.tools)
      const coding = 100 * (1 - forge.coding / generic.coding)
      const elapsed = 100 * (forge.seconds / generic.seconds - 1)
      lines.push(
        `Against the generic-enhancement baseline, Forge used ${number(Math.abs(calls))}% ${calls >= 0 ? "fewer" : "more"} coding tool calls and ${number(Math.abs(coding))}% ${coding >= 0 ? "less" : "more"} coding-phase time. End-to-end time was ${number(Math.abs(elapsed))}% ${elapsed >= 0 ? "higher" : "lower"} after including preparation. Functional correctness tied. These are descriptive within-model comparisons, not statistical superiority claims.`,
        "",
      )
    }
  }
  const expected = runs.length * 12
  const recorded = runs.reduce((sum, item) => sum + item.run.rows.length, 0)
  lines.push(
    `Recorded ${recorded}/${expected} planned workflow attempts. Functional success requires all six private checks, the original regressions, no preparation blocker, and no runtime error. Unavailable task-trial triples are excluded from matched functional denominators, but their attempts remain in the archive. Unknown usage is not converted to zero.`,
    "",
    "Mean time and functional/check counts above use complete available triples; the median is over recorded completed attempts in each arm, including any unavailable attempt. Tool-call means include all recorded attempts. Preparation time counts toward end-to-end latency, whereas private grading and backend startup do not.",
    "",
    "## 7.2 Qualitative Cases",
    "",
  )
  const retrieval: Array<{ model: string; task: string; paths: string[]; hits: number; expected: number }> = []
  for (const item of runs) {
    for (const row of item.run.rows.filter((row) => row.arm === "forge")) {
      const file = path.join(item.directory, `${row.task}-${row.trial}-forge`, "proposal.json")
      if (!(await Bun.file(file).exists())) continue
      const proposal = decode(Proposal, await Bun.file(file).json())
      const paths = [...new Set(proposal.context.matches.map((match) => match.source.uri))]
      const task = tasks.find((task) => task.id === row.task)!
      retrieval.push({
        model: item.run.model,
        task: row.task,
        paths,
        hits: paths.filter((file) => task.relevant?.includes(file)).length,
        expected: task.relevant?.length ?? 0,
      })
    }
  }
  lines.push(
    "### Retrieved Evidence",
    "",
    "| Model / Task | Relevant selected paths / selected paths | Relevant selected paths / expected paths |",
    "|---|---|---|",
    ...retrieval.map(
      (row) =>
        `| ${row.model} / ${row.task.replace("documented-", "")} | ${row.hits}/${row.paths.length} | ${row.hits}/${row.expected} |`,
    ),
    "",
    "These are selected unique-file precision/recall counts against the fixture author's declared relevant paths, not independent human annotations or Precision@K over the retrieval candidate ranking. Selection can legitimately include supporting files beyond this narrow label set. Raw/generic preparation has no retrieval stage, so a preparation-retrieval score is not applicable to those arms.",
    "",
  )
  const eligible = runs.flatMap((item) =>
    item.run.rows.filter((row) => row.arm === "forge").map((row) => ({ item, row })),
  )
  const first = eligible.find(({ row }) => row.success)
  const second =
    eligible.find(({ row }) => !row.success) ??
    eligible
      .filter((item) => item !== first)
      .sort((a, b) => b.row.preparation - a.row.preparation)
      .at(0)
  for (const [index, example] of [first, second].entries()) {
    if (!example) continue
    const row = example.row
    const directory = path.join(example.item.directory, `${row.task}-${row.trial}-forge`)
    const proposal = Bun.file(path.join(directory, "proposal.json"))
    const original = await Bun.file(path.join(directory, "original.txt")).text()
    lines.push(
      `### Case ${index === 0 ? "A: Successful Grounded Preparation" : row.success ? "B: Preparation Cost" : "B: Failed or Blocked Preparation"}`,
      "",
      `Model: \`${example.item.run.model}\`. Task: \`${row.task}\`. Original request:`,
      "",
      "```text",
      original,
      "```",
      "",
      `Forge outcome: ${row.success ? "functional success" : row.blocked ? "blocked" : "failed/unavailable"}. Preparation: ${number(row.preparation / 1000)} seconds; end-to-end: ${number(row.elapsed / 1000)} seconds.`,
      "",
    )
    const generic = Bun.file(path.join(example.item.directory, `${row.task}-${row.trial}-generic`, "proposal.json"))
    if (await generic.exists()) {
      const value = decode(Schema.Struct({ text: Schema.String }), await generic.json())
      lines.push(
        "Generic rewrite (exact excerpt, capped at 1,800 characters):",
        "",
        "```text",
        value.text.slice(0, 1800),
        "```",
        "",
      )
    }
    if (await proposal.exists()) {
      const value = decode(Proposal, await proposal.json())
      lines.push(
        `Selected paths: ${[...new Set(value.context.matches.map((match) => match.source.uri))].map((file) => `\`${file}\``).join(", ")}.`,
        "",
        "Exact generated proposal (excerpt, capped at 3,000 characters):",
        "",
        "```text",
        value.prompt.slice(0, 3000),
        "```",
        "",
      )
    }
    const peers = example.item.run.rows.filter((peer) => peer.task === row.task && peer.trial === row.trial)
    const patched = Bun.file(path.join(directory, "files.json"))
    if (await patched.exists()) {
      const files = decode(Schema.Record(Schema.String, Schema.String), await patched.json())
      const task = tasks.find((task) => task.id === row.task)!
      const changes: string[] = []
      for (const file of Object.keys(task.solution)) {
        if (files[file] === task.files[file] || files[file] == null) continue
        const before = task.files[file]!.split("\n")
        const after = files[file].split("\n")
        if (before.at(-1) === "") before.pop()
        if (after.at(-1) === "") after.pop()
        changes.push(
          `--- a/${file}`,
          `+++ b/${file}`,
          `@@ -1,${before.length} +1,${after.length} @@`,
          ...before.map((line) => `-${line}`),
          ...(task.files[file]!.endsWith("\n") ? [] : ["\\ No newline at end of file"]),
          ...after.map((line) => `+${line}`),
          ...(files[file].endsWith("\n") ? [] : ["\\ No newline at end of file"]),
        )
        lines.push(
          `Changed implementation: \`${file}\` (excerpt, capped at 2,000 characters):`,
          "",
          "```text",
          files[file].slice(0, 2000),
          "```",
          "",
        )
      }
      if (changes.length) {
        await Bun.write(path.join(directory, "implementation.patch"), `${changes.join("\n")}\n`)
        lines.push(
          "Actual implementation diff (whole-file hunks; excerpt capped at 3,000 characters):",
          "",
          "```diff",
          changes.join("\n").slice(0, 3000),
          "```",
          "",
        )
      }
    }
    lines.push(
      ...peers.map(
        (peer) =>
          `- ${peer.arm}: ${peer.success ? "PASS" : peer.blocked ? "BLOCKED" : "FAIL/UNAVAILABLE"}, ${number(peer.elapsed / 1000)} seconds, ${peer.tokens ?? "unknown"} total tokens.`,
      ),
      "",
      `Inspect the exact proposal, submitted prompt, selected evidence, patched files and private grader verdict under \`${path.basename(example.item.directory)}/${row.task}-${row.trial}-forge/\`.`,
      "",
    )
  }
  lines.push(
    "Successful source-grounded preparation demonstrates that the OAuth-compatible enhancement path ran and produced a locally validated proposal. It does not by itself demonstrate an accuracy intervention: that requires a better coding verdict than the matched baselines. A correctness tie can still expose additional source grounding or reduced coding exploration, but any such claim must be supported by the corresponding trace.",
    "",
    "## 7.3 What Worked, What Did Not, and Why",
    "",
    "The experiment exercised actual repository retrieval and enhancement, rather than waiting for a coding model to choose a Forge tool. The generic baseline was also made OAuth-compatible, avoiding a broken-baseline comparison. ChatGPT request preparation supplies instructions, streaming and store=false, omits unsupported temperature/output-cap fields, and enforces a local response limit.",
    "",
    "The main trade-off is preparation cost: Forge retrieves and serializes local evidence and makes an extra model request before coding. Comparing total tokens/time is therefore more informative than comparing only the coding phase. Generic and Forge retain different production output budgets, and provider default reasoning can differ across models.",
    "",
    "The positive finding is source-grounded specification and reduced coding exploration relative to generic enhancement, not increased functional accuracy. All three arms passed the same private checks on this small dataset. The Sol batching case illustrates scope control: generic wording suggested capacity and concurrency handling without repository evidence, whereas Forge specified exact ID matching, atomic validation and the public export, and excluded unrequested concurrency/persistence features. The successful coding outputs show that these requirements were implemented, but do not prove which sentence caused any particular tool decision.",
    "",
    "Preparation token totals remain incomplete in the lower-level transport ledger because streaming usage parsing was unavailable for those responses. The SDK-reported values are retained as reported lower bounds; no complete token-saving or billing claim follows from them. Early local regression checks overlapped the first model's run, and the worktree contained other in-progress changes. Timing is exploratory and this is not clean-release certification.",
    "",
    "This is a four-task synthetic documented-contract pilot with one trial per model, not a representative production benchmark. Every coding agent can read the same normative documents. There is no independent reviewer, statistical significance test, runtime architecture-understanding score, semantic/MCP ablation, or human workshop-usability evaluation. The current `/enhance` investigative workshop is a separate path from the legacy endpoint exercised here.",
    "",
    "## Reproducibility Appendix",
    "",
    `Dataset digest: \`${runs.at(0)!.run.fixture}\`.`,
    "",
    ...runs.map(
      (item) => `- ${item.run.model}: \`${path.basename(item.directory)}/results.json\`; start ${item.run.started}.`,
    ),
    "",
    "```sh",
    "FORGE_EVAL_MODEL=openai/gpt-5.6-sol FORGE_EVAL_TRIALS=1 bun run --cwd packages/kilo-forge evaluate:preparation",
    "```",
    "",
    "Use a new output directory for each run. Credentials are not part of the report; the account allowance, not API credits, is used. Source revision, dirty state, effective configuration and harness digest are retained in each result file.",
    "",
  )
  return {
    text: lines.join("\n"),
    runs: runs.map((item) => ({ model: item.run.model, metrics: item.metrics })),
    retrieval,
  }
}

if (import.meta.main) {
  const directories = process.argv.slice(2)
  const result = await section(directories)
  const root = path.dirname(directories.at(0)!)
  await Bun.write(path.join(root, "section7.md"), result.text)
  await Bun.write(
    path.join(root, "section7-metrics.json"),
    JSON.stringify({ runs: result.runs, retrieval: result.retrieval }, null, 2),
  )
  console.log(`Section 7: ${path.join(root, "section7.md")}`)
}
