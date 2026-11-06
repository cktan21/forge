# Forge

Forge adds repository/document knowledge, cited prompt enhancement, source inspection, and retrieval tools to Kilo CLI. See [feature status](../../plans/forge.md) for scope and remaining work, and [testing](TESTING.md) for maintained checks.

## Run

With workspace dependencies installed, run from the repository root:

```sh
bun run forge -- /absolute/path/to/project
```

The launcher builds browser assets and starts the source CLI. `bun run dev:watch /absolute/path/to/project` rebuilds and restarts on source changes; see [watch mode](../../script/kilocode/dev-watch.md).

| Command | Purpose |
|---|---|
| `/overview` | Model-free knowledge/context dashboard. |
| `/map` | Keyboard-controlled terminal knowledge/context map. |
| `/enhance [draft]` | Write, clarify, revise, and review a cited prompt. |
| `/ideas <goal>` | Request evidence-backed opportunities from a configured model. |

Opening knowledge views and local document indexing do not call a model. Enhancement, ideas, and Explain Repository do and can incur charges. Source passages are untrusted material, not instructions.

## Enhancement

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
  "history": false
}
```

`bytes` bounds each scanned file. `budget` bounds serialized evidence using a conservative UTF-8 byte estimate, not provider tokens or the entire model request. Selectors are `ranked`, `greedy`, and `knapsack`; domain routing is opt-in. Ignore files, common generated paths, secret filename patterns, and symlinks constrain scanning.

Optional `documents: { "server": "configured-mcp-name" }` enables the supported Context7 adapter. Optional `database: { "server": "configured-mcp-name", "resource": "advertised-resource-uri" }` requests provider-reported JSON database/table metadata. Configure remote access in that MCP provider; Forge does not open application databases or establish read-only credentials. Do not expose application rows or secrets.

Repository semantic retrieval uses Kilo's configured index and embedding provider. Forge does not provision a local model or silently enable hosted embeddings.

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
