# Forge Benchmark Tooling

This directory is development tooling, not the product runtime. Its tests are opt-in through `bun run test:evaluation` from `packages/kilo-forge`; ordinary product regressions remain in `test/`.

## Model-Free Checks

```sh
bun run benchmark
bun benchmarks/knowledge.ts
bun benchmarks/documents.ts
bun run test:evaluation
```

`run.ts` measures synthetic lexical retrieval and selection. `knowledge.ts` compares actual flat/domain retrieval; `documents.ts` supplies registered-document fixtures. Temporary fixtures are cleaned up; results print to stdout. Labels stay outside scanned inputs.

`embedding-ledger.ts` is an optional synthetic storage-size benchmark, not a live embedding call or product latency guarantee.

## Optional Live Evaluator

`evaluate.ts`, `harness.ts`, `repositories.ts`, `tasks.ts`, and `grading.ts` retain a small, reusable comparison of normal Kilo, generic enhancement, and Forge. `report.ts` and `assessment.ts` validate descriptive results and optional manually supplied evidence/intent labels. No statistical superiority decision or historical acceptance replay remains.

**Live evaluation makes model calls and requires explicit spending authorization.** Routine tests use local protocol fixtures, not live inference. Do not run the following just to verify a refactor.

After choosing an authorized model, start a dedicated source backend from the repository root:

```sh
export FORGE_EVAL_MODEL=kilo/openai/gpt-4.1-mini
export FORGE_EVAL_PASSWORD="$(openssl rand -hex 16)"
export KILO_SERVER_PASSWORD="$FORGE_EVAL_PASSWORD"
export KILO_CONFIG_CONTENT="$(bun -e 'import { settings } from "./packages/kilo-forge/benchmarks/evaluate.ts"; console.log(JSON.stringify(settings))')"
KILO_DB=:memory: KILO_TELEMETRY_LEVEL=off \
KILO_DISABLE_DEFAULT_PLUGINS=true KILO_DISABLE_PROJECT_CONFIG=true \
KILO_DISABLE_EXTERNAL_SKILLS=true KILO_DISABLE_CLAUDE_CODE=true \
KILO_DISABLE_AUTOUPDATE=true KILO_DISABLE_LSP_DOWNLOAD=true \
bun dev serve --hostname 127.0.0.1 --port 0
```

In another terminal with the same model/password, set `FORGE_EVAL_URL` to the printed listener address:

```sh
FORGE_EVAL_URL=http://127.0.0.1:4096 FORGE_EVAL_TASKS=1 FORGE_EVAL_TRIALS=1 \
bun run --cwd packages/kilo-forge evaluate
```

The example port must be replaced. `FORGE_EVAL_MANIFEST` optionally selects reviewed, locally available pinned repository-file subsets instead of synthetic tasks. Inspect supplied task files, reference solutions, graders, and dependency requirements before execution; this tooling is not a security sandbox.

Each arm uses fresh directories/sessions and identical coding limits. Preparation policies differ, and blocked preparations remain outcomes. Outputs/checkpoints are written to a printed temporary directory and can contain source content. Delete that temporary state when no longer needed.

Client deadlines, step limits, and output limits are not total spending caps. Missing usage remains unknown; reported lower bounds are not invoices. A routed model name does not prove stable underlying model identity.

## Descriptive Reporting

From this package:

```sh
bun benchmarks/report.ts /absolute/path/to/results.json /absolute/path/to/report.md
bun benchmarks/report.ts results.json report.md --partial --assessments assessments.json
```

Keep failures and unmatched attempts. Only complete eligible comparison groups enter matched aggregates. Human-supplied labels are externally asserted; validation does not authenticate reviewers or prove prospective freezing.

Historical frozen/challenge comparisons, hard-coded two-repository pilot inputs, round-by-round runners, and the fixed statistical study protocol/analyzer were removed. No maintained test depends on their deleted reports or operator-specific Git roots.
