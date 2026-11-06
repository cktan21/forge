# CLI Watch Mode

Run from the repository root:

```sh
bun run dev:watch /path/to/project
```

From another directory:

```sh
bun run --cwd /path/to/forge dev:watch /path/to/project
```

Watch mode runs the local source CLI and restarts after changes to workspace `src` directories, package/configuration files, or `bun.lock`. Saves are debounced for 250 ms. The old process receives SIGTERM and is force-stopped after eight seconds if necessary.

Browser assets are rebuilt before every launch/restart. A failed build waits for another edit instead of launching stale assets. Generated output and tests outside `src` do not trigger restart loops. Restart the watcher after adding a workspace/source directory or changing the watcher itself.

This is restart-on-save, not state-preserving hot reload. Active work is interrupted, unsent input is lost, and the selected chat/directory is not automatically restored; original CLI arguments are reused. Normal TUI exit stops the watcher.

Watch mode disables daemon attachment and auto-updates but uses normal settings and saved sessions. Plain `dev` does not build browser assets and may attach to an existing daemon. `forge` builds assets for a one-shot launch while retaining normal daemon behavior.

For isolated PTY and browser-to-terminal verification, see [Forge testing](../../packages/kilo-forge/TESTING.md). Those opt-in probes are separate from normal development commands.
