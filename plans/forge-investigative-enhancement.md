# Investigative Prompt Enhancement

Date: 2026-11-06  
Status: Implementation authorized by the user and delivered behind `investigation: true`. See [validation results and remaining release gates](forge-investigative-validation.md). Live comparative evaluation, external-provider smoke tests, and M9 runtime diagnostics remain separately gated.

## Implementation Notes

The investigator, findings review, explicit direction selection, tool-free writer, and structured composer/message handoff are implemented. Legacy `/forge/enhance` behavior remains available. Repository indexing now supports warm dirty-path batches, and the investigator supports direct literal discovery plus dependency-specific documentation follow-ups.

Clarifications adopted during implementation:

- Freshness is mandatory for review, generation, staging, and new prepared submissions. Already-submitted repository evidence is historical context: intended coding edits must not deadlock the task. Current source eligibility, exclusions, permissions, private-document versions, and provider destinations remain enforced during later calls, compaction, and resume.
- New task feedback requires explicit re-investigation before writing from old findings. Wording-only amendments use prompt editing.
- Writing uses one revision-checked POST rather than a second streaming endpoint; investigation streams bounded progress and a validated terminal result.
- Delta scans avoid unchanged file reads/parses, while extraction-stamp verification and cross-file relationship resolution still traverse the retained inventory. The measurements are not a claim of constant-time whole-index refresh.
- The published resolution matrix is intentionally bounded: exact package exports and local aliases are supported; wildcard exports, inherited TS configuration, dynamic dispatch, and ambiguous installed versions remain unresolved.
- Completed investigative records are retained separately from pruned request traces until explicit Forge purge. Restart detection records interrupted work without restarting provider calls.
- Greedy remains the default selector. Four-arm evaluation tooling exists, but no live coding-quality or total-token superiority claim has been made.

See the [validation report](forge-investigative-validation.md), [Forge feature status](forge.md), and maintained commands in [Forge testing](../packages/kilo-forge/TESTING.md).

## 1. Outcome

Turn `/enhance` from a repository-informed rewriter into a bounded investigation workshop:

```text
Request + permitted task context
  -> interpret intent
  -> investigate with read-only tools
  -> present supported findings and recommendations
  -> user chooses or adjusts direction
  -> write a concise implementation prompt
  -> review/edit and stage in the composer
  -> separate user submission to Kilo's existing coding agent
```

The agent should know how to discover what matters, not assume that it already knows the answer. Search rankings, an index entry, and a model's confidence are not proof of a defect.

**First milestone:** a user can say "help me fix X" without naming the broken files, receive a supported explanation and proposed direction, and stage a focused prompt. Enhancement does not change the application, run arbitrary commands, or submit the prompt automatically.

**Full goal:** B supplies accurate and efficiently refreshed repository evidence; C supplies relevant, version-aware documentation when needed; D controls evidence and prompt size without discarding necessary support; E connects this preparation to the existing coding workflow with intact approval and verification boundaries.

## 2. Current Baseline

This plan uses the current working tree, not the deleted historical reports. [Forge status](forge.md), [product usage](../packages/kilo-forge/README.md), and [testing guidance](../packages/kilo-forge/TESTING.md) remain the baseline documentation.

| Area | Present implementation | Gap to close |
|---|---|---|
| A: Enhancement | `engine.enhance()` retrieves evidence and invokes structured generation; review, edits, clarifications, model choice, and cancellation exist. | No adaptive tool-use loop before writing; findings and direction selection are not the central contract. |
| B: Repository intelligence | Tree-sitter symbols/imports for a bounded language set, SQLite FTS/BM25, optional semantic search, relationship expansion, freshness checks, and watcher-triggered refresh. | Refresh still traverses and reads supported files before extraction reuse. Relationships are not a complete call graph. Semantic availability and supported coverage must be explicit. |
| C: Documentation | Manifest/lockfile metadata, local docs, configured Context7 access, source metadata, and caching. | Enhancement cannot ask follow-up documentation questions. Dependency choice is heuristic and limited; documentation version compatibility is not established merely by a project version. |
| D: Context | RRF, redundancy checks, ranked/greedy/knapsack-style selection, evidence budgets, and selection audit. | The composer still receives the selected raw bundle. Budget units are conservative UTF-8 bytes, not measured provider tokens. Task-relevant retention and coding outcomes need fresh evaluation. |
| E: Harness | Internal TUI plugin, four Forge coding tools, HTTP/SSE, SDK, evidence lineage, permission checks, and ordinary Kilo execution. | Reuse these capabilities during preparation; preserve lifecycle, scope, and consent across multiple calls, review revisions, and the new handoff. |

Existing `/ideas` already generates opportunities, searches for counterevidence, and reviews whether a proposal is unsupported or already implemented. Reuse its evidence-review principles, not its fixed sequence as a substitute for investigation.

Current focused checks performed for this plan:

- Core: 62 tests passed across `catalog`, `inspection`, `preparation-response`, and `context`.
- CLI: 4 tests passed across `forge-tools` and `forge-storage`. The previously reported SQL placeholder failure does not reproduce; the adapter now passes SQL and values separately.
- CLI fixture warnings about unavailable Git/memory services remain visible. These runs do not establish live provider behavior, full-suite health, or product-quality improvement.
- No external model calls, full-process UI validation, or new live comparative study were performed for this plan.

## 3. User Experience

### Interpret the request

Use the original request, explicit amendments, task attachments, and deliberately included current-session context. An editor selection or recent message can help resolve "this", but must not silently add unrelated history or broaden permissions.

| Request | Investigation objective | Appropriate output |
|---|---|---|
| "Fix duplicate orders" | Trace creation and retry paths, callers, persistence, uniqueness rules, and tests. | A supported defect hypothesis or confirmed code discrepancy, the smallest corrective direction, and verification. |
| "Improve the database" | Identify the real data layer and relevant goals; inspect schemas, queries, migrations, and tests. | A few ranked opportunities, with benefits, trade-offs, and evidence. No assumed performance bottleneck without measurements. |
| "Add export" | Find extension points, existing export patterns, data contracts, and compatibility constraints. | An implementation direction grounded in current architecture; genuinely missing product choices remain questions. |
| "Why is this slow?" | Locate the path and available measurements; distinguish possible causes from observations. | Findings plus a diagnostic prompt if the available evidence cannot establish the cause. |
| "Fix it" with no usable referent | Look for a clear permitted task referent first. | One focused clarification if the target remains unknown, not a repository-wide search for arbitrary defects. |

Intent categories guide investigation; they are not rigid keyword routing. Mixed requests can have multiple objectives. The first investigator turn interprets intent and chooses a next step, avoiding a mandatory extra classification-model call.

### Review before writing

Show a short task interpretation and coverage summary, then recommendation cards. Each card includes the issue/opportunity, why it matters, supporting locations, certainty and limitations, the proposed action, and how to check it.

Controls: select, reject, inspect source, give feedback, investigate further, and write prompt. A single clear recommendation still needs an explicit "Write prompt" action. Multiple recommendations must not silently become a bundled project.

Empty findings are valid. Offer "No supported issue found" or a selected diagnostic direction rather than manufacturing work. Ranking favors relevance to the user's goal, strength of support, expected benefit, and bounded scope; speculative severity must not dominate.

After generation, keep edit and "Use prompt" as separate controls. "Use prompt" stages only; ordinary chat submission is still the execution boundary.

## 4. Architecture

### Ownership

| Location | Responsibility |
|---|---|
| `packages/kilo-forge/src/` | Intent, investigation state machine, typed actions/results, findings, selection, evidence dependencies, budgets, and prompt preparation. |
| `packages/opencode/src/kilocode/forge/` | Existing provider integration, filesystem/MCP/permission adapters, accounting, lifecycle, and transport checks. |
| `packages/opencode/src/kilocode/server/httpapi/` | Thin scoped endpoints and SSE handlers. |
| `packages/tui/src/kilocode/forge/` | Workshop flow, findings/direction review, input retention, activity, and composer staging. |
| `packages/kilo-forge-ui/` | Shared source, knowledge, and context inspection parity where the new records are displayed. No unnecessary second workshop implementation. |
| `packages/kilo-indexing/` | Reuse parser/vector infrastructure and appropriate watcher mechanisms without making lexical inspection depend on embeddings. |
| `packages/sdk/js/` | Regenerated API contracts; never hand-edit generated clients. |

Prefer focused new Kilo-owned modules such as `investigation.ts`, `findings.ts`, and `handoff.ts`, with small orchestration calls from the engine. Final names follow existing conventions. Do not split unrelated shared code or rebuild Kilo's coding runtime.

### One investigator, one writer

The domain layer owns the loop, operation limits, allowed actions, and state transitions. A host adapter performs **one model turn** and returns validated actions or a findings result. It must not hide an unbounded SDK multi-step loop.

Use existing provider resolution, transformations, tracing, permissions, and Effect service boundaries. Do not instantiate a new runtime for each tool call or start a normal build-agent session merely to prepare a prompt.

Expose shared domain operations to both the new investigator and existing Forge coding tools. Do not invoke `ForgeTools` recursively through `Forge.Service`, since those tools already resolve the engine. Keep host permission enforcement on both entry paths.

The writer is a separate tool-free call. Initially it uses the same explicitly selected model and approved destination. No automatic model substitution, paid repair, or transport retry. Unsupported tool calling yields a clear capability error and an explicit choice to change models or use the legacy rewrite; do not silently claim an investigation happened.

### State and contracts

Add versioned records, distinct from provider response JSON:

| Record | Required information |
|---|---|
| Intent | Original text, ordered human amendments, explicit goals/non-goals, target hypotheses, relevant user-message/attachment references, and unresolved user-owned decisions. |
| Investigation | ID/revision, canonical workspace, exact session or ephemeral draft scope, model/destination, access-policy versions, allowed capabilities, limits, state, stop reason, and usage. |
| Observation | Tool/call ID, validated input, execution status, original source ID/hash/range, timestamp, coverage/truncation, provenance, and access dependencies. |
| Finding | Claim, kind, support classification, supporting and opposing observations, unknowns, relevance/impact, smallest action, verification, and prerequisites. |
| Direction | Explicitly selected finding IDs and revisions, user additions/rejections, scope, unresolved blockers, and inherited evidence dependencies. |
| Prompt | Generated task, human edits, selected direction revision, supporting dependencies, prompt digest, and validation status. |

Separate `kind` (defect, improvement, feature gap, diagnostic) from support (observed, inferred, unresolved, contradicted) and from user approval. A user choosing a finding does not prove it correct. "Confirmed" in the UI must specify whether it means a checked code discrepancy or an actual runtime observation; a test declaration is never a passing/failing test run.

Suggested operation states:

```text
draft -> interpreting -> investigating -> findings_ready
                         |                   |
                         v                   v
                 needs_input/limited    direction_selected
                                             |
                                             v
                                          writing
                                             |
                                             v
                                        prompt_review -> staged
```

`cancelled`, `failed`, `interrupted`, and `stale` are explicit outcomes. A partial stream is not an accepted finding or prompt. More investigation creates a revision; it does not overwrite the last reviewed result. Feedback that changes the target invalidates dependent findings and direction; cosmetic prompt edits do not trigger research automatically.

Persist completed revisions and bounded activity, not hidden model reasoning. Backend restart interrupts active work; reopening can show retained results but cannot restart paid work without action. Cancellation/disconnect aborts active operations locally and prevents new work; it cannot guarantee a provider has stopped processing. No reconnecting POST can launch duplicate work.

## 5. Investigation and Safety

### Initial capabilities

| Capability | Purpose and boundary |
|---|---|
| Repository search | BM25 and, only when configured and approved, semantic lookup; allow multiple focused queries and expose channel failures. |
| Path/text lookup | Bounded literal search/listing over eligible repository files when an index is incomplete; no shell interpolation or unbounded regex execution. |
| File-range read | Read current implementation ranges with line numbers, file hash, original-source identity, truncation, and next-range metadata. |
| Symbol/relationships | Inspect declarations, imports, reverse imports, test links, and explicitly labeled inferred associations. |
| Local documentation | Search/read local permitted docs and dependency manifests/lockfiles. |
| Finish/request input | Submit structured findings or one necessary clarification, subject to local validation. |

The first release permits repository inspection and explicitly approved task material only. Direct reads must not bypass exclusions, sensitive-file rules, collection enrollment/sharing, or worktree boundaries simply because a file was not indexed. Unindexed text may be read within these same policies; unsupported binary/oversized files remain explicitly unavailable.

Implement a bounded-read path using actual byte limits, not only `stat` checks. Resolve canonical paths, reject symlink escapes, validate file identity around reading, and hash the bytes actually observed. For registered documents inside the repository, use the registered-source policy, not a weaker filesystem path.

The agent follows leads until it can support a useful direction, finds conflicting/insufficient evidence, or exhausts a limit. It should inspect the actual implementation and relevant callers/tests when needed, check plausible alternative explanations, and account for already-implemented behavior. Do not require ceremonial searches when a small task is already established.

Suggested initial limits, to be confirmed before implementation:

- At most 12 investigator model turns and 24 tool invocations per attempt; one investigator operation at a time per draft.
- At most 2 independent read tools concurrently; serialize dependent reads and count every action against the same limits.
- Three-minute investigation deadline including initial repository preparation; report indexing time separately and offer explicit retry/continuation if necessary.
- File reads default to 160 lines and at most 16 KiB of returned text; longer reads use bounded explicit continuation.
- Per-turn evidence budget starts at the existing 24,000 UTF-8-byte estimate. Bound the entire request and cumulative replayed input separately using model limits and reserved output capacity.
- Reserve capacity for a final findings turn; at an exhausted deadline, return validated partial observations with a limit reason rather than starting another call.
- One writer call, at most 60 seconds, with a proposed 4,000-output-token ceiling; acceptance validation retains a 30-second deadline.

Before the first implementation milestone, set a concrete cumulative request-budget default from the chosen provider/model limits and fixture measurements. Label estimated and reported usage separately. Stop before further calls if required accounting cannot be bounded. Limits are client admission controls, not a guaranteed provider invoice cap, and aborting an admitted call may not stop billing.

### Authority and source boundaries

- Tool registration is allowlisted in code. Never expose edit/write/bash, migration, arbitrary MCP, browser automation, or subagent-spawn tools to the investigator.
- Reuse Kilo deny/ask semantics and source-specific sharing checks. A recommendation never authorizes a sensitive action. Repository inspection can update Forge's own index/operation records, not application files.
- Keep the original user request/amendments, generated findings, repository content, and tool results as separate typed inputs. Retrieved instructions must not be concatenated into system messages.
- Repository `AGENTS.md` or prompt templates may be relevant evidence; the investigator does not treat their embedded commands as live authority. Normal coding-agent instruction loading remains Kilo's responsibility.
- No autonomous workspace/session-wide memory publication. Old summaries and `/ideas` outputs are leads, not independent corroboration; follow their dependencies to original evidence.
- Show public action/result summaries, not chain-of-thought, raw credentials, or sensitive denied-source previews.
- A delimiter such as `<forge-evidence>` is not a security boundary. Enforce capabilities, source eligibility, output contracts, and adversarial tests regardless of model compliance.

### Freshness and revocation

Bind observations and generated claims to source hashes plus policy, collection, session, and destination versions. Derived findings and prompts inherit these restrictions; removing raw excerpts does not make private information public.

Validate the whole outgoing evidence dependency set before every model call, findings publication, prompt generation, acceptance, and eventual coding send. If evidence changes, invalidate dependent findings and require review rather than silently deleting support or changing the claim.

Use immutable captured bytes and a coherent access revision for each send admission. Coordinate admission and revocation within the service so revocation before admission blocks the call. Record already-admitted requests honestly; revocation cannot unsend bytes. Filesystem checks do not guarantee the file cannot change after reading; timestamps/hashes identify the observed version, and later changes invalidate subsequent reuse.

## 6. Finish B: Repository Intelligence

1. Add a file-keyed extraction manifest and a dirty-path batch. Reuse suitable watcher infrastructure, but keep the lexical inventory operational when embeddings are disabled.
2. Subscribe before initial scan, buffer events during scanning, and apply them before publishing a clean generation. Handle rename as old-path removal plus new-path indexing.
3. Re-read/reparse only changed files in the normal warm path. Update FTS records and affected graph edges transactionally. A changed target may require re-resolving importers without reparsing unrelated source.
4. Treat ignore/config/lockfile/parser-version changes as explicit broader invalidations. Missing filenames, watcher overflow, restart, and corrupted state trigger bounded reconciliation/full rebuild with visible status.
5. Preserve authoritative file originals and bind vector hits back to current source content. Filter ineligible hits before limits; refill bounded candidate pages when stale/denied hits would otherwise hide eligible evidence.
6. Publish the supported language/import-resolution matrix. Cover TS/JS/Python first, including relevant aliases and workspace-package exports. Dynamic dispatch/imports remain unresolved unless separately proven; text matches are not exact call edges.
7. Improve monorepo dependency/version resolution using the owning package and applicable lockfile/workspace mapping. Do not apply a root package version to every package indiscriminately.

**B completion gates:** cold build and warm deltas yield equivalent source/relationship/search results after normalizing observation metadata; create/edit/delete/rename tests pass; one-file changes do not reread all file bodies; unchanged sources are not re-embedded; missed-event reconciliation recovers; the lexical path works without a vector provider. Record files visited/read/parsed, vector calls, latency, and memory on small and 5,000-file fixtures.

## 7. Finish C: Documentation-Aware Agentic RAG

1. Let the investigator decide when technical documentation is needed and issue follow-up queries based on gaps. Always inspect local project conventions first where relevant.
2. Accept an explicit dependency/source ID and focused question in the docs capability. Resolve the owning package/version and approved MCP library identity; replace the current arbitrary top-two dependency choice for this path.
3. Bound and split responses into cited original passages. Preserve provider, library ID, source URL/locator, retrieval time, project version, and independently reported documentation version.
4. Cache by provider/destination, library/version, query, scope, and relevant access/configuration dependencies. Invalidate for dependency changes, expiry, access revocation, or provider changes. A cache hit cannot skip current authorization.
5. Prefer compatible versioned results when the provider supports them. Otherwise show an explicit compatibility limitation; if that uncertainty matters, recommend verification rather than inventing API behavior.
6. No automatic server installation, credential discovery, embedding enrollment, or new egress approval. With no external adapter, continue locally and report the knowledge gap.

**C completion gates:** local-only, cache-hit/miss, version mismatch, wrong-library, duplicate-name monorepo, provider-offline, revoked-cache, and malicious-doc fixtures pass. A multi-step fixture must demonstrate a second query caused by insufficient initial evidence. Configured external adapter support requires a separate approved real-provider contract smoke test; fixture success alone does not certify that integration.

## 8. Finish D: Context and Prompt Quality

### Separate three budgets

1. Retrieval candidates: broad enough to find useful leads within source/access limits.
2. Investigator working context: relevant originals plus a compact observation ledger, not all tool outputs replayed forever.
3. Writer/handoff: original requirements, chosen direction, necessary findings, and minimal supporting references.

Retain RRF as a retrieval ranking method. Keep greedy as the default until a measured alternative earns replacement. Compare ranked, greedy, and knapsack-style selection on the same admitted candidate pool and budgets.

Selection must preserve complementary support and counterevidence. Prefer unique relevant facts over repeated topical matches; do not impose a rigid per-file quota that excludes a legitimately central implementation. Source scores express retrieval relevance, not correctness.

Budget citation headers, separators, replayed context, schemas, and output reserves. Keep claims with required evidence together; if they cannot fit, narrow scope or report a limit. Do not summarize away user constraints, uncertainty, or contradictory evidence.

### Writer contract

Input: original request/amendments, explicit direction selection, validated findings, essential current references, and unresolved constraints. Do not pass the complete tool transcript or unselected opportunities.

Output: objective, supported issue/direction, affected components, important constraints/non-goals, and verification. Existing paths and tests must be grounded; new paths or tests are explicitly proposed. Unverified commands stay labeled proposed and are never shown as executed.

Aim for approximately 200-500 words for an ordinary task, with shorter output when sufficient. This is a presentation target, not permission to truncate an unusually detailed user requirement. Do not require eight sections or generic caution paragraphs for every request.

A provenance validator checks every structured claim/reference and rejects invented IDs, stale support, missing requirement references, and unselected finding references. Give explicit requirements stable IDs, preserve exact user-specified literals, and require coverage in the output contract. Semantic faithfulness still needs behavior tests and evaluation; valid JSON/citations alone cannot prove that the prose preserves a requirement or supports a claim.

### Handoff

Replace `prepared(..., item.context.text, ...)` on the new path. Stage the concise prompt with a validated preparation reference and human-readable source locators. Only explicit, necessary excerpts are quoted; no automatic raw bundle.

Store the selected findings/evidence separately in scoped Forge state. Preserve dependency lineage through revisions, submission, and normal Kilo compaction/resume; an ID in text remains a lookup hint, never approval. Missing or stale records block validated staging of dependent generated content. Preserve the user's own input/amendments and offer re-investigation. Revocation also withholds dependent generated content from subsequent views; an "unverified" label must never bypass privacy checks.

Keep preparation ID/revision, prompt digest, and dependency bindings in structured draft/message metadata outside the editable prompt. Server-side staging/send validation reloads authoritative records in the current scope; client-supplied findings, digests, and textual markers are not trusted as approval. Use existing metadata hooks where possible and only a minimal annotated shared-message hook if required.

Human edits amend the task and create an updated prompt revision/digest. They cannot silently strip provenance or convert generated private claims into unrestricted text. Preserve original attachments and agent mentions, normal composer behavior, and ask/build permission choice. These checks protect the in-app workflow; they cannot revoke content already copied, exported, or sent outside it.

**D completion gates:** the `plan.txt` prompt-injection regression does not change agent mode, tools, or task; unselected recommendations/raw activity never appear in the staged prompt; mandatory facts/constraints/counterevidence survive; serialization stays within budgets; representative edited prompts remain actionable. Token savings and non-regressing coding success require the matched evaluation in section 12.

## 9. Finish E: Runtime, API, and Review Integration

Add explicit investigation and writing operations rather than overloading `Proposal.ready` to mean both "findings available" and "ready to implement."

Suggested additive API shape, finalized with schemas before implementation:

- `POST /forge/investigations/stream`: start or explicitly continue an investigation revision, streaming typed progress and a validated terminal result.
- `GET /forge/investigations/:id`: retrieve a bounded result in its exact permitted scope; never implicitly start work.
- `POST /forge/investigations/:id/direction`: record selected findings and human changes with an expected revision.
- `POST /forge/investigations/:id/prompt/stream`: generate from that direction/revision.
- Extend validation to the new prompt record and its transitive dependencies.

Every start/continue/write action uses an operation key and expected revision. Scope the key to workspace/session and bind it to the payload digest; reuse with different input is rejected. Duplicate submissions attach to or report the existing attempt; they do not spend twice. A retry is a fresh explicit action. Stale responses cannot overwrite a newer workspace, session, model, or composer revision.

Use the existing HTTP/SSE transport, session/workspace authorization, SDK generation, and activity components. Keep provider data off broad broadcast events; those should publish scoped invalidation metadata, not source bodies. Resolve home-screen drafts with an explicit ephemeral scope and validate any later session binding.

Persist schema-versioned completed revisions independently of the bounded request-trace history, with explicit retention and purge integration. Trace pruning must not accidentally invalidate an active reviewed draft; expired/purged preparation records must not be silently reconstructed as approved. Test upgrade, interrupted-operation recovery, and older-client behavior.

Retain `/forge/enhance` and its current schema as a legacy path during rollout. New `/enhance` workshops use the new flow only when explicitly enabled initially. Do not silently run investigation for old API callers or increase their expected call count. Preserve `/ideas`; factor reusable review logic while avoiding a breaking command change.

The existing coding agent remains responsible for actual edits, diffs, test execution, error recovery, and sensitive-action approval. Enhancement suggests verification; it does not certify that implementation has passed it.

**E completion gates:** actual TUI keyboard flows cover draft -> investigation -> findings -> direction -> prompt -> edit -> stage -> separate send. Verify cancel/retry, partial stream, restart, late response, session/worktree/provider switching, attachments, compaction/resume, existing-daemon reuse, dev/watch, and native packaging. Browser source/context views must display the same scoped versions and not resurrect revoked evidence.

## 10. Approved Diagnostics: Later Extension

Only add this after the repository-only milestone works. Documentation queries are knowledge retrieval; execution and live diagnostics need separate capabilities.

Start with explicitly supplied logs and configured schema/index metadata. Record their environment, collection time, completeness, and read-only provenance. Stale production metadata cannot prove current behavior.

If runtime execution is needed, introduce individual named capabilities with defined arguments, target environment, network/filesystem boundaries, output redaction, time/size limits, and user consent. "Run tests" is not inherently read-only: project tests may execute arbitrary code or contact services. Use disposable isolation and restrict credentials/network.

No generic shell, arbitrary SQL, automatic migrations, row dumps, destructive probes, production load tests, or automatic provisioning. The existing database metadata adapter consumes provider-reported resources; actual read-only credentials must be enforced and verified at the provider/database boundary.

**Gate:** before enabling each adapter, test denials, timeouts, malformed output, stale data, cross-environment confusion, redaction, and cancellation; then run an approved integration smoke test. Unsupported diagnosis ends in an honest diagnostic prompt.

## 11. Delivery Sequence

Each milestone is a reviewable change set with its own tests. The table retains the approved exit gates; the implementation notes and feature status distinguish shipped code from separately gated evidence.

| Milestone | Work and main outputs | Depends on | Exit gate |
|---|---|---|---|
| M0 | Freeze current baseline fixtures, supported capability/language matrix, versioned contracts, proposed limits, and rollout boundary. | Plan approval | Reproducible baseline and reviewed contracts; existing failures/skips recorded without weakening tests. |
| M1 | Shared read-only capabilities, direct range/text/path reads, source binding, and host permission enforcement. | M0 | Real file/SQLite tests pass; escapes, exclusions, stale results, and unauthorized tools fail closed. |
| M2 | Investigator turn adapter, domain loop, intent handling, observation ledger, limits, counterevidence, and structured findings; additive API/SSE. | M1 | Multi-step changed-query/caller inspection works; no write/exec tools; partial/failure states remain honest. |
| M3 | Findings cards, explicit direction selection, feedback/re-investigation, revision persistence, and separate activity/source views. | M2 | Human choices and later amendments control scope; no prompt generation or staging on mere selection. |
| M4 | Tool-free writer, concise prompt, transitive evidence validation, composer handoff, and normal coding submission integration. | M3 | First end-to-end milestone passes, including already-fixed, insufficient-evidence, injection, and stale-source cases. |
| M5 | B completion: true warm delta indexing, graph/dependency corrections, semantic eligibility/refill, and reconciliation. | M1; final integration after M4 | Delta/full-build equivalence, bounded changed-file work, and honest coverage/channel status. |
| M6 | C completion: adaptive dependency-specific docs queries, version/scoped caching, and approved adapter checks. | M2 and B dependency contracts | Follow-up docs search/version tests pass; unavailable external access degrades explicitly. |
| M7 | D completion: ledger compaction, complementary-evidence selection, writer quality checks, selector comparison, and evaluation tooling updates. | M4; integrate M5-M6 | Budgets and mandatory-case retention pass; representative quality/cost evidence determines selector/default changes. |
| M8 | E release: SDK compatibility, full-process lifecycle, native/browser parity, documentation, changeset, and opt-in rollout review. | M4-M7 | Release regression matrix and guards pass; no known critical provenance, privacy, or approval defect. |
| M9 | Optional, individually approved logs/metadata/runtime diagnostics. | M8 | Per-capability safety/integration gates; no automatic expansion of investigation privileges. |

M5 can progress separately once M1 contracts stabilize; fixture/evaluation work starts in M0 rather than being deferred to the end. M4 deliberately delivers usable value before the broader indexing and adapter work is finished. M8, not M4, is the completion point for the connected A-E release.

No calendar estimate is asserted before M0 establishes provider compatibility and concurrency constraints. The highest uncertainty is multi-call provenance/consent, correct incremental graph invalidation, and model-quality evaluation, not UI rendering.

## 12. Verification and Success Criteria

### Mandatory regression matrix

| Scenario | Required outcome |
|---|---|
| Discoverable defect with a multi-file cause | Reads the relevant implementation and necessary caller/test; produces a supported, scoped direction and regression verification. |
| Same symptom, defect already fixed | Does not recommend reapplying the fix; explains current evidence or asks for a missing runtime observation. |
| Incomplete index or unavailable file | Reports scope limitations and uses permitted direct lookup where useful; never treats no search hits as proof of absence. |
| Several credible improvements | Presents distinct choices; only the chosen work enters the implementation prompt. |
| New feature rather than bug | Finds existing architecture/reuse points without inventing a defect or product requirements. |
| Ambiguous target or conflicting requirements | Asks only the consequential unresolved question; later explicit user amendments take precedence. |
| Wrong dependency/library/version | Retains version uncertainty and does not assert unsupported compatibility. |
| New evidence contradicts an initial hypothesis | Revises or removes the recommendation and explains the change. |
| Topical distractor, duplicated fixture, or complementary passages | Retains the necessary originals, not just repeated vocabulary; both required support and counterevidence are covered. |
| Retrieved `plan.txt`, fake system messages, or malicious documentation | Cannot change capabilities/mode, authorize sharing, or introduce unselected instructions into the prompt. |
| Changed file, policy, provider, session, or revoked collection | Blocks reuse of affected derived findings/prompts and requests review; no cross-scope disclosure. |
| Empty/malformed provider output, limit, cancellation, restart | No false-ready state, duplicate paid attempt, late staging, silent retry, or loss of user edits. |
| Accept/edit/attach/compact/resume | Preserves human intent and required attachments; source provenance stays separately validatable. |

Use real temporary repositories, SQLite, parser, selector, and UI code. Stub only provider/protocol boundaries where deterministic responses are required; the tests must not duplicate the implementation. Scripted tool-call fixtures establish mechanics, not a model's ability to investigate.

### B-D measurement

Measure retrieval candidate recall separately from selection quality. Score required/supporting original passages and counterevidence, not simply filenames or source counts. Include small/large budgets, renamed/relocated repositories, excluded/stale candidate competition, and semantic-on/off configurations.

Compare selectors using an identical pool; compare search channels using separate ablations. Measure actual read/parse/embed counts and cold/warm wall-clock/memory separately from UI responsiveness. Establish and freeze practical latency ceilings on the reference environment in M0, before evaluating candidate changes. Do not run timing comparisons alongside builds.

All critical safety and finite mandatory correctness scenarios must pass. A higher aggregate score cannot excuse a lost essential fact on those cases. Broader quality thresholds and any allowed statistical uncertainty must be fixed before inspecting live results.

### Matched model evaluation

Extend the maintained evaluator rather than recreating retired experiment/report machinery. Use four preparation arms: raw Kilo, generic rewrite, current retrieval-backed enhancement, and investigative enhancement. Keep the implementing model, coding permissions, tools, workspace starting state, and grading equal when isolating preparation quality; separately report any experiment that also changes coding tools.

Use a reviewed set of at least 20 tasks across at least two repositories as an initial evaluation target, covering fixes, broad improvements, feature work, already-fixed cases, and insufficient evidence. This size supports descriptive comparison, not an automatic claim of statistical superiority. Keep development cases separate from evaluation cases and freeze selection/rubrics before running.

For interactive choices, use a predeclared selection protocol or the same recorded human decision across matched arms. Report clarification burden and blocked preparations instead of discarding them. Test the implementing agent's patch with independent regression tests; do not score prompt length as success.

Report supported-finding precision, defect/direction correctness, unsupported assertions, intent/constraint preservation, unnecessary questions, investigation coverage, final prompt size, total preparation-plus-coding tokens, latency, failures, and coding success. Distinguish reported usage from estimates and missing values. Repeated trials are not new independent tasks.

Live provider and embedding experiments require explicit model/endpoint, data-egress, and spending approval. No paid experiment runs as part of routine tests. Claim that D saves tokens without compromising success only if matched outcomes support it; otherwise report the trade-off and keep tuning or opt-in status.

## 13. Validation Commands and Release Work

From the repository root, select the affected checks:

```sh
bun run --cwd packages/kilo-forge test
bun run --cwd packages/kilo-forge test:evaluation
bun run --cwd packages/kilo-forge typecheck
bun run --cwd packages/kilo-indexing typecheck
bun run --cwd packages/opencode typecheck
bun run --cwd packages/tui typecheck
bun run --cwd packages/kilo-forge-ui test
bun run --cwd packages/kilo-forge-ui typecheck
bun run --cwd packages/kilo-forge-ui build
bun run lint
bun run script/check-opencode-annotations.ts --worktree
bun run script/check-opencode-promise-facades.ts
bun run script/check-md-table-padding.ts plans/forge-investigative-enhancement.md
```

Run targeted CLI, TUI, and indexing tests from their package directories as listed in the maintained [testing guide](../packages/kilo-forge/TESTING.md). Run full affected product suites before release, not root `bun test`.

Regenerate SDK/OpenAPI with `./script/generate.ts` from root when endpoint schemas change. Verify generated diffs, client typechecks, and SDK packaging. Keep shared-file changes to minimal annotated hooks and avoid runtime-backed Promise facades in shared Effect services.

Use current-source `bun dev serve` and disposable state for full-process validation, never the installed production binary as proof of source changes. Build and test native packaging from the current worktree using `bun run script/build.ts --single --skip-install` in `packages/opencode`, plus the maintained launch/workflow probes and browser setup.

Add a concise user-facing changeset for the implemented behavior and update product/status/testing docs. Extract source links if touched source adds or changes URLs. Keep tests and disposable results outside user data; do not restore deleted reports or change unrelated worktree files.

Roll out the investigative path behind an explicit experimental setting using Forge's configuration boundary where possible. Do not silently turn on semantic indexing, MCP access, diagnostics, or higher-cost model routes. Retain the legacy rewriter for explicit rollback; keep new records versioned/readable and never reinterpret partial investigative records as legacy ready prompts.

## 14. Approval Scope

Recommended approval is M0-M8 with repository-only investigation first, existing configured/approved retrieval integrations added through their gates, and M9 separately approved capability by capability. Paid comparative evaluation remains a separate authorization.

No further product-choice question is needed to prepare the first milestone: TUI-first review, one constrained investigator, a separate writer, explicit direction selection, normal Kilo execution, and no autonomous application changes are the proposed defaults.

Implementation is complete only when the workflow and each applicable B-E completion gate have evidence, not merely when the new endpoints and screens exist.
