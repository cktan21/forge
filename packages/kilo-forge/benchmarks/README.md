# Forge Benchmark Tooling

This directory is development tooling, not the product runtime. Its tests are opt-in through `bun run test:evaluation` from `packages/kilo-forge`; ordinary product regressions remain in `test/`.

## Model-Free Checks

```sh
bun run benchmark
bun benchmarks/knowledge.ts
bun benchmarks/documents.ts
bun benchmarks/indexing.ts 5000
bun run test:evaluation
```

`run.ts` measures synthetic lexical retrieval and selection. `knowledge.ts` compares actual flat/domain retrieval; `documents.ts` supplies registered-document fixtures. Temporary fixtures are cleaned up; results print to stdout. Labels stay outside scanned inputs.

`embedding-ledger.ts` is an optional synthetic storage-size benchmark, not a live embedding call or product latency guarantee.

`indexing.ts` compares actual cold/warm/delta work and SQLite publication, including file-read/parse counts and generation equivalence. It samples process RSS after each phase; this is not peak allocation. Run it without concurrent builds or tests.

## Free-Model Forge On/Off Benchmark

With explicit authorization to call a free hosted model, run from this package:

```sh
bun run evaluate:free
# Optional: choose another currently free, named model and a new output directory.
FORGE_EVAL_MODEL=kilo/cohere/north-mini-code:free FORGE_EVAL_TRIALS=2 \
bun run evaluate:free /absolute/path/to/new-results-directory
```

This starts the **current worktree's source backend**, with anonymous gateway access, an isolated temporary home and no inherited account credentials or provider configuration. It stops its backend afterward. No paid model or automatic router is accepted; advertised free status and zero input/output/cache rates, including declared pricing tiers, are checked before every attempt. There is no paid fallback. Provider catalog observations are not an invoice or a guarantee against a provider changing its terms.

The default model is `kilo/cohere/north-mini-code:free`. Availability and anonymous quota can change. Authentication, quota, and infrastructure failures stop the run and preserve a partial report; they do not count as coding failures.

The version-4 tools-only comparison is:

| Control | Without Forge (`normal`) | With Forge (`forge`) |
|---|---|---|
| Coding agent and model | Same Kilo source build and named model | Same |
| Initial files and user prompt | Original task, fresh directory/session | Identical |
| Standard tools and limits | Read/edit/search/test, 16 steps, 240 seconds | Same |
| Forge coding tools | Disabled | Search code/docs, get symbol, relationships |
| Prompt enhancement/investigation | None | None |
| Embeddings and external documentation | Disabled | Disabled |
| Grading | Hidden behavioral checks and original regressions | Same |

Default protocol: four existing synthetic tasks across two small TypeScript/Python repository templates, two trials per arm, **16 coding attempts**. Tasks cover atomic batch validation, filtering/pagination, stock validation, and SQLite partial uniqueness. Each has six hidden checks. Unchanged inputs must fail and reference fixes must pass before live calls. Hidden checks and reference solutions stay outside model workspaces. Order alternates by task and reverses each trial. Do not change prompts, tasks, model, or limits mid-run or discard inconvenient attempts.

Primary endpoint: full functional success, requiring all hidden checks and original regressions with no execution error. Secondary observations: check-level scores, latency, reported tokens/cost, tool errors, and actual Forge tool adoption. Check-level results include behavior already passing before the fix. Edits to docs/tests are counted, not independently judged for adequacy. Only complete available pairs enter comparison aggregates; failures remain in those denominators. A model that never chooses Forge only tests availability, not efficacy when used.

`FORGE_EVAL_TASKS=1` and `FORGE_EVAL_TRIALS=1` select a two-attempt smoke test. `FORGE_EVAL_MANIFEST` accepts reviewed pinned repository subsets using the existing manifest loader. Model-free regression checks remain `bun run test:evaluation`; they do not invoke this launcher.

Results, transcripts, patched files and `report.md` go under a new root `reports/forge-tools-<timestamp>/` by default. Disposable coding workspaces remain in the system temporary directory; their paths are recorded in `results.json`. A failed launcher retains backend diagnostics in its temporary home. These artifacts can contain source text and model responses; do not publish private repository runs without review.

For an already configured local source backend, use `evaluate:tools` with `FORGE_EVAL_URL`, `FORGE_EVAL_PASSWORD`, and the same `FORGE_EVAL_MODEL` used when generating backend `settings`. This also enforces free-only model metadata, but isolation/authentication are the backend operator's responsibility.

This is a pilot, not a statistically powered study, cross-assistant ranking, or evaluation of `/enhance`. Repeated trials of four tasks are not eight independent tasks. Expand to held-out real-repository tasks and additional free models before making general efficacy claims.

## ChatGPT Subscription Comparison

After connecting OpenAI with **ChatGPT OAuth**, explicitly authorize use of the subscription allowance and run:

```sh
FORGE_EVAL_MODEL=openai/gpt-6.1-sol FORGE_EVAL_TRIALS=1 \
bun run evaluate:chatgpt /absolute/path/to/new-sol-results
FORGE_EVAL_MODEL=openai/gpt-6-astra FORGE_EVAL_TRIALS=1 \
bun run evaluate:chatgpt /absolute/path/to/new-astra-results
```

This uses the same version-4 tools-only protocol. An explicit `FORGE_EVAL_MODEL` is required; the examples must be supported by the connected account, not merely listed in Kilo's general catalog. One trial of four tasks is eight attempts per model. Run models sequentially and compare Forge on/off **within** each model; do not merge their outcomes into a single causal effect.

The launcher reads only the OpenAI OAuth record from the standard Kilo `auth.json` under `XDG_DATA_HOME` (default `~/.local/share/kilo/auth.json`). API-key records are rejected, unrelated credentials and endpoint overrides are discarded, and credentials are injected into the isolated backend without being included in reports. The access token must have at least one hour remaining to avoid rotating a shared refresh token in disposable state.

Built-in provider adapters must remain enabled for this mode: the Codex adapter installs the direct ChatGPT transport and subscription pricing. The two standard built-in plugin declarations are included in the exact configuration check, with indexing disabled. Pure mode prevents loading external plugins; project configuration, external skills, other providers and inherited API keys remain excluded. The anonymous launcher retains its original isolation settings.

Only named GPT models on the direct `openai` provider with zero backend input/output/cache rates are accepted. Quota, authentication and infrastructure failures stop the run, and observed nonzero cost stops further attempts. There is no API-key or Kilo-credit fallback. The report labels this `chatgpt-subscription`, not a free-model promotion; it consumes the account's allowance, and reported zero cost is not a measurement of remaining quota.

`model.json` records non-secret provider/model/pricing metadata even when preflight blocks a run. A listed model is not proof that a subscription supports every request. Keep blocked attempts and diagnostics; do not relax billing guards to make a run start.

## Optional Live Evaluator

`evaluate.ts`, `harness.ts`, `repositories.ts`, `tasks.ts`, and `grading.ts` retain a small, reusable comparison of normal Kilo, generic enhancement, and Forge. `report.ts` and `assessment.ts` validate descriptive results and optional manually supplied evidence/intent labels. No statistical superiority decision or historical acceptance replay remains.

Set `FORGE_EVAL_INVESTIGATIVE=1` for a four-arm, version-3 comparison: raw Kilo, generic rewrite, retrieval-backed Forge, and investigative Forge. All four arms then use identical standard coding tools, with Forge coding tools disabled. A common excluded `.kilo/forge.jsonc` enables investigation in every disposable fixture. The original task dataset remains recorded separately from this harness configuration.

The predeclared selection protocol chooses the first non-contradicted finding and makes one writer call. Required clarification, incomplete investigation, and empty findings remain blocked outcomes; no automatic second attempt occurs. Findings, selected IDs, turn/call counts, and final prompt word count are archived alongside transport usage. Original evidence and prompts remain separate. Four-arm order uses a Williams square; incomplete blocks are not assumed balanced.

Use at least 20 reviewed tasks across two repositories for the planned descriptive quality comparison. Freeze tasks, direction-selection rules, and independent correctness/intent rubrics before calling a live model. The bundled synthetic cases and scripted responses are regression tests, not that evaluation. Version-1/2 historical reports retain their earlier comparison semantics.

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
