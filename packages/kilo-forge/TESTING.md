# Forge Testing

Run commands from the repository root unless a section specifies another directory. Never run the root `bun test` script.

## Maintained Suites

| Command | Coverage |
|---|---|
| `bun run --cwd packages/kilo-forge test` | Product regressions only: knowledge, retrieval, lifecycle, enhancement, consent, citations, and embeddings. |
| `bun run --cwd packages/kilo-forge test:evaluation` | Model-free checks of maintained benchmark/evaluator/grader/report utilities. Not product quality evidence. |
| `bun run --cwd packages/kilo-forge test:all` | Both Forge suites. |
| `bun run --cwd packages/kilo-forge typecheck` | Core, regression tests, and evaluation utilities. |
| `bun run --cwd packages/kilo-forge-ui test` | Browser data/model unit tests. |
| `bun run --cwd packages/kilo-forge-ui test:e2e` | Playwright interactions; requires built assets and a configured source backend, as described below. |
| `bun run --cwd packages/kilo-forge-ui typecheck` | Browser implementation and test types. |
| `bun run --cwd packages/kilo-forge-ui build` | Production browser assets. |
| `bun run --cwd packages/tui typecheck` | Terminal implementation and test types. |

Run individual files from their owning package:

```sh
# packages/kilo-forge
bun test ./test/context-ranking.test.ts ./test/evidence-admission.test.ts --timeout 30000
bun test ./benchmarks/test/evaluation.test.ts --timeout 30000

# packages/tui
bun test ./test/kilocode/forge-draft.test.ts

# packages/opencode
bun test ./test/kilocode/forge-enhance-stream.test.ts ./test/kilocode/forge-consent.test.ts
```

The consolidated suites use nested behavior groups and tables to preserve distinct inputs and local fixtures. Remove a repeated case only when its behavior and assertions remain covered; different transport boundaries and race orderings are not duplicates. Keep provider fixtures at adapter boundaries; exercise real SQLite, extraction, policy, and rendering implementations where practical.

`bun run test` is the supported default entry point. An unrestricted `bun test` discovery can also find opt-in benchmark tests.

Some retained checks are opt-in: `FORGE_RESEARCH_PDF` supplies a local research PDF. Source and packaged held-status checks share `packages/tui/test/kilocode/forge-status-server.test.tsx`; enable them with `FORGE_HELD_SOURCE=1` and `FORGE_HELD_SERVER=1`, respectively. `FORGE_HELD_BINARY` can override the packaged CLI path, and `FORGE_CHROME` selects the browser executable. The embedding integration requires `FORGE_EMBEDDING_SOURCE=1` or `FORGE_EMBEDDING_BINARY`. Without inputs, the core PDF case and three TUI integration cases are skipped. These flags do not represent release certification.

## Investigative Workshop

The new path is opt-in with `investigation: true` in `.kilo/forge.jsonc`. Routine tests use actual files, SQLite, parsers, terminal components, and local protocol fixtures. They make no live model calls.

```sh
# packages/kilo-forge
bun test ./test/repository.test.ts ./test/investigation.test.ts ./test/writing.test.ts
bun test ./test/catalog.test.ts ./test/engine.test.ts

# packages/opencode
bun test ./test/kilocode/forge-investigation.test.ts ./test/kilocode/forge-sources.test.ts
bun test ./test/kilocode/forge-investigation-process.test.ts

# packages/tui
bun test ./test/kilocode/forge-composer.test.tsx ./test/kilocode/forge-dialog.test.tsx
```

The process fixture starts a current-source backend with isolated on-disk state and a local OpenAI-compatible response server. It checks native tool calling, explicit direction/writing, structured message admission, ordinary coding continuation after code changes, compaction, restart, and later exclusion enforcement. `FORGE_WORKSHOP_BINARY=/absolute/path/to/kilo` runs the same fixture against a built CLI. This is a mechanics and provenance test, not evidence that a real model diagnoses a task correctly.

`repository` covers bounded literal discovery and reads, escapes, ignore rules, symlinks, byte limits, and source-instruction text. `investigation` covers adaptive queries, findings support, empty results, clarification, deadlines, cancellation, duplicate attempts, and recovery. `writing` covers chosen-only scope, requirement/counterevidence coverage, edits, freshness, historical coding context, and purge. `catalog` covers cold/delta equivalence and package-local dependency resolution.

Keep source freshness and historical authorization distinct: a new prepared submission requires current supporting evidence; already-submitted coding context must tolerate intended repository edits while retaining revocable source/permission restrictions.

## Browser Suite Setup

Playwright does not start the Forge backend. Build assets with `bun run --cwd packages/kilo-forge-ui build`, then start the current worktree's source backend, not the installed `kilo` binary. See [backend testing](../../TESTING.md) for readiness and process cleanup.

Use disposable state and a fixture workspace with at least 150 small source files for real pagination. Some suites register and index additional temporary collections. Do not point this run at user state.

For example, in the backend terminal:

```sh
home=$(realpath "$(mktemp -d /tmp/forge-browser.XXXXXX)")
mkdir "$home/workspace"
for n in {1..150}; do
  printf 'export const value%s = %s\n' "$n" "$n" > "$home/workspace/entry-$n.ts"
done
printf 'Browser fixture directory: %s\n' "$home/workspace"
HOME="$home" KILO_TEST_HOME="$home" \
XDG_DATA_HOME="$home/data" XDG_CONFIG_HOME="$home/config" \
XDG_CACHE_HOME="$home/cache" XDG_STATE_HOME="$home/state" \
KILO_SERVER_PASSWORD=forge-local-validation KILO_AUTH_CONTENT='{}' \
KILO_DISABLE_PROJECT_CONFIG=1 KILO_DISABLE_MODELS_FETCH=1 \
KILO_DISABLE_DEFAULT_PLUGINS=1 KILO_TELEMETRY_LEVEL=off \
KILO_CONFIG_CONTENT='{"plugin":[],"enabled_providers":[],"indexing":{"enabled":false},"snapshot":false,"formatter":false,"lsp":false}' \
bun dev serve --hostname 127.0.0.1 --port 4096
```

In the test terminal, set the actual printed URL and fixture path:

```sh
FORGE_TEST_URL=http://127.0.0.1:4096 \
FORGE_TEST_PASSWORD=forge-local-validation \
FORGE_TEST_DIRECTORY=/absolute/path/to/fixture/workspace \
FORGE_TEST_OFFLINE=1 FORGE_TEST_SHARING=0 \
FORGE_CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
bun run --cwd packages/kilo-forge-ui test:e2e --workers=2
```

On other platforms, use an installed Chromium executable or omit `FORGE_CHROME` when Playwright's browser is installed. Always supply `FORGE_TEST_URL`: suite defaults use different ports. `FORGE_TEST_OFFLINE=1` requires a backend configured with `enabled_providers: []`; it is not itself a network blocker. Do not enable the optional sharing/model branch during routine validation. Stop the owned backend before removing its temporary home. Generated screenshots and failure contexts are ignored under the browser package's `test-results/`.

## Model-Free Benchmarks

```sh
bun run --cwd packages/kilo-forge benchmark
bun run --cwd packages/kilo-forge benchmarks/knowledge.ts
bun run --cwd packages/kilo-forge benchmarks/documents.ts
bun run --cwd packages/kilo-forge benchmarks/indexing.ts 5000
```

These create and remove temporary fixtures, print results to stdout, and make no model calls. The default benchmark measures lexical retrieval, candidate coverage, serialized evidence size, and selector timing. Synthetic repetition does not establish coding quality or independent statistical evidence.

`indexing.ts` measures visited paths, actual file reads/parses, scan/publication time, sampled process RSS, and generation equivalence for cold, unchanged, one-file delta, and reconciliation phases. Run timing measurements without concurrent builds/tests. These measurements do not establish a general latency guarantee or peak memory bound.

See [benchmark tooling](benchmarks/README.md) for the separately authorized live evaluator. Historical frozen-report comparison, challenge, local-repository pilot, and statistical study runners have been retired.

## Terminal Launch Probe

On macOS:

```sh
bun run script/kilocode/forge-launch.ts --fixture dev dev:watch
```

Use an absolute workspace path instead of `--fixture` to inspect a real workspace. The probe runs the actual CLI in a PTY, isolates settings/storage, intercepts browser opening, and traps inference calls locally. It checks `/overview`, `/map`, listener scope, assets, and read-only inventory behavior. It measures emitted text and timings, not pixel layout.

| Option | Purpose |
|---|---|
| `FORGE_LAUNCH_RUNS=3` | Independent process launches per mode. |
| `FORGE_LAUNCH_DOCUMENTS=600` | Populate a temporary document collection; supported range 1-1000. |
| `FORGE_LAUNCH_RESTART=1` | Check a fresh/resumed pair with persisted collection and a local saved conversation; use at least two documents. |
| `FORGE_LAUNCH_REPOSITORY=1` | Explicitly index the workspace before repeated views. |

Keep latency measurements separate from concurrent builds/typechecks. Indexing/population timings are separate from command latency; these probes do not flush OS caches or verify existing-daemon behavior. Workspace indexing is opt-in.

## Browser-To-Terminal Probe

Requires macOS and Chrome, or an installed Chromium executable selected with `FORGE_CHROME`:

```sh
bun run --cwd packages/kilo-forge-ui build
bun run --cwd packages/kilo-forge-ui e2e/workflow.ts dev accept
bun run --cwd packages/kilo-forge-ui e2e/workflow.ts dev:watch clarify
```

Supported scenarios are `accept`, `edit`, `clarify`, `search`, `symbol`, and `relationships`. The probe registers approved local evidence from the browser, drives enhancement and submission through real terminal keystrokes, and checks source versions, selection history, request lineage, and observed transmission. A fixed local response endpoint is not live-model quality evidence.

Owned processes and temporary state are cleaned up. `FORGE_WORKFLOW_SCREENSHOT` optionally selects a screenshot output path. Save manual results outside the repository or under the ignored `reports/` folder.

## Release Verification

Run the smallest affected package suites, package typechecks, scoped lint/formatting, markdown-table and whitespace checks. Changes to API contracts require SDK generation; source consolidation with unchanged endpoints does not. Check native packaging and applicable annotation, source-link, and service-facade guards when their areas change.

Record current failures and skipped checks explicitly. Do not substitute historical run logs for fresh verification, relax assertions to make consolidation pass, or launch provider requests as part of routine tests.
