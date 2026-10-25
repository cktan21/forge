# CLI Watch Mode

Run from the repository root:

```sh
bun run dev:watch /path/to/project
```

From another directory, select the repository containing the script:

```sh
bun run --cwd /path/to/forge dev:watch /path/to/project
```

`dev` runs source once. `dev:watch` runs the same source entry point and restarts
the CLI in the same terminal after changes to workspace `src` folders or
`package.json`, `tsconfig.json`, `bunfig.toml`, and the root `bun.lock`. Workspace
source is watched even when it is loaded only by a background worker. Build
output, test folders outside `src`, and project files outside these paths do not
trigger restarts. Restart the watcher after adding a workspace or a new `src`
folder, or changing the watch launcher itself.

Saves are debounced for 250 milliseconds. Before restarting, the launcher sends
SIGTERM and waits for the old process to exit. A stuck process is force-stopped
after eight seconds. A failed launch waits for another edit; exiting the TUI
normally also exits the watcher.

Watch mode disables daemon attachment and auto-updates so the TUI uses the local
source backend. It uses your normal Kilo settings and saved sessions.

This is restart-on-save, not state-preserving hot reload. Active work is
interrupted, unsent input is lost, and the currently selected chat and directory
are not automatically restored. Each restart reuses the original CLI arguments.
Avoid using watch mode for important running tasks. Embedded web assets that
require their own build are not rebuilt by this command.
