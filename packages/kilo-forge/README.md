# Forge

Forge adds repository/document knowledge, cited prompt enhancement, source inspection, and retrieval tools to Kilo CLI. See [feature status](../../plans/forge.md) for scope and remaining work, and [testing](TESTING.md) for maintained checks.

## Run

With workspace dependencies installed, run from the repository root:

```sh
bun run forge -- /absolute/path/to/project
```

The launcher builds browser assets and starts the source CLI. `bun run dev:watch /absolute/path/to/project` rebuilds and restarts on source changes; see [watch mode](../../script/kilocode/dev-watch.md).

Omitting the project path in `bun run forge` or `bun run dev:watch` opens the repository root. Forge configuration is scoped to the opened directory, so a different project needs its own `.kilo/forge.jsonc`.

| Command | Purpose |
|---|---|
| `/overview` | Model-free knowledge/context dashboard. |
| `/map` | Keyboard-controlled terminal knowledge/context map. |
| `/enhance [draft]` | Write, clarify, revise, and review a cited prompt. |
| `/ideas <goal>` | Request evidence-backed opportunities from a configured model. |

Opening knowledge views and local document indexing do not call a model. Enhancement, ideas, and Explain Repository do and can incur charges. Source passages are untrusted material, not instructions.

## Investigative Workshop (Opt-In)

Set `"investigation": true` in `.kilo/forge.jsonc` to use the new `/enhance` flow:

```text
Request -> read-only investigation -> findings -> choose direction
        -> separate writer -> review/edit -> stage -> separate chat submission
```

The investigator follows leads using indexed search, literal path/text lookup, bounded file ranges, symbols, relationships, and configured dependency documentation. It can recommend a fix, improvement, feature direction, or diagnostic next step. It can also report no supported issue or ask a consequential question. "Observed" means supported by inspected code, not a reproduced runtime failure.

| Action | Control |
|---|---|
| Investigate the draft | Enter in the input editor. |
| Choose findings | Up/Down and Space. Selection does not call the writer. |
| Write selected direction | Enter after selection, or `w`; an explicit model call. |
| Answer clarification questions | Opens automatically when required; `c` reopens it from review. Up/Down or Tab moves, Space or clicking selects an option, and `c` types an answer or adds details. |
| Continue clarification | Enter advances to the next applicable question locally; on the last question it submits the batch (model calls). Left/Right reviews visible questions without requests. `s` skips an optional question; Escape returns without discarding answers. |
| Recover after a failed clarification | Review the saved answers, then Enter / `i` retries with them, or `c` explicitly edits them. The question list does not restart automatically. |
| Give general feedback | `f` from review, or `c` when there are no questions; Enter investigates again. |
| Investigate further | `i`, an explicit new attempt; an empty assessment also offers Enter to continue with saved answers, without requiring new feedback. |
| Retry a failed conclusion | Enter / `i` on the suggestion-recovery screen, or `Ctrl+R` when offered; revalidate and reuse recorded evidence for one bounded conclusion call. |
| Recheck temporarily unavailable evidence | `Ctrl+R` when offered; check access again without a model call. |
| Inspect sources/activity | `s`; Escape returns to review. |
| Inspect model turns | `t` from review or `Ctrl+T`; Up/Down selects a turn and Enter/Space expands it. |
| Expand turn resources | `r` in turn history shows context references, source previews and local parse/search activity. |
| Edit the generated prompt | `e`; edits stay separate from generated requirements. |
| Stage the prompt | Enter on the prompt review, or `a`; chat submission remains a separate action. |
| Choose a model | `v`; changing it does not start a request. |
| Cancel/close | Escape cancels active work; Ctrl+C closes. |

Preparation aims to settle ordinary requests in two or three model turns, fewer when sufficient. This is guidance, not a new turn cap or a guarantee; clarification submissions and the separately approved writer add calls. The stopping criterion is an actionable brief: the intended outcome, relevant scope or starting point, and a useful next action with verification. A proven root cause or complete implementation plan is not required. A scoped diagnostic direction can be selected and written with explicit unknowns, even without source evidence; it must not claim a proven fix. The writer aims for 100-250 words of added guidance while preserving requirements.

Proactive assessment has a different deliverable from a generic diagnostic handoff: once the user supplies a goal and scope, inspect the relevant implementation and offer concrete potential improvements with expected benefits, uncertainty, and measurable verification. A known failure or runtime baseline is not a prerequisite. Reading only a composition file is not enough to establish that a capability is absent; follow the relevant implementation when needed. The user chooses among the candidate directions before writing.

Finding categories describe the requested work, not its certainty. An unresolved defect, improvement, feature, or diagnostic direction can proceed as an explicitly unverified proposal; a throughput-improvement request need not supply a known failure first. Review marks these directions as unverified. Prompt assembly preserves their reported unknowns and adds an investigation-first caveat independently of the writer: a proposed cause, change, or benefit is not established, and implementation depends on evidence and the user's goal. Citation and verification checks still apply, and supported claims still require original evidence.

Each turn receives a preparation checkpoint distinguishing discovery from direct inspection and noting repeated source versions. Further questions or reads should resolve a specific gap that could change the brief. Answered intent stays settled; code-discoverable details are left to the coding agent. Search tools use ranked plain terms, not Boolean expressions or `path:` filters; use literal lookup for path scoping. No extra model call is used to decide whether to finish.

The investigator has no shell, application-write, arbitrary MCP, runtime-diagnostic, or delegation capability. Limits are 12 model turns, 24 inspection requests (including rejected arguments), a three-minute deadline, 48,000 evidence bytes per turn, 96,000 request bytes, and 384,000 cumulative replayed request bytes. The evidence allowance is a local cap, not a provider context-window limit; fuller turns can use more input tokens and reach the unchanged cumulative limit sooner. File reads return at most 160 lines/16 KiB; literal lookup visits at most 5,000 entries, reads at most approximately 8 MB, and returns 20 matches. Each investigator response and the separate tool-free writer have an 8,000-output-token budget, capped at the selected model's supported maximum; the writer has a one-minute deadline. Codex uses the effective output limit as a conservative streamed-byte allowance as described below, so its allowance also rises to 8,000 bytes when the model supports it. Byte accounting is conservative, not a provider invoice cap.

Premature conclusions returned with inspection calls are discarded before independently valid inspections run. Malformed inspection arguments produce bounded, content-free feedback without executing that call. Permission failures still stop the attempt. Conclusions must cite previously observed evidence; no fields, paths, or citations are invented to repair model output.

Extra metadata on a proposal is ignored, while every declared field, citation, and verification requirement remains validated. Missing or malformed required fields are never fabricated. If every proposal fails validation, the result is a recoverable format failure, not a successful assessment finding no improvements. The unvalidated summary remains visible, and saved answers do not need to be refined. Older all-discarded records are also eligible for explicit recovery.

Invalid conclusions preserve their recorded reads. Explicit conclusion-only recovery requires the same request, answers, feedback, model, and scope, and rechecks source freshness and permissions before a new model call. Recovery includes the previous unvalidated summary and bounded format diagnostics as non-authoritative context to help reconstruct complete suggestions. Text returned without tools is shown as an unstructured response, not validated findings or an inferred request for user clarification. No recovery starts automatically.

The built-in OpenAI ChatGPT/Codex login is supported when the selected model is available to that account. Codex requires streaming and rejects the API output-cap parameter. On that route, Forge instead aborts when visible text, reasoning summaries and tool-input deltas exceed a conservative UTF-8 byte allowance, and rejects final reported output-token usage above the budget. Hidden reasoning cannot be bounded before it is reported, and cancellation cannot guarantee an immediate provider-side stop or a hard billing cap. No automatic retry or model substitution occurs.

OAuth route fingerprinting recognizes only the registered built-in adapter. Registered knowledge still requires reviewed origins and redirect rejection at the final HTTP hop after URL rewriting. Custom fetch and WebSocket transports remain blocked for that protected evidence; Forge does not silently switch transports to bypass the guard.

Clarifications arrive as a concise branching questionnaire in one response, with at most 12 question nodes across all paths and no fixed question quota. Each conditional question has `when: { question: "<earlier question ID>", options: ["<exact option>"] }`; it appears only when its parent is visible and a matching option is selected. Conditions can be nested. Selecting a subsystem and advancing immediately reveals its relevant follow-ups without model calls, inspections, or a turn-history transition. Only the final batch submission resumes investigation, sending all applicable answers together. Changing a parent clears dependent answers, and hidden branches are never submitted. Invalid parent references, forward references, cycles, and duplicate IDs are rejected.

Matching questions already answered are withheld, and prior answers remain visible in review. Options are single-choice, with no default selected; a custom answer can stand alone or add details to a selection. A custom-only answer or skipped parent does not activate option-specific children; the next explicit investigation can interpret the custom text and request any still-missing detail. Saving text and navigating questions do not call the model. Required visible questions cannot be skipped. Failures and cancellation show a saved-answer recovery screen instead of reopening question one. Pending answers must be investigated before writing a prompt.

Turn history appears live during investigation and remains available from review or after a failure. It records public model updates when returned, request IDs, reported token usage, bounded request sizes, tool arguments and outcomes, and the resources returned by each tool. Multiple calls in one response remain grouped under one model turn. A turn distinguishes full replayed tool results from older results reduced to source metadata. Replay favors direct inspection over broad searches and deduplicates repeated direct inspections of the same source version, while the original tool journal stays intact. Reading or parsing locally does not mean an excerpt was sent to or understood by the model.

Source-reference metadata is also bounded. Complete references are added only after useful excerpts have been selected, within the remaining evidence allowance; omitted-reference counts make that reduction explicit. Large reference inventories do not erase the stored investigation or require a larger model-credit budget.

Pending requests show elapsed time through lightweight in-memory updates; these do not write history or retransmit source excerpts. Replaceable activity snapshots are coalesced, while lifecycle transitions remain immediate. Failure details distinguish response validation, transport, inspection, and evidence checks; deadline expiry is not labeled as a user cancellation. Temporary connectivity failures preserve typed feedback and block generated content until access is rechecked.

Public updates come from response text or a brief `purpose` requested on new inspection calls; older local calls may omit it. Missing public explanations are labelled, not invented. Final turns use the validated conclusion summary. Private reasoning blocks are never shown. Reasoning token counts may be displayed when reported by the provider. Public updates and tool purposes are not replayed as instructions or added to the final prompt. File activity keeps bounded samples and complete recorded counts; direct reads do not claim syntax parsing or test execution. Older investigations keep their resources without invented turn boundaries.

The concise prompt does not include the raw evidence bundle or unselected recommendations. Hidden preparation metadata retains the complete influencing evidence dependencies. Freshness is checked for review, writing, staging, and new submission. Already-admitted coding history may refer to repository code that the coding agent has since edited or deleted; it is historical evidence, not a current-code assertion. Current permissions, ignore/exclusion policies, private-document versions, and destination restrictions still apply on subsequent calls, compaction, and resume.

Completed records are kept independently of bounded request traces until explicit Forge purge. Reopening interrupted work never restarts a model call. Purge cannot revoke copied/exported/transmitted content, and purging a preparation blocks continued reuse of its dependent session context. Disable the setting to return to the legacy rewriter; existing `/forge/enhance` clients retain their original behavior and call count.

## Legacy Enhancement

Bare `/enhance` opens an editor without a model call; `/enhance <draft>` begins generation. New workshops use the selected chat model and display it. Legacy API callers omitting a model retain the backend default/small-model policy.

| Action | Control |
|---|---|
| Generate from the editor | Enter; Shift+Enter inserts a newline. |
| Review and stage | Enter on **Use prompt**, or `a`. Staging never submits chat. |
| Edit or give feedback | `e` or `c`. Human additions, replacements, and removals remain authoritative. |
| Answer questions | Arrows/Tab, Space to select, `c` for comments, Enter to advance, `s` to skip. |
| Inspect evidence/activity | `d` for evidence, `m` for map, `t` for activity; Ctrl+T in editors. |
| Change model | `v`; a confirmed change starts a new attempt and rechecks sharing. |
| Recover from failure | `r` explicitly retries; `e` edits saved input; `o` reviews the prior draft. |
| Cancel or close | Escape cancels generation/returns to review; Ctrl+C closes. |

Answers and feedback survive review, editing, cancellation, and failure. Pending answers must be incorporated (`g`) or explicitly discarded (`x`) before accepting an earlier proposal. Skipping optional questions does not choose an option or resolve consequential blockers.

Every revision is locally validated against current evidence and the canonical response contract. Routed models receive prompt-based JSON instructions when provider structured output is unsupported. Missing required sections, malformed/cut-off responses, invalid citations, and empty tasks are rejected, not silently repaired or accepted.

Generation has a three-minute deadline and acceptance validation a 30-second deadline. No automatic generation retry, enhancement POST reconnection, model switch, or paid repair call occurs. Cancellation prevents late staging but cannot guarantee that an admitted provider request stops billing.

## Knowledge And Inspection

In `/overview`, use `a` for a file, `f` for a folder, `t` for pasted text, `k` to manage documents, `i` to explicitly index repository code, `x` to cancel indexing, `u` to reload, and `m` for the map.

Register supported local files/folders, text, uploads, or URLs. Markdown, PDF, DOCX, and supported plain-text sources retain original passages and locators. Indexing approval and model/provider sharing approval are separate. Supported draft attachments can remain task-only or be explicitly enrolled; enrollment never grants sharing.

The terminal map supports selection/navigation and source inspection; `v` switches between available knowledge and captured request context. Browser knowledge management uses the same scoped backend. Captured retrieval, selection, assembly, and observed transmission are distinct stages, not proof of model understanding or retention.

Press Ctrl+B in `/overview` or `/map` to open the browser inspector explicitly. Authentication is handed off in the URL fragment and removed by the browser page; a hard reload requires another terminal handoff. Remote browser inspection requires HTTPS.

Pins preserve exact source identity/version; exclusions and purge remain explicit. Accepting a proposal or returning agent-tool evidence rechecks current source eligibility and permissions. The four coding tools are `forge_search_code`, `forge_search_docs`, `forge_get_symbol`, and `forge_relationships`.

## Configuration

Optional project configuration lives in `.kilo/forge.jsonc`:

```jsonc
{
  "files": 5000,
  "bytes": 100000,
  "budget": 24000,
  "candidates": 100,
  "selector": "greedy",
  "exclude": ["private/**"],
  "history": false,
  "investigation": false
}
```

`bytes` bounds each scanned file. `budget` bounds serialized evidence using a conservative UTF-8 byte estimate, not provider tokens or the entire model request. Selectors are `ranked`, `greedy`, and `knapsack`; domain routing is opt-in. Ignore files, common generated paths, secret filename patterns, and symlinks constrain scanning.

Optional `documents: { "server": "configured-mcp-name" }` enables the supported Context7 adapter. Optional `database: { "server": "configured-mcp-name", "resource": "advertised-resource-uri" }` requests provider-reported JSON database/table metadata. Configure remote access in that MCP provider; Forge does not open application databases or establish read-only credentials. Do not expose application rows or secrets.

Repository semantic retrieval uses Kilo's configured index and embedding provider. Forge does not provision a local model or silently enable hosted embeddings.

## Repository Coverage

| Evidence | Supported scope |
|---|---|
| Declarations/imports | Tree-sitter TS, TSX, JS, JSX, and Python; literal `require`/dynamic-import paths where parsed. |
| Import resolution | Relative paths, nearest project `tsconfig.json` aliases, unambiguous package names with exact exports/main entries, Python relative/root/src imports. |
| Dependencies | Owning package manifests, ancestor npm lockfile resolution, nearest Bun/uv/Poetry lockfiles. Ambiguous versions stay unknown. |
| Schema evidence | Static SQL, Prisma text, and supported ORM declaration subsets; not live database state. |
| Other supported text | Markdown, configuration, MJS/CJS and other eligible files via bounded text/line evidence. |
| Relationships | Imports, reverse lookup, test imports, declaration edges, and labeled inferred documentation associations; not a complete runtime call graph. |

Warm watcher batches reuse unchanged extraction units and update search/relationships transactionally. Watchers subscribe before scanning and buffer concurrent events. Policy, configuration, lockfile, parser-version, incomplete-state, or uncertain-event changes trigger reconciliation. Explicit refresh and a one-minute reconciliation interval on subsequent use recover missed events. Dynamic resolution, inherited TS configuration, wildcard package exports, and unobserved installed dependency state remain limitations.

For investigative documentation, choose an exact dependency source ID when names occur in several packages. Cache identity includes the dependency fingerprint, query, configured MCP adapter, session, model provider, and destination; cache hits recheck authorization. Provider-reported documentation versions are distinct from project versions. Wrong-library results are rejected; absent versions and mismatches remain explicit uncertainty. No adapter is installed or authorized automatically.

## Optional Collection Embeddings

Collection vectors require host configuration and explicit destination consent, separate from repository/local indexing approval. Coverage and usage inspection do not send document text or start jobs.

Use **Manage embeddings** in the browser or collection controls in the terminal. Usage is exact-session history across accessible collections, not a selected collection total. A page is a live observation; unknown usage is not zero, and job counters overlap the ledger. Recorded attempts do not establish transmission, complete historical billing, monetary cost, or a spending cap.

Export through an existing backend without starting a daemon or making model requests:

```sh
kilo forge-usage http://127.0.0.1:4096 --directory /path/on/backend --session ses_example --output usage.json
```

Use `KILO_SERVER_PASSWORD` and optional `KILO_SERVER_USERNAME`, not URL credentials. HTTP is limited to numeric loopback origins; remote backends require HTTPS. Named exports do not replace existing paths. Protect exported copies: backend purge cannot revoke them.

`--max`, `--timeout`, and `--after` bound traversal. Revision-checked export aborts if the observed history changes; it is not a retained transactional snapshot or complete all-resource ledger.

Preview pruning with `--before <unix-ms> --keep <count>`. Apply that exact reviewed preview with `--revision <revision> --confirm DELETE`. Each transaction removes at most 100 eligible ledger entries; pending/interrupted entries stay preserved, and the CLI never loops automatically. Pruning does not delete original documents, vectors, jobs, chats, or exported copies. It is not automatic retention or secure erasure.

## Development

See [TESTING.md](TESTING.md) for product regressions, opt-in evaluation tests, model-free benchmarks, browser/terminal probes, and release checks. Live evaluation is separately authorized and does not run as part of product tests.

Forge is MIT licensed. No independent live coding-quality improvement is claimed.
