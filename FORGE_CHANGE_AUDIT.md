# Forge Change Audit

Date: 2026-11-06. Scope: current checkout, all branch references, tracked diffs, new Forge sources, tests, and generated outputs.

## Bottom Line

There is real product work here, but it is mixed with a large amount of experiment output and process documentation. The Forge feature work is **uncommitted**, not a sequence of RALPH commits that can be selectively reverted.

The knowledge/retrieval engine, interactive enhancement, source inspection, optional embeddings/browser interface, and their safety checks have been preserved. Release notes, plans, and related regression files are consolidated. A second testcase-level pass removed confirmed duplication and administrative checks. Maintained evaluation tests are now opt-in, and obsolete historical experiment runners are retired.

Approximately 2.8 GiB of generated run outputs were deleted. Distinct product regressions, saved sessions, knowledge databases, settings, and commits were preserved. No production runtime or API changes were made for consolidation. The three backend failures retained during that audit are now resolved by a separately requested SQL-adapter fix: all 196 Forge backend tests pass. See the follow-up below.

## Actual Commits

`main` and `origin/main` both point to `d14aa10d`; there are no local commits ahead of the remote.

| Commit | Actual Effect | Recommendation |
|---|---|---|
| `d14aa10d` | Add the TUI `/cd` command, directory completion, and workspace switching. | Keep. This is a genuine user-facing feature. |
| `4424438b` | Add restart-on-save development watch mode. | Keep unless deliberately removing developer tooling. Not part of the Forge knowledge feature. |
| `a68a0e08` | Replace the previous project base with Kilo Code. Changes 26,766 files. | Keep. This is the project foundation, not RALPH output. |
| `3c1def83` | Initial repository import. | Keep as history. |
| `f6902610` on `backup/dev-watch-cd-split` | Earlier combined dev-watch and directory-switching commit. | Redundant backup, not another feature to preserve. Its final tree is identical to current `main`; no need to cherry-pick it. The branch was not deleted. |

There is **no committed Forge enhancement, knowledge-library, source-map, or embedding feature** on these branches. Hashes in experiment notes should not be assumed to be Git commits; the notes also use file and snapshot hashes.

## What Made The Changes Look Huge

Before cleanup:

| Category | Observed Size | Meaning |
|---|---|---|
| Modified tracked files | 58 files; 16,090 added lines, 137 deleted lines | Integration work plus generated API output. |
| Generated SDK/OpenAPI changes | 15,172 added lines in four files | Approximately 94% of tracked insertions. These describe the new API and SSE behavior; do not delete them independently of the API. |
| All untracked files | 12,267 files | Dominated by saved runs, not implementation. |
| `reports/` | 11,434 untracked files; about 2.4 GiB | Reports, logs, screenshots, snapshots, copied source trees, and experiment receipts. Deleted. |
| Old Forge package outputs | 415 untracked files; about 427 MiB | A compiled distribution and its zip. Deleted. |
| `.changeset/forge-*.md` | 71 files | Fragmented release notes, now replaced by `.changeset/forge.md`. |

Artifact cleanup reduced the untracked file count to **416**, before adding this audit document. The first consolidation reduced it to **303**; the testcase audit leaves **301**. These are files, not the shorter directory-grouped count shown by `git status`.

## Product Work To Keep

| Feature | Main Locations | Why It Matters |
|---|---|---|
| Repository knowledge and persistence | `packages/kilo-forge/src/{engine,catalog,parse,store,snapshot,config}.ts` | Inventory, symbols, relationships, storage, incremental updates, and current source versions. |
| Document knowledge library | `packages/kilo-forge/src/{knowledge,extract,extraction,imports,references,download}.ts`; backend document/storage workers | Register files, folders, text, uploads, and URLs; extract PDF/DOCX/Markdown; recover and refresh collections. |
| Evidence retrieval | `packages/kilo-forge/src/{context,retrieval,semantic-scope,preparation,citations,binding}.ts`; `packages/kilo-indexing/` changes | Search, candidate filtering, evidence budgets, pins, exclusions, citations, and semantic eligibility. |
| Interactive `/enhance` | `packages/tui/src/kilocode/forge/{enhance,conversation,draft,attachment,provider}.tsx` and `.ts`; backend `service.ts` | Stream and revise an enhanced prompt, clarify requirements, preserve attachments, and stage without automatically sending. |
| `/overview` and `/map` | TUI Forge dialogs; `packages/kilo-forge-ui/src/`; backend Forge API and assets | Inspect available knowledge and request context, browse originals, and manage source controls. |
| Agent retrieval tools | `packages/opencode/src/kilocode/forge/tools.ts`; tool registries | `forge_search_code`, `forge_search_docs`, `forge_get_symbol`, and `forge_relationships`. These affect actual coding behavior. |
| Runtime context and sharing protection | Backend `{trace,access,egress,destination,writer}.ts`; provider/session hooks; core freshness/lifecycle checks | Prevent stale, excluded, revoked, or wrongly scoped registered evidence from being accepted or sent. Not disposable run logging. |
| Packaging and launch support | Root `forge` script, CLI build workers/assets, package dependencies, `dev-watch.ts` preparation | Make the retained product actually launch and package correctly. |

The opened `packages/tui/src/kilocode/forge/draft.ts` is core feature code. It assembles the approved prompt and evidence and reanchors retained attachments. It should not be removed as a run artifact.

Original implementation size at the initial audit, excluding ignored builds:

- Forge core: 54 TypeScript source files, about 7,579 lines.
- Backend Forge adapter directory: 19 files, about 1,209 lines, plus API, plugin, and shared integration changes.
- Terminal Forge UI: 22 files, about 3,234 lines.
- Browser Forge TypeScript/TSX: 11 files, about 1,575 lines, plus styles.
- Forge tests/helpers: 112 TypeScript files, about 20,421 lines.
- Forge benchmark/evaluation TypeScript: 21 files, about 5,413 lines.
- Browser end-to-end tests/helpers: 21 files, about 4,942 lines.

These counts show that much of the remaining volume is testing and evaluation, not just application code.

## First Consolidation

| Area | Result |
|---|---|
| Release notes | 71 Forge changesets replaced by `.changeset/forge.md`. Preserve the highest existing bumps: CLI minor; Forge, indexing, and SDK patch. Unrelated changesets remain. |
| Planning | Three Forge plans and four round-history spec files replaced by `plans/forge.md`. Keep current scope, safety constraints, and real outstanding product/release work. Preserve the unrelated JetBrains plan. |
| Documentation | Shorten the Forge README and watch command guide. Put test/probe commands in `packages/kilo-forge/TESTING.md` and evaluator guidance in `benchmarks/README.md`. Remove obsolete report links and historical acceptance administration. |
| Regression files | Combine 40 core/TUI files into 12 behavior-grouped suites with isolated fixture scopes. Share one permutation helper. Preserve 675 assertion expressions, with one equivalent awaited `node:assert` rejection check. |
| Directive tests | Rename the round-numbered suite to `context-directives.test.ts`; preserve its six assertion expressions. Give every test its own cleaned-up temporary directory. |
| Diagnostic output | Remove optional per-case report exporters and persistent operator-selected test roots from the merged/directive suites. Remove unused diagnostic objects, timing records, and labels. |
| Default tests | `bun run test` runs 75 Forge product suites under `test/`. `test:evaluation` runs seven maintained utility suites under `benchmarks/test/`; `test:all` runs both. |
| Historical tooling | Remove frozen-report comparison/trace, sealed/challenge, two-repository pilot, and fixed statistical protocol/analyzer runners and their exclusive tests/fixtures. |
| Retained tooling | Keep model-free retrieval/document benchmarks and reusable evaluator, repository loader, grader, descriptive report, and assessment utilities. Live inference remains separately authorized. |
| Runtime/API | Preserve production code, optional features, endpoints, and generated SDK contracts. No endpoint change means no SDK regeneration is needed for this consolidation. |

Core grouped suites are `context-ranking`, `context-lookup`, `context-passages`, `context-obligations`, `context-scenarios`, `ordering`, `knapsack`, `evidence-admission`, `extraction-integrity`, `lifecycle-handoff`, and `preparation-response`. The combined TUI suite is `forge-draft.test.ts`, retaining draft, conversation, and attachment groups.

The Forge product test directory has 78 TypeScript files: 75 suites and three helpers. Evaluation utilities have seven separate suites. The first pass removed 31 tests exclusive to retired historical evaluation tooling; product regression assertions were retained at that stage.

## Testcase Audit

The second pass covered 149 Forge-related suite files: core, maintained evaluation utilities, browser, TUI, backend, and selected indexing, SDK cancellation, memory, watch, and terminal integrations. This is the Forge scope, not every test in the monorepo.

The investigation combined declaration inventories, lexical binding checks for matrix inputs, exact callback comparisons, near-duplicate token comparisons, and behavioral inspection. Similar syntax was only a candidate signal. Inputs, assertions, failure phases, actual call paths, and integration boundaries determined what could be consolidated.

| Area | Change | Coverage Retained |
|---|---|---|
| Core scenario matrix | Remove the two-value `location` loop in `context-scenarios.test.ts`: its binding was used only in titles, not callback inputs. Eliminates 32 duplicate executions. | All controls, query forms, routing modes, budgets, and assertions. Genuine relocation remains in `domain-relocation.test.ts` and `ordering.test.ts`. |
| Core selectors | Consolidate four overlapping ordering/knapsack cases into `knapsack.test.ts`. | Fixed-order B+C result inside permutation coverage; equal-objective tie and stronger-score winner; unequal-cost alternatives; beyond-cap rejection and nonempty selection. |
| Browser inspection | Remove six repeated history, ordinary selection, stale-error, page, and close cases from `map.pw.ts` and `read-cancel.pw.ts`. Transfer page, close, and hidden-evidence assertions to the retained cancellation matrix. | Late success/failure, selection/history/page/search/reload/cancel/close, latest-error ordering, same-ID repeat races, and real backend map flows. |
| Browser checklist | Delete `test/finite.test.ts` and the static case/ledger catalog in `e2e/finite.ts`. It asserted historical IDs and `not-run` labels, not launch behavior. | Move reusable fingerprint/listener helpers to `e2e/process.ts`; keep actual workflow and command-control probes. |
| Source/package status | Merge `forge-current-status-server.test.tsx` into `forge-status-server.test.tsx` with a shared scenario and separate opt-in launch modes. | Both source and packaged launch boundaries; real authenticated backend, held HTTP response, TUI/browser rendering, read-only behavior, release, and cleanup. |
| Qdrant URLs | Convert 23 URL cases into a table and remove one duplicate undefined/default constructor case. | Every URL input, normalized URL, host, protocol, port, and prefix expectation. |
| Qdrant directories | Convert seven repeated prefix cases into a table. | POSIX, Windows, empty, trailing-slash, relative, and ordinary directory inputs; metadata exclusion, query options, populated and empty responses. |
| Wait observation | Replace a report-only 1,000-read repetition loop with one real SQLite observation regression. | Exact evidence equality, one observation, and no added writes; distinct cancellation, transaction, deadline, drain, and authorization tests remain. |
| Populated browser | Replace five diagnostic context/reload rounds with direct fresh and cached navigation checks. Share an inspection helper that selects an available document and verifies its exact label, rather than assuming a fixed first-page document or an excerpt-pin button. | Real 600-document collection, 120-row pagination, unchanged generation, no indexing/model requests, no page errors, and disabled document controls during pending/failed policy reads. |

The pass removes or consolidates **44 executed duplicate/administrative cases**: 36 core, six browser, one static checklist, and one Qdrant default-constructor duplicate. Table rows and both status launch modes remain executable cases. Report-loop repetitions are separate from this count.

The final inventory has 147 suite files and 983 `test`/`it` declaration sites; table rows and loop expansions make this different from the executed-test count. The scanner found no exact callback duplicates or unused surrounding matrix bindings in that scope. This does not prove that every possible semantic overlap has been eliminated.

Retained similarities include query-free versus single-term ranking, current evidence versus captured request scope, optional-answer discard versus repeated skip versus consequential blockers, malformed versus unavailable memory models, HTTP downgrade versus malformed redirect, and distinct terminal byte sequences. These exercise different behaviors. Existing failures are also not removal candidates.

## Optional Scope To Remove Separately

These are real features or development tools, but are not essential to a lean knowledge-plus-enhancement product. Their removal needs coordinated code/API/test changes, not directory deletion alone.

| Candidate | Locations | Consequences |
|---|---|---|
| Evaluation-only baseline API | `/forge/baseline`; observation additions to `enhance-prompt.ts` | Still used by the retained opt-in evaluator. Removing it requires coordinated handler, SDK, and caller changes. |
| Collection embedding jobs, coverage, usage exports, and pruning | `collection-semantic.ts`, `embedding-*.ts`; terminal/browser embedding views; `forge-usage` command; embedding API routes | Optional document-vector retrieval and accounting. Useful if you need embeddings, but a substantial independent subsystem. Keep ordinary lexical retrieval and sharing checks when removing it. |
| Model resource accounting and evaluation totals | `model-accounting.ts`, `model-response.ts`, `request-observation.ts`, benchmark accounting | Separate from the minimal evidence lineage needed by the map and send authorization. Do not delete the whole trace/transport guard to remove usage bookkeeping. |
| Domain routing and alternate selectors | `domains.ts`, `briefs.ts`, document routing, ranked/knapsack selection | Domain routing is opt-in; greedy selection is the default. Simplify only with parity tests, not by deleting helpers still called by the engine. |
| `/ideas` and model-backed repository explanation | Engine opportunities/ideas/overview; matching API and UI actions | Additional paid-model workflows. A read-only knowledge dashboard does not require them. |
| Browser interface, for a terminal-only product | `packages/kilo-forge-ui/`, asset serving/building, browser handoff | Larger scope reduction, but removes browser knowledge management and graph inspection. Keep the shared engine and terminal map. |

A smaller future product could keep repository/document knowledge, default retrieval, `/enhance`, `/overview`, terminal `/map`, the four retrieval tools, and their safety checks. This consolidation does not remove the other working features or enable any new model/embedding requests.

## Suggested Future Commits

These are proposed groupings, **not commits that already exist**. No commit or history rewrite was made.

| Proposed Commit | Scope |
|---|---|
| `feat(cli): add Forge knowledge and evidence retrieval` | Core package, document ingestion, store/workers, retrieval, indexing integration, permissions/freshness, and core regression tests. |
| `feat(tui): add reviewed Forge prompt enhancement` | Composer/provider wiring, draft and attachment handling, model response validation, streaming, clarification/recovery UI, and tests. |
| `feat(cli): expose Forge source inspection and agent tools` | Dashboard/map, request lineage and send guards, tool/API/plugin registration, and selected browser functionality. |
| `chore(cli): package Forge and document launch commands` | Build/launcher/watch integration, dependencies/lockfile, concise docs, and consolidated release notes. |
| `feat(cli): add optional collection embeddings and usage controls` | Only if retained: collection vectors, jobs, coverage, ledger/export/pruning, and corresponding API/UI/tests. |

Generate the SDK/API output with the relevant retained endpoints. The first four groups may share prerequisite changes and should not be split by blindly staging whole directories.

## Cleanup Performed

- Deleted `reports/`.
- Deleted `artifacts/forge-tui-macos-arm64-20261025/` and its zip.
- Deleted `packages/kilo-forge-ui/test-results/`.
- Added narrow `.gitignore` rules for future reports, Forge packaged outputs, and browser test results.
- Kept the already tracked, unrelated `artifacts/glm52-rise-video/`.
- Consolidated release notes, plans, documentation, and regression suites as detailed above.
- Retired historical experiment tooling; retained reusable opt-in evaluation utilities.
- Consolidated confirmed testcase duplication and removed the obsolete static browser checklist.
- Kept production source, distinct product regressions, settings, existing branch history, and unrelated work.

Approximately 2.8 GiB of generated outputs were removed. This intentionally discards historical experiment replay evidence; maintained documents no longer depend on it.

## First-Pass Verification

- Original full Forge baseline: **1,888 passed, one skipped, zero failed** across 111 files; 33,001 assertions.
- First-pass consolidated product suite: **1,763 passed, one skipped, zero failed** across 75 files; 30,335 assertions.
- Maintained evaluation suite: **94 passed, zero failed** across seven files; 1,903 assertions. Two fixture import-path failures introduced by relocation were fixed before this passing rerun.
- Forge TUI suite: **240 passed, three skipped, zero failed** across ten files; 1,568 Bun assertions. The combined draft/conversation/attachment suite also passed independently: 12 tests, 59 Bun assertions plus the awaited rejection check.
- Skips require opt-in inputs: a supplied research PDF and three source/packaged backend TUI integration checks. See `packages/kilo-forge/TESTING.md`.
- Forge and TUI package typechecks: **passed** after cleanup.
- Scoped lint for all consolidated and moved test files: **zero warnings, zero errors**.
- Final syntax-tree comparison: all 675 grouped assertion expressions and six directive checks retained, allowing only the equivalent rejection-check change.
- Model-free retrieval benchmark smoke check: **passed**, two fixtures, 24 rows, zero model calls.
- Prettier check, markdown-table check, documentation-link checks, and `git diff --check`: **passed**.
- Verified all five artifact/history cleanup targets are absent and generated-output ignore rules work. The backup branch's committed tree was verified equal to `main` during initial cleanup.
- Tests emit existing PDF font warnings and intentional failure-path diagnostics; these are not failing assertions. Evaluator fixture messages marked `FAIL`/`UNAVAILABLE` exercise result classification, not live model runs.
- No live model calls, production runtime changes, commits, resets, or branch deletions were performed.
- Full monorepo tests, browser end-to-end flows, PTY launch probes, and native packaging were not rerun during the first pass. Historical quality claims were not independently revalidated.

## Testcase-Pass Verification

| Check | Result |
|---|---|
| Forge product suite | 1,727 passed, one optional PDF skip, zero failures; 75 files and 29,011 assertions. Down from 1,763 passed before testcase deduplication. |
| Maintained evaluation utilities | 94 passed, zero failures; seven files and 1,903 assertions. |
| Forge TUI, including source held-status mode | 241 passed, two opt-in skips, zero failures; nine files and 1,580 assertions. Packaged held-status and embedding integration were not enabled. |
| Browser unit tests | Two passed, zero failures; 11 assertions. |
| Full browser suite | 102 passed, zero failures across 15 files against an isolated source backend with two workers. Down from 108 before deduplication. The populated suite's fixed-button and fixed-document assumptions were corrected after follow-up failures; all six cases execute in the final passing run. |
| Indexing/search/vector-store integrations | 99 passed, zero failures; six files and 392 assertions. The Qdrant-only rerun also passed 71 cases and 232 assertions, retaining all seven directory inputs and adding six empty-result checks. |
| Backend indexing/memory integrations | 53 passed, zero failures; five files and 235 assertions. |
| SDK event cancellation | Two passed, zero failures; five assertions. |
| Watch and terminal observer | 11 passed, zero failures; two files and 18 assertions. |
| Backend Forge baseline | 190 passed, three failed across 26 files. A targeted confirmation reproduced the same three failures: four passed, three failed across three files. No backend testcase or runtime edit was made to hide them. |
| Package typechecks | Forge, TUI, browser, and indexing passed. |
| Browser build | Passed, with the existing large-bundle warning. |
| Scoped lint | Zero errors. Nine refactored regression/helper files have zero warnings. The Qdrant file retains 54 existing unsafe-assertion warnings; the two import-only workflow/probe files retain four. No new warning expressions were introduced. |
| Formatting and docs | Ten refactored test/helper files passed Prettier. Maintained local documentation links, Markdown tables, and `git diff --check` passed. |

The backend failures retained during consolidation were:

- `forge-events.test.ts`: source pagination preserves HTTP scope and resets stale generations.
- `forge-initialization.test.ts`: Forge inspection observes live indexing state without booting it.
- `forge-tools.test.ts`: actual Forge search tools retain scoped selection history and link matching transport results.

The memory/non-WAL adapter in `packages/opencode/src/kilocode/forge/storage.ts` split SQL on every `?`. The classification query includes a quoted literal `?` in `packages/kilo-forge/src/references.ts`, so the adapter reported `Invalid Forge SQL parameter count`; pagination then received an error body instead of a view. This was a production fallback-adapter bug exposed by in-memory tests, not three unrelated defects or obsolete assertions. Default disk-backed WAL reads bypassed this conversion.

Validation used temporary homes/workspaces and locally controlled inference fixtures. No paid-provider experiment was launched. Backend runs still attempted model-catalog fetching despite the disable flag, so these results do not establish zero external network traffic.

Native packaging, packaged held-status, the opt-in embedding integration, PTY launch probes, and the full monorepo suite were not run in this pass. No production API/runtime change, SDK regeneration, commit, or history rewrite was made.

## Backend SQL Follow-Up

At the user's subsequent request, replace the SQL-splitting helper with the existing host SQL client's bound execution API. SQL text and values remain separate, so SQLite handles quoted question marks correctly. Reads keep the same connection selection; fallback writes keep the host transaction and semaphore. No shared upstream implementation, endpoint, or SDK contract changed.

Add `packages/opencode/test/kilocode/forge-storage.test.ts`, a three-mode regression matrix for in-memory, file-backed DELETE-journal, and file-backed WAL databases. It exercises empty views, URL/fragment category classification, category filtering before paging, private-session and workspace isolation, SQL-like bound values, a deliberately failed late snapshot write, complete rollback, and successful recovery. The new matrix passes all three cases with 51 Bun assertions plus three awaited rejection assertions.

Full Forge backend verification after the fix: **196 passed, zero failed across 27 files**, with 2,430 Bun assertions. All three original regressions, the new storage matrix, and existing independent-reader/worker-lease/rollback coverage pass. Run from `packages/opencode/` with `bun test ./test/kilocode/forge-*.test.ts --timeout 30000`. No original failing assertions were removed or weakened.

Backend package typecheck, scoped lint, formatting, and the Effect facade guard pass. The worktree-wide annotation guard still reports an unrelated existing unannotated block in `packages/opencode/test/server/httpapi-cors-vary.test.ts:65-125`; that file was not changed for this fix.

This records change inventory, completed consolidation, and local checks, not an exhaustive correctness/security review or release certification.
