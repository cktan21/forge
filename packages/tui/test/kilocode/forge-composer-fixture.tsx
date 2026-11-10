/** @jsxImportSource @opentui/solid */
import { TextareaRenderable } from "@opentui/core"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { createSlot, createSolidSlotRegistry, testRender, useRenderer } from "@opentui/solid"
import { expect } from "bun:test"
import { onCleanup, Show } from "solid-js"
import { NudgeProvider } from "../../../opencode/src/kilocode/cli/cmd/tui/context/nudge"
import { Prompt } from "../../src/component/prompt"
import { TuiConfigProvider } from "../../src/config"
import { ArgsProvider } from "../../src/context/args"
import { ClipboardProvider } from "../../src/context/clipboard"
import { DataProvider } from "../../src/context/data"
import { EditorContextProvider } from "../../src/context/editor"
import { ExitProvider } from "../../src/context/exit"
import { KVProvider } from "../../src/context/kv"
import { LocalProvider } from "../../src/context/local"
import { LocationProvider } from "../../src/context/location"
import { PermissionProvider, usePermission } from "../../src/context/permission"
import { ProjectProvider, useProject } from "../../src/context/project"
import { usePromptRef } from "../../src/context/prompt"
import { ForgeComposerProvider } from "../../src/kilocode/forge/provider"
import { RouteProvider, useRoute } from "../../src/context/route"
import { SDKProvider, type EventSource } from "../../src/context/sdk"
import { SyncProvider, useSync } from "../../src/context/sync"
import { ThemeProvider } from "../../src/context/theme"
import { OpencodeKeymapProvider, registerOpencodeKeymap, useOpencodeKeymap } from "../../src/keymap"
import { DirectoryProvider } from "../../src/kilocode/directory-context"
import { createPluginRuntime, PluginRuntimeProvider } from "../../src/plugin/runtime"
import { FrecencyProvider } from "../../src/prompt/frecency"
import { PromptHistoryProvider } from "../../src/prompt/history"
import { PromptStashProvider } from "../../src/prompt/stash"
import { ToastProvider, useToast } from "../../src/ui/toast"
import { wait } from "../cli/cmd/tui/sync-fixture"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { createFetch, eventSource, json } from "../fixture/tui-sdk"
import type { Collection, Selection } from "@kilocode/forge/schema"
import { source } from "@kilocode/forge/parse"
import { select } from "@kilocode/forge/context"
import { prepare } from "@kilocode/forge/preparation"
import { usage } from "@kilocode/forge/schema"
import { useDialog } from "../../src/ui/dialog"
import { forgePrompt } from "../../src/kilocode/forge/prompt"
import { stream } from "./forge-stream"
import type { Investigation } from "@kilocode/forge/investigation"
import { compose, type Prepared } from "@kilocode/forge/writing"
import { hash } from "@kilocode/forge/util"

export function record(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value)
}

export function enhanced(original: string, questions: readonly unknown[] = []) {
  return json({
    id: "26996be9-bc68-4dfa-bf80-0de3ff999412",
    generation: "fixture",
    session: "ses_forge",
    ...prepare(
      {
        objective: "Improve the requested task",
        reuse: [],
        inspect: [],
        changes: [],
        constraints: [],
        hypotheses: [],
        questions,
        acceptance: [],
        verification: [],
        evidence: [],
      },
      original,
    ),
    original,
    context: select([], 1000),
    usage: usage(),
    warnings: [],
  })
}

export function workshop(root: string) {
  const item = source("queue.ts", "export const rawEvidenceCanary = 'unselected raw source text'", "code")
  const investigation: Investigation = {
    version: 1,
    id: crypto.randomUUID(),
    revision: crypto.randomUUID(),
    digest: "fixture",
    root,
    session: "ses_forge",
    original: "Fix duplicate queue items",
    answers: "",
    feedback: "",
    model: { providerID: "test", modelID: "test" },
    destination: "",
    policy: "",
    state: "findings_ready",
    intent: "Fix duplicate queue items",
    summary: "Review a supported direction.",
    findings: [
      {
        id: "fix",
        title: "Guard duplicate queue identifiers",
        kind: "defect",
        support: "observed",
        explanation: "The append path lacks a duplicate check.",
        benefit: "Avoid repeated work.",
        evidence: [item.id],
        counterevidence: [],
        unknowns: [],
        action: "Add a duplicate guard.",
        verification: ["Add a regression test."],
      },
      {
        id: "other",
        title: "Unselected redesign canary",
        kind: "improvement",
        support: "inferred",
        explanation: "A redesign could be considered.",
        benefit: "Potential maintenance benefit.",
        evidence: [item.id],
        counterevidence: [],
        unknowns: ["Not required for this defect."],
        action: "Investigate separately.",
        verification: ["Compare behavior."],
      },
    ],
    questions: [],
    limitations: ["Tests were not executed."],
    observations: [
      {
        id: "read",
        tool: "forge_read_file",
        input: { path: "queue.ts" },
        output: item.text,
        sources: [item],
        observed: 1,
      },
    ],
    turns: 2,
    calls: 1,
    bytes: 1000,
    started: 1,
    updated: 2,
    usage: usage(),
  }
  const prompt: Prepared = {
    version: 1,
    id: crypto.randomUUID(),
    revision: crypto.randomUUID(),
    root,
    session: "ses_forge",
    scope: "ses_forge",
    investigation: investigation.id,
    parent: investigation.revision,
    digest: "fixture",
    requirements: [{ id: "user", label: "Original user request", text: investigation.original }],
    findings: [],
    sources: [item],
    dependencies: [item],
    model: investigation.model,
    destination: "",
    policy: "",
    state: "selected",
    prompt: "",
    hash: "",
    started: 1,
    updated: 2,
    usage: usage(),
  }
  return { investigation, prompt, stale: false }
}

export async function mount(
  root: string,
  valid = true,
  collections: readonly Collection[] = [],
  selections: readonly Selection[] = [],
  intercept?: (path: string, request: Request) => Promise<Response | undefined>,
  browser?: () => Promise<string>,
  directory = () => root,
  connection?: {
    url: string
    headers: Record<string, string>
    session?: string
    reads?: (path: string, request: Request) => Promise<Response | undefined>
    events?: EventSource
  },
  scenario?: ReturnType<typeof workshop>,
) {
  await Bun.write(`${root}/kv.json`, JSON.stringify({ animations_enabled: false, vim_enabled: false }))
  const requests: { path: string; body: Record<string, unknown> }[] = []
  const session = {
    id: connection?.session ?? "ses_forge",
    projectID: "proj_test",
    directory: root,
    title: "Forge",
    time: { created: 1, updated: 1 },
  }
  const provider = {
    id: "test",
    name: "Test",
    models: { test: { id: "test", name: "Test", limit: { context: 10000, output: 1000 } } },
  }
  const calls = createFetch((url) => {
    if (url.pathname === "/path")
      return json({ home: root, state: root, config: root, worktree: root, directory: directory() })
    if (url.pathname === "/session") return json([session])
    if (url.pathname === "/agent") return json([{ name: "build", mode: "primary", options: {}, permission: [] }])
    if (url.pathname === "/config/providers") return json({ providers: [provider], default: { test: "test" } })
    if (url.pathname === "/provider")
      return json({
        all: [provider],
        default: { test: "test" },
        connected: ["test"],
      })
    return undefined
  })
  // Exercise the real SDK transport, composer, extmarks, and dialog; replace only backend responses.
  const fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      const path = new URL(request.url).pathname
      if (request.method === "GET" && connection?.reads) {
        const response = await connection.reads(path, request)
        if (response) return response
      }
      if (request.method === "GET" && path === "/forge/investigations/status") return json({ enabled: !!scenario })
      if (request.method === "GET" && scenario && path.startsWith("/forge/preparations/"))
        return scenario.stale
          ? json({ message: "Evidence changed; review the prepared prompt." }, { status: 409 })
          : json(scenario.prompt)
      if (request.method === "GET" && scenario && path.startsWith("/forge/investigations/"))
        return json(scenario.investigation)
      if (request.method === "GET" && path === "/forge/knowledge") return json({ collections, provider: "" })
      if (request.method === "GET" && path === "/forge/status")
        return json({
          inventory: { root, generation: "fixture", indexed: false, files: 0, counts: {}, warnings: [] },
          job: { id: "", state: "idle", started: 0, updated: 0, message: "Ready" },
          session: session.id,
        })
      if (request.method === "GET" && path === "/forge/view")
        return json({ root, generation: "fixture", sources: [], warnings: [] })
      if (request.method === "POST" || (request.method === "PUT" && path.startsWith("/forge/knowledge/"))) {
        const body: unknown = await request.json()
        if (!record(body)) throw new Error("Expected a JSON request object")
        requests.push({ path, body })
        if (scenario && path === "/forge/investigations/stream") {
          const response = await intercept?.(path, request)
          if (response) return response
          scenario.investigation = {
            ...scenario.investigation,
            id: String(body.key),
            original: String(body.text),
            answers: typeof body.answers === "string" ? body.answers : "",
            feedback: typeof body.feedback === "string" ? body.feedback : "",
          }
          return new Response(
            `data: ${JSON.stringify({ type: "result", investigation: scenario.investigation })}\n\n`,
            { headers: { "content-type": "text/event-stream" } },
          )
        }
        if (scenario && path === "/forge/preparations") {
          expect(Array.isArray(body.selected)).toBe(true)
          scenario.prompt = {
            ...scenario.prompt,
            id: String(body.key),
            investigation: scenario.investigation.id,
            requirements: [{ id: "user", label: "Original user request", text: scenario.investigation.original }],
            findings: scenario.investigation.findings.filter(
              (item) => Array.isArray(body.selected) && body.selected.includes(item.id),
            ),
          }
          return json(scenario.prompt)
        }
        if (scenario && path === "/forge/preparations/write") {
          scenario.prompt = {
            ...scenario.prompt,
            ...compose(
              {
                objective: "Fix duplicated queue identifiers.",
                basis: "The inspected append path lacks a guard; runtime verification remains pending.",
                changes: ["Add a duplicate guard."],
                constraints: ["Keep insertion order."],
                verification: ["Proposed: add a repeated-identifier regression."],
                evidence: scenario.prompt.sources.map((item) => item.id),
                requirements: ["user"],
              },
              scenario.prompt,
            ),
            revision: crypto.randomUUID(),
            state: "ready",
          }
          return json(scenario.prompt)
        }
        if (scenario && path === "/forge/preparations/edit") {
          scenario.prompt = {
            ...scenario.prompt,
            prompt: String(body.text),
            hash: hash(String(body.text)),
            revision: crypto.randomUUID(),
          }
          return json(scenario.prompt)
        }
        if (scenario && path === "/forge/preparations/bind") return json(scenario.prompt)
        const response = await intercept?.(path, request)
        if (response) return path === "/forge/enhance/stream" ? stream(response) : response
        if (path === "/forge/knowledge/preview")
          return json({
            location: body.location,
            files: 1,
            bytes: 30,
            excluded: 0,
            partial: false,
            samples: [{ name: body.label, bytes: 30, text: "Previewed document evidence" }],
            warnings: [],
          })
        if (path === "/forge/knowledge")
          return json({ ...body, id: "registered-document", approved: false, providers: [], state: "registered" })
        if (request.method === "PUT" && path.startsWith("/forge/knowledge/"))
          return json({
            collection: {
              id: "registered-document",
              approved: true,
              providers: [],
              state: body.action === "index" ? "indexing" : "registered",
            },
          })
        if (path === "/forge/enhance/stream") {
          if (typeof body.text !== "string") throw new Error("Expected enhancement requirements")
          return stream(
            json({
              id: "26996be9-bc68-4dfa-bf80-0de3ff999412",
              original: body.text,
              prompt: `Implement the reviewed task:\n${body.text}${typeof body.answers === "string" ? `\nClarifications:\n${body.answers}` : ""}${typeof body.feedback === "string" ? `\nFeedback:\n${body.feedback}` : ""}`,
              status: "ready",
              context: selections.at(requests.filter((item) => item.path === path).length - 1) ?? {
                matches: [],
                text: "Local evidence",
                estimator: "test",
                tokens: 3,
                budget: 1000,
                omitted: [],
              },
              warnings: ["Review fixture warning"],
            }),
          )
        }
        if (path === "/forge/validate") return json({ valid })
        if (path.startsWith("/session/")) return json({})
      }
      return calls.fetch(request)
    },
    { preconnect: globalThis.fetch.preconnect.bind(globalThis.fetch) },
  )
  const refs: {
    prompt?: ReturnType<typeof usePromptRef>
    permission?: ReturnType<typeof usePermission>
    route?: ReturnType<typeof useRoute>
    project?: ReturnType<typeof useProject>
    toast?: ReturnType<typeof useToast>
  } = {}
  function Content() {
    const dialog = useDialog()
    const keymap = useOpencodeKeymap()
    onCleanup(
      keymap.registerLayer({
        commands: [
          {
            namespace: "palette",
            name: "forge.enhance",
            title: "Forge enhance",
            slashName: "enhance",
            run: () => {
              forgePrompt("/enhance", dialog)
            },
          },
        ],
        bindings: [],
      }),
    )
    const prompt = usePromptRef()
    refs.prompt = prompt
    refs.permission = usePermission()
    refs.route = useRoute()
    refs.project = useProject()
    refs.toast = useToast()
    return <Prompt sessionID={session.id} ref={(ref) => prompt.set(ref)} />
  }
  function Ready() {
    const sync = useSync()
    return (
      <Show when={sync.status === "complete"}>
        <ThemeProvider mode="dark" source={{ discover: async () => ({}) }}>
          <LocalProvider>
            <PromptStashProvider>
              <ForgeComposerProvider>
                <NudgeProvider>
                  <FrecencyProvider>
                    <PromptHistoryProvider>
                      <EditorContextProvider integration={{}}>
                        <LocationProvider>
                          <Content />
                        </LocationProvider>
                      </EditorContextProvider>
                    </PromptHistoryProvider>
                  </FrecencyProvider>
                </NudgeProvider>
              </ForgeComposerProvider>
            </PromptStashProvider>
          </LocalProvider>
        </ThemeProvider>
      </Show>
    )
  }
  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig()
    const runtime = {
      ...createPluginRuntime(),
      Slot: createSlot(createSolidSlotRegistry<Record<string, object>>(renderer, {})),
    }
    onCleanup(registerOpencodeKeymap(keymap, renderer, config))
    return (
      <DirectoryProvider>
        <TestTuiContexts directory={root} paths={{ home: root, state: root, worktree: root }}>
          <ClipboardProvider value={{}}>
            <OpencodeKeymapProvider keymap={keymap}>
              <ArgsProvider>
                <KVProvider>
                  <ToastProvider>
                    <RouteProvider initialRoute={{ type: "session", sessionID: session.id }}>
                      <TuiConfigProvider config={config}>
                        <PluginRuntimeProvider value={runtime}>
                          <SDKProvider
                            url={connection?.url ?? "http://test"}
                            headers={connection?.headers}
                            directory={root}
                            fetch={fetch}
                            events={connection?.events ?? eventSource()}
                            browser={browser}
                          >
                            <PermissionProvider>
                              <ProjectProvider>
                                <ExitProvider
                                  exit={() => {
                                    throw new Error("Unexpected exit")
                                  }}
                                >
                                  <SyncProvider>
                                    <DataProvider>
                                      <Ready />
                                    </DataProvider>
                                  </SyncProvider>
                                </ExitProvider>
                              </ProjectProvider>
                            </PermissionProvider>
                          </SDKProvider>
                        </PluginRuntimeProvider>
                      </TuiConfigProvider>
                    </RouteProvider>
                  </ToastProvider>
                </KVProvider>
              </ArgsProvider>
            </OpencodeKeymapProvider>
          </ClipboardProvider>
        </TestTuiContexts>
      </DirectoryProvider>
    )
  }
  const app = await testRender(() => <Harness />, { width: 120, height: 40, kittyKeyboard: true })
  try {
    await wait(() => !!refs.prompt?.current?.focused, 10_000)
    const prompt = refs.prompt!.current!
    const input = app.renderer.currentFocusedEditor
    if (!(input instanceof TextareaRenderable)) throw new Error("Expected a real composer")
    return {
      app,
      prompt,
      input,
      requests,
      permission: refs.permission!,
      route: refs.route!,
      project: refs.project!,
      toast: refs.toast!,
      async press(value: string) {
        app.renderer.stdin.emit("data", Buffer.from(value))
        await app.flush()
      },
      async frame(text: string) {
        await wait(() => app.captureCharFrame().includes(text), 4000).catch((err) => {
          throw new Error(`Missing ${text}\n${app.captureCharFrame()}\n${JSON.stringify(requests)}`, { cause: err })
        })
      },
      [Symbol.dispose]() {
        prompt.reset()
        app.renderer.destroy()
      },
    }
  } catch (err) {
    app.renderer.destroy()
    throw err
  }
}
