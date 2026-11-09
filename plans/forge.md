# Forge Feature Status

Updated: 2026-11-06. This replaces the previous Forge plans and round-by-round task histories. Consolidation does not certify historical acceptance results or establish live coding superiority.

## Retained Product

| Area | Behavior |
|---|---|
| Knowledge | Inventory repository code and register files, folders, text, uploads, and URLs. Keep source versions, extraction state, incremental updates, and removal controls. |
| Retrieval | Combine approved evidence with default greedy selection, serialized evidence budgets, pins, exclusions, current-original citations, and workspace/session isolation. Domain routing and alternate selectors remain optional. |
| Enhancement | Stream `/enhance` using the selected model; retain authoritative edits, answers, feedback, attachments, and explicit retry snapshots. Review and acceptance do not submit a chat message. |
| Investigative Enhancement | Opt in with `investigation: true`: investigate using bounded read-only tools, review supported findings, select direction, then write and stage a concise prompt with structured provenance. No automatic coding submission or runtime execution. |
| Repository Refresh | Dirty-path batches reuse unchanged extraction units. Buffered watcher events, configuration/policy invalidation, and explicit/periodic reconciliation preserve full-build equivalence. |
| Dependency Docs | Investigative follow-ups target an owning dependency ID. Scoped adapter/query/version caching rechecks authorization, rejects wrong-library results, and preserves compatibility uncertainty. |
| Inspection | Keep `/overview`, terminal `/map`, Ctrl+B browser handoff, source navigation, selection history, and bounded request lineage. Investigation and writer captures appear in preparation history. |
| Agent Tools | Keep code/document search, symbol inspection, and relationship lookup with cancellation and evidence eligibility checks. |
| Embeddings | Keep optional document vectors, explicit provider/destination approval, shared jobs, coverage, usage export, and pruning. Nothing in this consolidation enables embedding requests. |
| Launch | Keep one-shot Forge launch, development watch mode, browser assets, document/storage workers, and native packaging support. |

## Non-Negotiable Checks

- Do not accept stale, unavailable, excluded, revoked, or differently scoped evidence.
- Do not infer sharing approval from indexing approval, existing embeddings, or an earlier model choice.
- Keep original requirements and later human amendments authoritative over generated notes.
- Reject empty tasks, malformed responses, invalid citations, and unresolved consequential decisions.
- Preserve pending input and the last successful revision on failure, cancellation, or explicit retry.
- Do not automatically retry generation, reconnect an enhancement POST, switch models, submit chat, or grant network permissions.
- Treat absent usage as unknown. Cancellation is not proof that provider billing stopped.

## Remaining Work

These are product/release follow-ups, not instructions to restart historical experiment loops. Earlier reports have been removed; old numerical claims are not current verification.

The investigative implementation follows [the approved plan](forge-investigative-enhancement.md). The product remains explicitly opt-in; no live superiority claim or automatic expansion to diagnostics is implied.

1. **Retrieval quality:** validate complementary required passages and supporting evidence under topical competition, at small and large budgets and across locations. Preserve per-case coverage, precision, citations, and safety; deterministic regression checks are not independent generalization evidence.
2. **Concurrent consistency:** investigate whole-send policy/freshness atomicity, simultaneous collection changes, search refill beyond channel limits, and recovery from previously corrupted snapshots.
3. **Provider reliability:** verify malformed `verification`/`inspect` responses with safe shape diagnostics when a fresh reproduction is authorized. The routed JSON/schema corrections do not guarantee universal model compliance.
4. **Full-process workflows:** check current packaged TUI/browser cancel, close, retry, late-response, wait/recovery, workspace/provider/session transitions, resumed sessions, watch mode, and existing-daemon attachment.
5. **Performance and storage:** measure realistic large-library latency and selector runtime; clarify bounded-history/retention behavior and resource accounting. No hard spending cap, complete invoice reconciliation, or transactional retained snapshot is claimed.
6. **Configured adapters:** exercise actual configured documentation, metadata, and embedding providers with approved egress. Local protocol fixtures do not prove real provider behavior.
7. **Release checks:** verify native packaging, selected end-to-end flows, SDK/API synchronization, and applicable repository guards before release.

Live comparative coding research is a separate, opt-in activity. It requires explicitly authorized model access/spending, pinned inputs and model identity, fresh isolated workspaces, reviewed graders, and honest accounting of failures and unknown usage. No completed independent study or improvement claim is supplied here.

## Structure And Tests

- Product usage: [Forge README](../packages/kilo-forge/README.md).
- Maintained commands and coverage: [Forge testing guide](../packages/kilo-forge/TESTING.md).
- Core regressions live in `packages/kilo-forge/test`; evaluation utilities and their tests live in `packages/kilo-forge/benchmarks`.
- Base release notes are in `.changeset/forge.md`; investigative workshop notes are in `.changeset/forge-investigative-workshop.md`.
- Generated run outputs stay ignored. Tests must use temporary state and must not depend on deleted reports or operator-specific repositories.

Optional product features were preserved, not removed. No commits or branch-history changes are part of this consolidation.
