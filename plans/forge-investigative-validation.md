# Investigative Forge: Implementation And Validation

Date: 2026-11-06

The investigative workflow and connected repository/documentation improvements are implemented behind the explicit `investigation` flag. This is an opt-in implementation, not a claim that every release gate or live model-quality evaluation has passed. The unrestricted CLI suite is not green.

## Enable

Add `"investigation": true` to the project's `.kilo/forge.jsonc`. No existing user configuration was changed automatically.

Use `/enhance`, investigate the request, select findings with Space, then press `w` to write the prompt. `e` edits it; `a` stages it. Submit separately through the normal composer. Changed task feedback requires re-investigation. Disable the flag to use the existing rewriter.

Ctrl+B in `/overview` or `/map` explicitly opens the scoped browser inspector. Remote browser handoff requires HTTPS.

## Delivered

| Area | Implementation |
|---|---|
| Investigation | Bounded adaptive native-tool loop; code/docs search, literal discovery, file ranges, symbols and relationships. No shell, application writes, arbitrary MCP tools, or runtime diagnostics. |
| Findings | Explicit kinds, support levels, opposing evidence, unknowns, verification, clarification and valid empty results. |
| Review | TUI findings selection, feedback, source/activity inspection, model choice, cancellation and explicit retries. |
| Writing | Separate tool-free call, selected findings only, exact user requirements, source locators and no automatic raw evidence bundle. |
| Handoff | Hidden preparation ID/revision/digest, server validation, preserved edit lineage, session/provider isolation, purge tombstones and historical coding authorization. |
| Repository | Dirty-path reuse, buffered watcher events, reconciliation, transactional FTS/edge updates, owning-package dependencies, aliases and exact package exports. |
| Documentation | Explicit dependency targeting, adaptive follow-ups, bounded passages, current cache authorization, wrong-library rejection, and separate project/documentation versions. |
| Context/Evaluation | Separate evidence/request/replay/ledger/writer budgets, retained greedy default, and optional four-arm evaluation with identical coding tools. |
| Integration | Additive scoped HTTP/SSE, regenerated SDK/OpenAPI, preparation-history visibility, native packaging, documentation and changeset. |

Freshness remains mandatory for new prepared submissions. Already-admitted repository references are historical: intended coding edits/deletions do not deadlock the task. Current permissions, exclusions/ignore rules, private-document versions, destination restrictions and purge remain enforced during continuation, compaction and resume.

## Verification

| Check | Result |
|---|---|
| Forge product suite | 1,761 passed, one optional supplied-PDF case skipped. |
| Model-free evaluation suite | 98 passed, including actual four-arm runner/accounting fixtures. |
| Monorepo typechecks | 32 packages passed, including SDK, TUI, CLI, browser and JetBrains. |
| TUI suite | 565 passed, four skipped. The layout regression found during verification was corrected and the full suite rerun. |
| Focused CLI Forge suite | 201 passed in the broad Forge run; subsequent current investigation/egress checks passed 33 tests. |
| Real backend lifecycle | Source and native-binary fixtures passed: investigate, select, write, submit, continue after code edits, compact, restart, and block newly excluded context. |
| Browser inspector | Typecheck, unit tests and production build passed; both browser reauthentication tests passed. |
| Browser/terminal workflow | Passed actual browser registration/sharing/pinning, terminal review, separate staging/submission, context history, reauthentication and changed-document rejection. |
| Launchers | Source and development-watch launch probes passed, including explicit browser handoff and authenticated assets. |
| Native packaging | macOS arm64 build and version/model/worker smoke tests passed; packaged lifecycle passed. Approximately 280 MiB executable. |
| Reused semantic path | Typecheck and 11 eligibility/cancellation tests passed. |
| Guards | Upstream annotations, Promise-facade ratchet, source-link extraction, compact Markdown tables and patch whitespace checks passed. |
| Root lint | No errors; the repository reports approximately 11,287 warnings. |

The browser/terminal probe exercises the retained shared workflow with local scripted responses. The new investigative keyboard flow is covered by terminal tests, while its backend and persistent handoff are exercised through real source/native processes. These are complementary mechanics tests, not a live model-quality study.

## Indexing Measurement

One isolated 5,000-file synthetic run on Bun 1.4.3:

| Phase | Files Read | Files Parsed | Scan + Publication |
|---|---|---|---|
| Cold | 5,000 | 5,000 | 3.08 s |
| Unchanged warm | 0 | 0 | 0.66 s |
| One-file delta | 1 | 1 | 0.62 s |
| Full reconciliation | 5,000 | 5,000 | 2.07 s |

Cold/warm and delta/reconciliation generations matched exactly. The delta visited three paths. Sampled process RSS ranged from approximately 282 to 393 MB across phases; these samples are not peak or incremental allocation. No embedding/model calls occurred. This is a reproducible measurement, not a frozen latency guarantee.

## Remaining Gates

- The unrestricted CLI suite was stopped after database-lock/closed-database/disposed-runtime failures and a plugin-registry expectation mismatch. An isolated representative subset also reported 39 passes, six failures and one error. These failures are not resolved or presented as a passing release check.
- Existing-daemon attachment and every attachment/permission/model/worktree transition have not been exhaustively certified for the new workshop in a full-process run.
- Resolution is bounded: inherited TS configuration, wildcard exports, dynamic dispatch and ambiguous installed versions remain explicit limitations.
- A configured real Context7-provider contract smoke test requires approved egress. Local protocol fixtures do not certify that external integration.
- The planned matched evaluation of at least 20 tasks across two repositories requires approved models, destinations, spending and frozen rubrics. No token-saving or coding-success superiority claim is made.
- M9 runtime/database diagnostics remain deliberately unimplemented without separate capability-specific approval.

No commits, dependency installations, changes to user configuration, or live paid-model evaluations were made as part of this implementation.

## Follow-Up Validation (2026-11-08)

The source launchers now start Bun in `packages/opencode` to retain the SolidJS configuration while selecting the repository root through `KILO_DEV_CWD`. Local investigation opt-in belongs in `.kilo/forge.jsonc`, not `.kilo/kilo.jsonc`; the latter retains `snapshot: false`.

A live Auto Free rejection was reproduced with a harmless tool-call prompt: HTTP 400, "This model does not support a required or named tool choice. Remove it and retry." Inspection now uses automatic tool choice. The final turn offers only `forge_finish`, named explicitly for fixed models and automatic for routed aliases. Local call validation still requires native calls; text-only output is not accepted as a conclusion. Permissions, budgets and explicit model selection remain unchanged. Both investigator and writer classify failures before Effect wrapping; investigative SSE exposes only the existing privacy-safe diagnostics.

A subsequent real TUI run reached four model turns and six inspection calls before failing locally. A fresh run with specific diagnostics established that the model requested three reads in one batch. The implementation had incorrectly applied the planned concurrency limit as a batch-size rejection. Valid batches now use the existing sequential executor, with whole-batch validation and the unchanged 24-call total limit. No automatic model repair, transport retry or model substitution was added. Text-only replies remain rejected with a specific safe message.

One intervening run failed after six turns and 17 calls; its exact rejection was not retained by the old error handling. Schema, citation, tool-contract and deadline failures now have safe diagnostics, and classified failures remain in the saved attempt. Unknown schema keys and model values are excluded from public messages.

The actual Terminal `/enhance fix the backend` run `4c5e4748-de5b-43ba-b022-8ed0ac3440ae` completed as `needs_input` after four model turns, ten tool calls and 132 seconds. It inspected sandbox, extension CLI backend and HTTP server code, then requested a specific backend target and symptom. It did not establish a defect or execute tests. No writer or coding submission was triggered. This demonstrates the live investigation/clarification path, not guaranteed diagnosis for every vague request.

A normal-launcher run (`c0217c9c-b259-467e-9b67-77b9eedccf6a`) exposed a mixed conclusion/read batch after five model turns and 15 calls. A valid `forge_finish` is now terminal: sibling reads are explicitly skipped, never executed to retroactively supply evidence for an already-written conclusion. Identical fully validated conclusions produce one review; distinct conclusions and unobserved citations still fail. The visible limitations disclose skipped reads and identical repeats.

Auto Free subsequently returned multiple conclusions in one response (`2636d0ad-3dd2-41ad-87f4-2e11f70e50a3`), which initially failed; only identical validated repeats are now accepted. Investigation requests ask the OpenRouter adapter for `parallel_tool_calls: false`. A harmless live request accepted that setting, and a native adapter regression verifies the transmitted parameter. Auto Free can still return batches, so the setting is a hint, not an enforcement boundary. Local validation, serial execution and budgets remain authoritative.

The broad run `679e5f7c-afbc-439d-9f84-da0a0d22d33e` reached the retained-evidence limit after five turns and 18 tool calls (86 seconds), with no supported fix published. Later scoped attempts also exposed invalid model output and a tool-operation failure; the latter's exact error was not retained. Static follow-up found that source lookup could not resolve IDs returned by direct reads. Such IDs now resolve from the current investigation's observations, with the same original-source permission and freshness validation.

Before the model switch, the current-code TUI run `2b488a8b-cfed-4df6-9df7-28280690d2b6` failed after three turns and three executed calls because Auto Free returned invalid `forge_lookup` arguments. No findings were approved, no writer ran and no coding prompt was submitted. Auto Free reliability remains unresolved despite the passing mechanics tests.

The user explicitly approved testing `kilo/nvidia/nemotron-3-ultra-550b-a55b:free`. Its first scoped run completed the file reads but consumed all 4,000 output tokens on reasoning in a later call (`a76f3fc2-207a-4460-8ef8-783ec07ec3e3`). OpenRouter investigation/writer requests now reserve answer capacity by requesting at most 1,024 reasoning tokens within the unchanged output ceiling, preserving smaller configured budgets and disabled reasoning. Output cutoffs have safe explicit diagnostics. A later turn-limit result also prompted explicit final-turn instructions; no additional turn or automatic repair was added.

Missing files, out-of-range read continuation and unknown source IDs now return content-free tool feedback within the existing attempt. Permission and malformed-argument failures still terminate the attempt. Cumulative accounting tracks adapter/schema overhead and requests finalization before another inspection would consume the conclusion reserve.

The later Nemotron failures were diagnosed with temporary code-location and argument-shape tracing. Run `46a11f8c-1345-4b21-a63d-814b241a955e` failed at the repository eligibility guard on its first read; run `40fa1aa2-e1a8-4f56-a4a1-88c75f0137c6` confirmed that the model supplied a one-character path. Both actual requested files independently passed the unchanged repository guard.

A controlled free-model comparison established a provider-schema compatibility problem. Given the same harmless request for `packages/example/src/backend.ts`, the original JSON Schema pattern `\S` produced 16 separate one-character tool calls. The equivalent whole-string pattern `^[\s\S]*\S[\s\S]*$` produced one call with the complete path. This demonstrates full-string matching behavior on the tested provider route, unlike JSON Schema's substring semantics; it does not establish the cause of every prior Auto Free failure.

The shared model-schema converter now normalizes that exact nonblank-text pattern without relaxing local validation, maximum lengths or permissions. This covers investigator paths/findings, writer prose and legacy structured hypotheses. Regressions verify complete multiline matches, unchanged whitespace rejection, immutability and the schema actually transmitted by the native adapter. All temporary tracing was removed before the final TUI restart. No model substitution, output-repair turn or transport retry was introduced.

After that fix, live run `c2dc4c6d-3101-4ba8-a682-d54272415ff7` reached the call limit before any execution: the model returned an oversized first batch. A controlled comparison with the full investigation schemas reproduced 126 alternating copies of the same two reads under `toolChoice: "required"` (4,000 output tokens), versus exactly two reads under `"auto"` (130 output tokens). The investigator therefore uses automatic inspection selection for fixed models as well as routed aliases. These two reproduced compatibility problems should not be generalized into a verdict about the model's overall coding quality.

The next scoped run (`b9b4abad-718c-431e-ba47-a4c9a6c2c82e`) completed 11 reads/searches over 11 model turns, including all requested file ranges, but attempted another read on the final turn and ended `limited` after 158 seconds. It also expanded into related sandbox implementations beyond the two requested files. This is not a successful scoped diagnosis. A separate named-`forge_finish` probe returned exactly one valid empty conclusion in 131 output tokens. Fixed models therefore name that terminal tool only on the already-reserved final turn; no inspection turn uses arbitrary required selection. No extra turn or repair attempt is added.

The final source TUI run, `3d85ebaa-af4c-4c20-837e-4839f6326eaf`, used the original `/enhance fix the backend` request and the user-approved Nemotron free model. It completed as `needs_input` after 11 model turns, ten tools and 74 seconds. One search and nine bounded reads inspected `backend.ts`, `backend.test.ts`, `bubblewrap.ts` and `seatbelt.ts`. The review contains three diagnostic observations about the sandbox architecture and asks for the specific issue and target platform; it does not establish a defect. Terminal window `5420` was left open on that review, with no finding selected, writer call, staging or coding submission.

This final live check demonstrates the investigation-to-clarification path on the fixed free model. The earlier two-file scope drift, final-code Auto Free reliability, live writer quality and broader diagnosis quality remain unverified. The scripted full-process test covers writer/handoff mechanics, not live model quality.

| Check | Result |
|---|---|
| Native investigation and safe failure classification | 30 passed, 608 assertions, including transmitted whole-string patterns, forced-choice compatibility, reasoning budgets, recoverable read misses, direct-read IDs, bounded finalization, HTTP/SSE failures and tool-free writing. |
| Source backend lifecycle | One passed again after both final schema/selection changes, including writing, handoff, compaction, restart and changed-permission rejection. The final combined native run passed 31 tests and 617 assertions. |
| Core investigation, writing, preparation and repository reads | 70 passed, 848 assertions, including full-string model schemas, unchanged validation semantics, cumulative reservation, source permissions and provenance. |
| TUI composer and dialogs | 79 composer tests and 27 dialog tests passed, including investigative error display without automatic retry or lost input. |
| Launchers | Six passed, including package JSX runtime and root project selection. |
| Types and lint | Forge, CLI, SDK and TUI typechecks passed. Scoped host/TUI lint reported zero errors and warnings; existing core investigation tests and the source adapter reported 12 warnings and zero errors. |
| Generation and guards | SDK generation, upstream annotations, Effect facade ratchet and Markdown table checks passed. |

These focused checks do not supersede the remaining release and model-quality gates above.

## Turn History Follow-Up (2026-11-08)

The investigative workshop now persists and streams bounded model-turn records instead of displaying only aggregate counters and a flat source list. Each turn records its request ID, model usage, public update when available, parsed tool requests, execution outcomes, and the earlier observations included as full results or reduced to metadata. Tool rows reuse the existing local read/search/selection activity collector, with measured scan/read/parse-attempt counts and bounded samples. Direct reads explicitly do not claim syntax parsing or test execution.

The live view appears during investigation. `t` from review or `Ctrl+T` opens retained history; Up/Down selects turns, Enter/Space expands a turn, and `r` reveals source previews and local activity. The independently updated compact review layout, Enter actions, scrolling and focus behavior were preserved. Existing Sources controls remain available.

Public updates use brief tool purposes or public response text. New model-facing inspection schemas request a purpose, but locally validated older calls may omit it. The tested free model still omitted purposes on some turns; missing explanations are labelled, not invented. Public purposes are removed from replayed tool arguments. Private reasoning blocks are never stored in this history; only reported reasoning token counts may appear. Final turns use the validated conclusion summary, not duplicate tool-call markup from response text.

Failure/cancellation history remains inspectable, and source-bearing snapshots are cleared when freshness/access revalidation fails. Older investigations keep their resources without guessed turn boundaries. The full-process check caught absent optional fields being serialized as null; producers now omit those fields, with a no-public-update regression.

| Check | Result |
|---|---|
| Core investigation, writer, repository, catalog, engine and preparation | 136 passed; includes public-purpose replay exclusion, multi-call turns, metadata-only history, persistence and stale-evidence clearing. |
| Native API, classifier and source-process lifecycle | 34 passed; includes streaming journals, no-public-update responses, public purposes, hidden reasoning exclusion and raw final-tool-markup exclusion. |
| TUI composer and dialogs | 114 passed, 716 assertions; includes live turn expansion, resources, small-terminal layout, failed-attempt history, legacy records, preserved review controls and long-resource scrolling. |
| Types and generation | Forge, CLI, TUI and SDK typechecks passed; SDK/OpenAPI regenerated. |
| Lint and guards | New journal/TUI/adapter code has no lint errors; the wider engine/source-adapter check retains existing warnings. Upstream annotation, Effect facade, compact-table and whitespace checks passed. |

The vague live run `19320db8-bdb9-47ac-92df-0e12241e01f2` completed as `needs_input` with ten recorded turns, nine tools and 113 seconds. Its first search recorded 5,000 eligible files seen, 4,969 read and zero new parse attempts from a warm snapshot; these are local operations, not counts of files understood by the model. The final-text markup observed during this run motivated the validated-summary display correction. No findings were selected and no coding work was submitted.

### Final Terminal Check (2026-11-09)

Run `d319499a-0553-4fd1-bb5c-efe586ba8b23` completed as `findings_ready` with nine turns, eight inspection calls and 94 seconds. Its final public note exactly matched the validated conclusion summary, without raw tool-call markup. Expanding and paging its large resource list exposed tool-card borders drawing over fixed headers and controls. Turn tool rows are now borderless; the added render regression checks long-resource scrolling and the fixed controls.

The latest source TUI run, `04d976bb-fc79-435f-b88c-b3b3cf1a2bcd`, completed as `findings_ready` with three turns, two inspection calls and 49 seconds. It searched for and read `packages/kilo-sandbox/src/backend.ts`, then explained platform selection without recommending a change. Its first turn reused the 5,000-file indexed inventory without a new scan, returned 42 permitted excerpts and recorded 161 local activity updates. The final turn included the direct read fully and reduced the earlier search to source references. Its public note exactly matched the validated summary and contained no raw tool-call markup.

Terminal window `6932` was inspected with the first turn and resource details expanded. Paging revealed actual source excerpts while the workshop header and navigation controls remained intact. TUI typechecking and scoped lint passed again after the border change, along with all 114 composer/dialog tests. The annotation and Effect facade guards also passed again.

A preceding attempt, `43425cc7-1e07-4672-ad3e-c733907e33e3`, reached the three-minute deadline after seven completed model turns and seven inspection calls, with the eighth turn cancelled. Provider latency and missing public purposes remain real limitations; the successful run does not establish general model reliability.

During Terminal automation, the active input method altered one typed slash command, causing an ordinary chat request instead of enhancement. That request performed one file discovery and one read, then answered; the sandbox files remained unchanged. The exact request was subsequently pasted into the investigative workshop. No investigation findings were selected, no writer was called, and no implementation prompt was staged or submitted during these final checks.

## Interactive Clarification Follow-Up (2026-11-09)

The investigative workshop previously displayed question options as plain text and routed all answers through one general feedback editor. Required clarification now opens a question picker directly. Options support keyboard and mouse selection, with one selection per question and no default. A custom answer can stand alone or add details to the selected option. Enter saves typed text without a model call; the final question's explicit continue action investigates with the answers.

The picker keeps answers when revisiting questions, returning to review, cancelling an investigation or encountering a provider failure. Required questions cannot be skipped; optional skips remain explicit. Existing response/transcript utilities serialize question identities, selections and comments into the API's `answers` field separately from general feedback. Successful rounds accumulate without duplicating failed attempts, and changed questions do not inherit a selection solely because the model reused an ID. Pending answers block writing until they have been investigated.

All 118 composer/dialog tests passed with 743 assertions, covering selection, custom text, required/optional questions, multiple rounds, cancellation, provider errors, small-terminal scrolling and retained review controls. The existing 11 writer tests also passed with 65 assertions. TUI typechecking, scoped lint, upstream annotations and whitespace checks passed. A regression caught an Escape callback returning `false` through the Solid setter, allowing the key to fall through and close the workshop; the callback now returns without that value.

Actual source Kilo was launched in Terminal window `10315` on the user-approved Nemotron free model. `/enhance improve the backend` (`f36f5432-fdda-4a2a-8988-426d396e3dd4`) reached its three-minute deadline after six completed model turns and six tools, with the seventh model call cancelled. A separate clarification-first request (`69e8e07d-706a-4356-bfb5-6911206dd333`) received HTTP 429 before any tool execution. No further retry or model switch was made.

The final live picker interaction remains unverified because of those provider failures. Kilo was left open on the preserved clarification-first request and the rate-limit diagnostic. No answers, findings, writer request or coding prompt were submitted in these live checks; local render/SDK regressions verify the answer interaction and payload mechanics, not provider availability.
