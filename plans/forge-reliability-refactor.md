# Forge Reliability Investigation And Refactor Plan

Status: Implemented and verified. One optional supplied-PDF test was skipped; no live-provider evaluation was performed.

Date: 2026-11-09.

## Execution Status

Implementation baseline: commit `b3d37abc2f015791760346b013cfec6a0f3ffb25` plus the existing worktree changes. Existing edits were preserved. The user chose to retain the other session's concise terminal UI; started/completed counters remain available in backend progress rather than being added to the main status line.

- Completed: separate investigation schemas, response admission, evidence replay, and preparation/handoff orchestration.
- Completed: retain valid inspections from mixed responses; reject malformed arguments without executing them; retain strict conclusion and citation checks.
- Completed: explicit conclusion-only recovery after request/model/scope/freshness revalidation; preserve read history without automatic retries.
- Completed: direct-evidence priority and same-version replay deduplication, including read-to-symbol transitions and retained continuation metadata.
- Completed: shared streaming transport, explicit protocol selection, structured failure stages, correct timeout classification, and lightweight waiting heartbeats.
- Completed: terminal operation state, recovery controls, preserved input on transient revalidation failure, and coalesced activity snapshots.
- Completed: shared domain and terminal fixtures, named HTTP provider scenarios, and split terminal suites with no original cases dropped.
- Completed: SDK regeneration and a grouped changeset.

Final verification:

| Check | Result |
|---|---|
| Full Forge product suite | 1,812 passed, one optional supplied-PDF test skipped, zero failures across 80 files |
| All Forge backend/adapter suites | 245 passed across 32 files, including the 26 named native HTTP scenarios |
| Terminal workflow, clarification, activity, and dialog suites | 129 passed across nine files |
| Affected-package typechecks | 22 successful tasks, including CLI, Forge, Forge UI, TUI, SDK, and their dependencies |
| Real source backend connected to terminal | Passed held waiting, mixed calls, final-envelope rejection, and explicit recovery; three provider calls across two explicit investigation requests |
| Transient refresh recovery | Passed; typed feedback retained and no additional model request |
| Source coding/compaction/restart workflow | Passed |
| Progress coalescing | Synthetic 1,000-update burst produces 20 activity snapshots; heartbeat and lifecycle transitions remain immediate |
| Final native build and smoke tests | Passed; `du -h` reports a 280M CLI artifact |
| Packaged coding/compaction/restart and terminal recovery workflows | Both passed against the rebuilt native CLI |
| Focused refactored-module lint | Zero warnings and zero errors |
| Upstream annotations, Effect facade ratchet, Markdown tables, whitespace | Passed |

Verification caught and corrected a missing event ID in the refresh fixture, an outdated fixture assumption that the first read always remains a full replay, and SQLite test databases inside watched repositories. Terminal bootstrap now waits for the same observable focused-composer condition with a bounded ten-second readiness deadline, avoiding the old two-second setup failure under concurrent builds. No production latency assertion was relaxed. Existing lint warnings in broader, unchanged engine/test code were not used to weaken the focused checks.

Final logs are outside the workspace: `/tmp/forge-refactor-core-verified.log`, `/tmp/forge-refactor-all-cli-final.log`, `/tmp/forge-refactor-tui-verified.log`, `/tmp/forge-refactor-types-verified.log`, `/tmp/forge-refactor-native-release.log`, `/tmp/forge-refactor-packaged-process.log`, and `/tmp/forge-refactor-packaged-tui.log`.

The historical `pre-text.sse` capture was cleaned up by the earlier debug session and was no longer available for exact before/after replay at sign-off. Its previously measured 9,539,168-byte size remains historical evidence. The coalescing reduction above is explicitly synthetic; it is not a measured latency or traffic claim for that old run.

No live Nemotron or other paid-provider evaluation was run. Provider reliability beyond the replayed protocol cases remains an explicit limitation, not a claim implied by passing fixtures.

## Scope And Evidence Limits

This plan targets Forge's investigative enhancement path, its model adapters, terminal UI, and associated tests. It does not propose rewriting the whole Kilo monorepo.

The worktree contains substantial ongoing changes. Investigation code, HTTP fixtures, and terminal code changed during this audit in another session. Findings distinguish saved historical failures from behavior verified in the current source. Line numbers are navigation aids; function names identify the intended boundaries.

Evidence used:

- The supplied screenshot and its exact request ID, `87962e64-c63e-4564-bb86-a9055ae718f2`.
- Read-only queries of `forge_records` in `/Users/bytedance/.local/share/kilo/kilo-local.db`, scoped to this workspace.
- Existing response-shape diagnostics and SSE captures in `/tmp/forge-debug-investigation-response/`.
- Current source inspection and fresh model-free tests.

No new live inference requests were made. No credentials, private prompts, or source excerpts are reproduced here. The runtime debugging instrumentation workflow was not started: existing records and direct code inspection were sufficient for the planning pass. The findings below preserve that initial diagnosis; the execution section above records subsequent implementation.

## Main Conclusion

There is not one "files cannot be read" bug. Several different failures produce the same initial empty activity screen. The code also couples model-response validity, investigation control flow, durable history, and UI diagnostics too tightly.

Refactoring should reduce those responsibilities and improve failure contracts. Adding more provider-specific conditions or more tests of the current branching will not establish that a real investigation works.

## Findings

### F1. A Bad Conclusion Discards Requested Inspection

**Confirmed in the screenshot's saved request; still present in the inspected handler.**

The request completed its first model call after approximately 56.8 seconds. Nemotron returned ten native calls: four inspection requests and six conclusions. One lookup was malformed, and the conclusions included invalid evidence. Forge recorded zero executed tools.

In [`investigation.ts`](../packages/kilo-forge/src/investigation.ts), `investigation().start()` prioritizes any `forge_finish` call before admitting inspections. It validates every conclusion immediately. An invalid conclusion therefore prevents all sibling searches from running. After changing that ordering, the malformed lookup would still encounter the separate whole-batch schema rejection.

This is not evidence of a filesystem or indexing failure. The model responded, but no tool reached execution.

The existing tests deliberately encode terminal-conclusion precedence. Fixing this requires an explicit behavior change, not merely moving code into smaller files.

### F2. Waiting Looks Indistinguishable From No Work

**Confirmed by the screenshot and current source.**

The domain emits "Waiting for the model" and then awaits `ports.turn()` without a wait observer. The adapter returns a completed result, not incremental progress. Non-OAuth completion uses `generateText`; OAuth consumes its stream internally without exposing progress to investigation.

[`turns.tsx`](../packages/tui/src/kilocode/forge/turns.tsx) displays `updated - started`, not elapsed time. The initial values are equal, so the display remains at `0 ms recorded` throughout that wait.

The model-turn counter also counts completed responses, not started requests. "0 model turns" can therefore coexist with an active request. The screen does not distinguish provider setup, transport waiting, response generation, or validation.

This explains the appearance of inactivity, but does not prove why a particular provider takes a long time.

### F3. Failure Reasons Are Lost Across Boundaries

**Confirmed from retained records and current source.**

Of 65 retained workspace investigations, 19 failed or cancelled records contain only:

> No findings were approved; explicitly retry after resolving the failure.

Those records span zero to nine completed model turns and zero to seventeen calls. Their underlying causes cannot be reconstructed from that message. Do not claim they are all the same defect.

`investigation().start()` replaces non-`EnhancementError` failures with that generic text. The investigation SSE error frame carries only a message, unlike legacy enhancement's structured failure payload. Permissions, changed evidence, invalid accounting, storage failure, and other local errors can converge on generic recovery advice.

The three retained deadline-exceeded records are labeled `cancelled`. Current code uses `signal.aborted` for that state without separating deadline expiry from a user's cancellation.

Required change: retain safe cause codes and operation stages end to end. Do not expose raw provider bodies or arbitrary exception messages to achieve this.

### F4. Progress Repeatedly Serializes Accumulated Evidence

**Measured in an existing capture; latency impact is not yet measured.**

`pre-text.sse` is 9,539,168 bytes and contains 250 frames, including 249 progress frames. Its largest frame is 227,945 bytes. It reaches nine observations and ten journal entries, then ends with an error.

Every `progress()` emission includes the accumulated journal and observations. Local activity can emit many times during one inspection. A sliding queue bounds queued frame count, but it does not eliminate repeated serialization or downstream parsing of the full evidence payload.

Do not claim this caused the screenshot's first-turn delay: that request had no observations yet. It is a separate amplification problem once inspection starts.

### F5. Debug Reporting Can Break Model Execution

**Confirmed by control flow in the initial audit; not established as the screenshot's cause. Removed from current source by other ongoing work before the follow-up below.**

At the initial audit, [`investigator.ts`](../packages/opencode/src/kilocode/forge/investigator.ts) awaited `fetch(DEBUG_SERVER_URL)` before and after the model call. These diagnostic requests had no explicit timeout or investigation abort signal. A failed collector could reject the workflow; a stalled collector could consume its deadline.

The pre-request diagnostic was outside the model-call error/finalization wrapper. Other diagnostic calls in `trace.ts` and domain validation were fire-and-forget without rejection handling.

Debug instrumentation should not remain a dependency of successful product execution. Remove temporary reporting after its owning debug session finishes, or use the existing bounded, failure-isolated logging facility.

### F6. Provider Failures And Model Protocol Failures Need Different Recovery

**Confirmed historically; not all are current unresolved code defects.**

The retained records include:

| Failure | Retained occurrences | What is established |
|---|---|---|
| HTTP 429 | 9 | Provider rejected requests before tools ran. Local indexing changes cannot fix quota or rate limits. |
| HTTP 400 | 3 | Requests were rejected. The old generic message does not establish the exact rejected parameter. |
| No tool calls | 4 | Model returned no executable investigation action. |
| Deadline exceeded | 3 | Work exceeded its overall time budget after several reads. |
| Multiple conclusions | 2 | Earlier protocol handling rejected the model's response shape. |
| Invalid lookup arguments | 1 | A malformed inspection stopped an existing investigation. |
| Oversized retained observation | 1 | Local evidence retention limits stopped admission. |

These are historical development records across revisions, not an unbiased success-rate benchmark.

The current worktree now preserves public text-only responses as `needs_input`, defaults a missing question `optional` flag to false, and improves some provider diagnostics. These changes pass targeted tests. They do not guarantee that the model inspects files: an arbitrary public preamble with no tool call still becomes a clarification state.

Do not globally force `tool_choice: required`. An existing live debug capture using it produced repeated conclusion calls, including empty payloads, and exhausted 4,000 output tokens. Routed aliases also have distinct capability constraints.

### F7. Several Important Conditions Remain Unmeasured

These are refactor inputs or targeted follow-ups, not confirmed causes of the reported failure:

- Evidence validation repeatedly revisits all collected sources before and after operations. Preserve its authorization and freshness guarantees; measure its cost before introducing caching.
- Search and relationship expansion suppress some candidate errors and continue. Distinguish a rejected candidate from backend unavailability without revealing withheld data.
- Terminal refresh handling treats any refresh error as changed evidence/access and resets generated state. A network outage should block acceptance without being mislabeled as a proven revocation or discarding user-authored input.
- OAuth uses a conservative byte allowance while ordinary providers receive an output-token cap. This is documented policy, not proof of a tokenizer bug. Name the units explicitly and keep the distinction in tests and UI.
- A request trace can be `completed` while its investigation fails validation. Transport completion and accepted findings are different outcomes; the UI and reports should not treat one as proof of the other.

### F8. Final Envelope Rejection After Successful Inspection

**Follow-up screenshot, 2026-11-09: confirmed saved failure and local validator reproduction.**

Investigation `9e9a972c-f671-4c67-9d60-25f7c637fb43` completed ten model turns and nine tools in 68,084 ms. It performed four searches and five direct reads. Its final request, `3350895c-fa06-42fa-b0f1-045b37ea4531`, failed with `Invalid findings or clarification format (check unknowns)`.

This run did read files. The failure was final response validation, not absent file access.

The response envelope allows `intent`, `summary`, `findings`, `questions`, and `limitations`. `unknowns` belongs inside a finding. Running the actual `findings()` validator with an otherwise valid empty conclusion succeeds; adding only a top-level `unknowns: []` reproduces the screenshot's exact diagnostic.

The raw rejected conclusion is not retained in the journal, so this reproduction establishes the rejection mechanism, not every field or value in the original provider response.

Current work in another session now discards malformed individual proposals with a warning, preserving valid siblings. That does not address an unexpected top-level field: envelope validation still fails before proposal-level handling. This is another reason to define one response-boundary policy instead of repeatedly adding exceptions for individual finding fields.

Recovery should retain the read history and distinguish an unusable conclusion from a failed investigation transport. An explicitly requested conclusion-only retry should revalidate the retained evidence and use a fresh bounded request, without automatically replaying the entire investigation. Unsupported findings must still remain unapproved.

### F9. Repeated Reads And Context Eviction Consume The Budget

**Confirmed observations and replay membership; their effect on model decisions is inferred, not proven.**

In the same follow-up investigation:

- `packages/kilo-sandbox/src/backend.ts:1-125` was read on turns 2, 5, and 7, returning the same source ID.
- `packages/kilo-sandbox/test/backend.test.ts:1-160` was read on turns 3 and 8, returning the same source ID. Neither direct read advanced to the reported continuation at line 161.
- Before turns 5 and 7, only the newest search result was replayed in full; the preceding direct reads were reduced to metadata.
- Turn 8 included three full results, all from the repeated backend read.
- The final turn included only the newest search result in full, with all eight earlier results reduced to source references.
- Recorded cumulative request accounting reached 347,824 bytes. The final turn was reserved by the cumulative budget condition, not the three-minute deadline.

`history()` budgets raw observations newest-first without deduplicating identical source content. Large search results can replace direct evidence, while repeated reads can occupy multiple full-result slots. The saved sequence is consistent with a read/evict/read cycle, but does not establish that eviction was the model's sole reason for repeating reads.

Refactor context selection separately from the immutable tool journal. Deduplicate replayed excerpts by source identity and version, keep explicit continuation metadata, and evaluate retaining directly inspected evidence ahead of broad search results. Repeated reads after an actual source change must still work; do not impose a blind no-repeat rule.

## Why The Current Tests Miss This

Fresh checks in the initial audit:

| Check | Result |
|---|---|
| Forge domain investigation tests | 43 passed |
| CLI investigation, failure classifier, and OAuth completion tests | 44 passed |
| TUI composer tests filtered by `investigat` | 15 passed; 78 filtered out |
| Forge package typecheck | Passed |

That is 102 passing targeted tests, not a full-repository or live-provider verification.

Logs are outside the workspace: `/tmp/forge-investigation-audit-{domain,protocol,tui,types}.log`.

Specific gaps:

1. The domain test "a terminal conclusion skips sibling reads" verifies the current policy that contributes to F1. It is a characterization test, not a guarantee of useful investigation.
2. The HTTP suite's mode-driven fixture synthesizes mostly well-behaved tool exchanges. Separate tests for batching and malformed conclusions do not cover their observed combination with malformed inspection siblings.
3. The slow-turn test changes `Date.now()` with `setSystemTime`. It tests budget arithmetic, not whether a held request emits progress, cancels promptly, or finishes terminal persistence.
4. The live TUI activity test starts from a completed tool turn and supplies frames itself. It does not exercise the initial model wait through the production backend.
5. The existing source-process test is valuable for provenance, restart, and admission. Its deterministic successful provider does not establish real-model protocol reliability.
6. Provider formatting expectations changed during this audit. An initial `required` case failed; the latest suite expects `auto` and passes. Do not use that change alone as evidence that the user-visible failure is fixed.

The tests are not all disposable. Real SQLite, path permissions, source freshness, cancellation ordering, cross-session isolation, and actual terminal rendering protect different boundaries. Remove a case only after naming the behavior and demonstrating equivalent coverage.

## Refactor Boundaries

Observed concentrations: `engine.ts` is 1,456 lines, `store.ts` 823, `investigation.ts` 523, `workshop.tsx` 480, and the composer test file 2,418. Line count alone is not a defect; mixed responsibilities and duplicated decisions are the targets.

| Boundary | Responsibility | What should leave it |
|---|---|---|
| Model transport | Provider resolution, SDK invocation, streaming lifecycle, cancellation, usage and safe transport errors | Domain findings, UI text, implicit retry decisions |
| Investigation decision logic | Admit bounded actions; distinguish inspection, conclusion, clarification, and unusable output | SDK types, storage writes, presentation assembly |
| Evidence admission | Permissions, source identity/freshness, destination and purge fences | Provider formatting and UI progress |
| Persistence and observation | Revision-checked snapshots, safe failure records, lightweight progress | Model choices and evidence-validity policy |
| Workshop controller and views | User input, current operation, review/stage transitions, rendering | Reconstructing domain failure meaning from strings |

Keep the current public `Engine` API initially. Reuse existing repository, retrieval, capability, storage, and writing modules. Do not introduce a new workflow framework, generic event-sourcing system, parallel model runtime, or another top-level service layer.

## Implementation Sequence

### 1. Stabilize The Baseline And Add Missing Replays

- Establish one owner for the overlapping investigation edits and record the exact source revision/worktree snapshot used for verification.
- Preserve the sanitized response shapes from F1 and the prior repeated-conclusion capture as transport fixtures. Keep IDs structurally valid without copying private source content.
- Add separate cases for an invalid conclusion beside a valid read, invalid inspection arguments beside a valid read, a text-only preamble, conflicting conclusions, and response truncation.
- Cover unexpected top-level fields separately from malformed individual findings. Include the exact `unknowns` rejection mechanism from F8.
- Replay F9's search/read sequence and assert source-version deduplication, continuation visibility, and final-turn evidence availability within the same byte budget.
- Add a held-provider test using readiness/release signals. It must observe the initial wait through the backend and terminal, not inject a successful UI frame.
- Label existing behavior assertions as characterization where the intended contract will change.

Acceptance: demonstrate the current failures or explicit characterization results before the production changes. Routine tests remain model-free.

### 2. Make Failures And Waiting Honest

- Remove critical-path temporary debug calls in coordination with their owner.
- Carry a safe failure code, stage, request ID, and retry guidance through persistence, HTTP, SSE, and UI.
- Separate timeout, user cancellation, source invalidation, provider rejection, and invalid model output.
- Display started versus completed model turns and elapsed waiting time.
- Add a bounded in-memory heartbeat that does not update durable revisions or resend evidence.
- Show neutral request activity, not invented public model commentary or private reasoning.
- On a transient refresh failure, preserve user input and block acceptance pending successful revalidation.

Acceptance: held requests visibly age; cancellation and timeout have distinct terminal outcomes; an unavailable debug collector cannot alter application execution.

### 3. Extract And Correct Response Admission

- Introduce one explicit decision result for inspection, conclusion, clarification, or unusable model output. Keep schemas and validation ownership clear.
- Recommended mixed-response policy: never accept a conclusion based on sibling reads that have not executed. Discard premature conclusions explicitly; allow independently schema-valid inspections only after the usual permission, freshness, and budget checks.
- Never coerce malformed paths, invent tool arguments, accept guessed citations, or turn permission denial into a retryable model-format error.
- Account for rejected requests and feedback within explicit per-turn/attempt limits so malformed responses cannot create an unbounded repair loop.
- A malformed conclusion alone remains a visible failure. Distinct competing conclusions must not be silently selected.
- Preserve successful inspection as recoverable work when conclusion formatting fails. Reusing that evidence for an explicit retry requires current permission, destination, and freshness checks.
- Public text without calls is an unstructured response, not automatically a genuine missing-user-input decision.
- Preserve zero automatic POST retries and zero silent model switches. Any additional model turn must be a bounded continuation with new tool feedback, not a hidden retry of the same failed request.

Acceptance: the mixed-response replay reaches a permitted file read, preserves rejected-call diagnostics, and cannot approve findings until a later valid conclusion cites actually observed evidence.

### 4. Consolidate Transport And Reduce State Duplication

- Share SDK invocation and stream consumption between `completion.ts`, investigative turn/writer calls, and legacy enhancement where the transport behavior is genuinely the same.
- Keep legacy enhancement, investigation, and writer budgets/output contracts explicit. Do not unify them by silently changing semantics.
- Replace the uninformative OAuth boolean at the call boundary with an explicit resolved transport capability description.
- Keep byte safety bounds, provider token usage, reasoning counts, and unknown usage distinct.
- Move orchestration out of the broad `engine.ts` closure without duplicating existing evidence or storage services. Keep the facade and endpoints stable in this phase.
- Separate the workshop request/controller logic from rendering. Use a small discriminated operation state instead of adding more independent booleans.

Acceptance: one owner per transport concern, no new Promise facade in shared upstream Effect services, unchanged legacy behavior, and preserved source/permission guarantees.

### 5. Reduce Progress Traffic And Simplify Test Organization

- Keep evidence in the durable investigation record and existing resource views; use lightweight progress for current stage, counters, timing, and bounded activity.
- Coalesce progress updates before serialization. Retain terminal delivery and revalidation.
- Do not put loss-sensitive deltas onto the current sliding queue without sequence/recovery semantics. Prefer coalesced snapshots first.
- Partition the composer suite by behavior: legacy enhancement, investigation controls, clarification, activity/resources, and admission.
- Extract repeated fixture setup, not production decision logic, into one small shared harness.
- Replace the monolithic HTTP mode branch with named scenario data and one transport fixture. Reuse captured response fixtures across domain/adapter tests only where each test verifies a distinct boundary.
- Keep a small source-backend workflow suite and separately authorized live-model checks. Do not delete lifecycle or permission tests to reach a line-count target.

Acceptance: the saved 250-frame workload has substantially reduced serialized traffic without losing terminal state, source visibility rules, cancellation, or navigation behavior. Record before/after bytes rather than claiming an unmeasured speedup.

## Required Verification Matrix

| Scenario | Required observable result |
|---|---|
| Initial model request held open | Elapsed wait changes; zero reads remain honest; controls stay usable |
| Mixed calls from the screenshot | Valid inspection can execute; premature/invalid conclusions never become findings |
| Malformed inspection sibling | No malformed call executes; no guessed arguments; bounded documented recovery |
| Unexpected final-envelope field after reads | Read history survives; cause is explicit; no unsupported finding approved or automatic full rerun |
| Repeated unchanged reads plus broad searches | Replay deduplicates source versions and retains useful direct evidence within the budget |
| Text-only promise to inspect | No false "findings ready"; no fabricated clarification question |
| HTTP 400/401/429 and network failure | Safe distinct cause and stage; no hidden retry or provider switch |
| User cancel and deadline | Distinct outcomes; late calls/results rejected; terminal persistence settles |
| Permission/source/destination change | No stale or unapproved evidence sent, staged, or resurrected |
| Missing usage and token/byte bounds | Unknown is not zero; units are explicit; output cannot grow unbounded |
| High-volume progress | Measured byte/frame bounds; terminal result cannot be dropped |
| Restart and explicit recovery | No automatic paid work; prior reviewed draft and user answers preserved |
| Local versus packaged CLI | Same workflow/provenance guarantees using isolated state |

Suggested first regression gate:

```sh
# From packages/kilo-forge
bun test ./test/repository.test.ts ./test/investigation.test.ts ./test/writing.test.ts
bun run typecheck

# From packages/opencode
bun test ./test/kilocode/forge-investigation.test.ts ./test/kilocode/forge-enhancement-failure.test.ts ./test/kilocode/forge-oauth.test.ts
bun test ./test/kilocode/forge-investigation-process.test.ts
bun run typecheck

# From packages/tui
bun test ./test/kilocode/forge-composer.test.tsx ./test/kilocode/forge-dialog.test.tsx
bun run typecheck
```

Run scoped lint and the relevant repository guards before implementation sign-off. Changes to server response contracts require SDK regeneration; do not hand-edit generated clients. Add one concise changeset for user-facing behavior changes.

Live evaluation requires separate authorization and an available account/model. It should test explicit file-inspection tasks as well as genuinely ambiguous requests, and report read completion separately from clarification and transport success.

## Completion Criteria

- The original symptom is verified through the real source backend and UI, not just domain fixtures.
- The failure inventory is smaller because causes were fixed or classified, not because diagnostics were hidden.
- Test deletion is justified by equivalent behavior coverage; obsolete behavior assertions are replaced deliberately.
- Duplicate transport and controller logic is removed, rather than preserved behind additional wrappers.
- No permission, freshness, purge, draft-preservation, or explicit-submission guarantees are weakened.
- Remaining live-provider uncertainty and skipped checks are stated explicitly.

Implementation proceeded in the existing worktree without reverting other work. The user's decision to retain the other session's UI direction supersedes the earlier proposal to add detailed counters to the main status line.
