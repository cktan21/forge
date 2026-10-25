import { ScrollBoxRenderable, TextareaRenderable, type Renderable } from "@opentui/core"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { createSlot, createSolidSlotRegistry, testRender, useRenderer, useTerminalDimensions } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { onCleanup, Show } from "solid-js"
import { NudgeProvider } from "../../../opencode/src/kilocode/cli/cmd/tui/context/nudge"
import { TuiConfigProvider } from "../../src/config"
import { ArgsProvider } from "../../src/context/args"
import { ClipboardProvider } from "../../src/context/clipboard"
import { DataProvider } from "../../src/context/data"
import { EditorContextProvider } from "../../src/context/editor"
import { EpilogueProvider } from "../../src/context/epilogue"
import { ExitProvider } from "../../src/context/exit"
import { KVProvider } from "../../src/context/kv"
import { LocalProvider } from "../../src/context/local"
import { LocationProvider } from "../../src/context/location"
import { PermissionProvider } from "../../src/context/permission"
import { ProjectProvider } from "../../src/context/project"
import { PromptRefProvider, usePromptRef } from "../../src/context/prompt"
import { DirectoryProvider } from "../../src/kilocode/directory-context"
import { RouteProvider } from "../../src/context/route"
import { TuiTerminalEnvironmentProvider } from "../../src/context/runtime"
import { SDKProvider } from "../../src/context/sdk"
import { SyncProvider, useSync } from "../../src/context/sync"
import { ThemeProvider } from "../../src/context/theme"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../src/keymap"
import { createPluginRuntime, PluginRuntimeProvider } from "../../src/plugin/runtime"
import { FrecencyProvider } from "../../src/prompt/frecency"
import { PromptHistoryProvider } from "../../src/prompt/history"
import { PromptStashProvider } from "../../src/prompt/stash"
import { Session } from "../../src/routes/session"
import { DialogProvider } from "../../src/ui/dialog"
import { ToastProvider, useToast } from "../../src/ui/toast"
import { wait } from "../cli/cmd/tui/sync-fixture"
import { tmpdir } from "../fixture/fixture"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { createFetch, directory, eventSource, json } from "../fixture/tui-sdk"

function scrollbox(node: Renderable): ScrollBoxRenderable | undefined {
  if (node instanceof ScrollBoxRenderable) return node
  for (const child of node.getChildren()) {
    const result = scrollbox(child)
    if (result) return result
  }
  return undefined
}

async function mount(
  root: string,
  width = 80,
  navigation?: { directory: string; change: (dir: string) => void; exit: () => void },
) {
  await Bun.write(`${root}/kv.json`, JSON.stringify({ animations_enabled: false, sidebar: "hide", vim_enabled: false }))
  const cwd = navigation?.directory ?? directory
  const requests: string[] = []
  const session = {
    id: "ses_home_end",
    slug: "home-end",
    projectID: "proj_test",
    directory: cwd,
    title: "Home and End navigation",
    version: "test",
    time: { created: 1, updated: 1 },
  }
  const messages = Array.from({ length: 15 }, (_, index) => {
    const id = `msg_${String(index).padStart(3, "0")}`
    return {
      info: {
        id,
        sessionID: session.id,
        role: "user",
        agent: "build",
        model: { providerID: "test", modelID: "test" },
        time: { created: index + 1 },
      },
      parts: [
        {
          id: `prt_${index}`,
          sessionID: session.id,
          messageID: id,
          type: "text",
          text: `Transcript row ${index + 1}`,
        },
      ],
    }
  })
  const calls = createFetch((url) => {
    requests.push(url.pathname)
    if (url.pathname === "/path") return json({ home: root, state: root, config: root, worktree: cwd, directory: cwd })
    if (url.pathname === `/session/${session.id}/abort`) return json(true)
    if (url.pathname === "/session") return json([session])
    if (url.pathname === `/session/${session.id}`) return json(session)
    if (url.pathname === `/session/${session.id}/message`) return json(messages)
    if ([`/session/${session.id}/todo`, `/session/${session.id}/diff`].includes(url.pathname)) return json([])
    if (url.pathname.startsWith("/background-process/")) return json(true)
    return undefined
  })
  const config = createTuiResolvedConfig()
  const refs: {
    prompt?: ReturnType<typeof usePromptRef>
    sync?: ReturnType<typeof useSync>
    toast?: ReturnType<typeof useToast>
  } = {}

  function Ready() {
    const sync = useSync()
    refs.sync = sync
    return (
      <Show when={sync.status === "complete"}>
        <ThemeProvider mode="dark" source={{ discover: async () => ({}) }}>
          <LocalProvider>
            <PromptStashProvider>
              <DialogProvider>
                <NudgeProvider>
                  <FrecencyProvider>
                    <PromptHistoryProvider>
                      <PromptRefProvider>
                        <EditorContextProvider integration={{}}>
                          <LocationProvider>
                            <Content />
                          </LocationProvider>
                        </EditorContextProvider>
                      </PromptRefProvider>
                    </PromptHistoryProvider>
                  </FrecencyProvider>
                </NudgeProvider>
              </DialogProvider>
            </PromptStashProvider>
          </LocalProvider>
        </ThemeProvider>
      </Show>
    )
  }

  function Content() {
    refs.prompt = usePromptRef()
    refs.toast = useToast()
    const dimensions = useTerminalDimensions()
    return (
      <box width={dimensions().width} height={dimensions().height} flexDirection="column">
        <box flexGrow={1} minHeight={0} flexDirection="column">
          <Session />
        </box>
      </box>
    )
  }

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const runtime = {
      ...createPluginRuntime(),
      Slot: createSlot(createSolidSlotRegistry<Record<string, object>>(renderer, {})),
    }
    onCleanup(registerOpencodeKeymap(keymap, renderer, config))
    return (
      <DirectoryProvider change={navigation?.change}>
        <TestTuiContexts directory={root} paths={{ home: root, state: root, worktree: root }}>
          <TuiTerminalEnvironmentProvider value={{ platform: process.platform }}>
            <ClipboardProvider value={{}}>
              <OpencodeKeymapProvider keymap={keymap}>
                <ArgsProvider>
                  <KVProvider>
                    <ToastProvider>
                      <RouteProvider initialRoute={{ type: "session", sessionID: session.id }}>
                        <TuiConfigProvider config={config}>
                          <PluginRuntimeProvider value={runtime}>
                            <SDKProvider url="http://test" directory={cwd} fetch={calls.fetch} events={eventSource()}>
                              <PermissionProvider>
                                <ProjectProvider>
                                  <ExitProvider
                                    exit={() => {
                                      if (navigation) return navigation.exit()
                                      throw new Error("Unexpected exit")
                                    }}
                                  >
                                    <EpilogueProvider set={() => {}}>
                                      <SyncProvider>
                                        <DataProvider>
                                          <Ready />
                                        </DataProvider>
                                      </SyncProvider>
                                    </EpilogueProvider>
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
          </TuiTerminalEnvironmentProvider>
        </TestTuiContexts>
      </DirectoryProvider>
    )
  }

  const app = await testRender(() => <Harness />, { width, height: 30 })
  try {
    await wait(() => !!refs.prompt?.current?.focused && refs.sync?.data.message[session.id]?.length === messages.length)
    await Bun.sleep(60)
    await app.flush()
    const input = app.renderer.currentFocusedEditor
    const prompt = refs.prompt?.current
    const scroll = scrollbox(app.renderer.root)
    if (!(input instanceof TextareaRenderable) || !prompt || !scroll)
      throw new Error("Expected rendered Session prompt")
    expect(input.width).toBeGreaterThan(0)
    expect(scroll.scrollHeight).toBeGreaterThan(scroll.viewport.height)
    return {
      app,
      input,
      prompt,
      scroll,
      requests,
      toast: refs.toast!,
      async press(sequence: string) {
        app.renderer.stdin.emit("data", Buffer.from(sequence))
        await app.flush()
        return input.cursorOffset
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

const cases = [
  { name: "single-line", text: "abcdef", offset: 3, start: 0, end: 6, width: 80 },
  { name: "multiline", text: "alpha\nbeta\ngamma", offset: 8, start: 6, end: 10, width: 80 },
  {
    name: "wrapped",
    text: "alpha bravo charlie delta echo foxtrot golf hotel",
    offset: 25,
    start: 0,
    end: 49,
    width: 24,
  },
]

for (const item of cases) {
  test(`Home and End move through the focused ${item.name} prompt buffer`, async () => {
    await using tmp = await tmpdir()
    using scene = await mount(tmp.path, item.width)
    scene.prompt.set({ input: item.text, parts: [] })
    scene.input.cursorOffset = item.offset
    await scene.app.flush()
    if (item.name === "wrapped") expect(scene.input.editorView.getTotalVirtualLineCount()).toBeGreaterThan(1)
    scene.scroll.scrollTo(1)
    const home = await scene.press("\x1b[H")
    scene.input.cursorOffset = item.offset
    const end = await scene.press("\x1b[F")
    expect({ home, end }).toEqual({ home: 0, end: item.text.length })
    expect(scene.scroll.scrollTop).toBe(1)
    expect(scene.input.plainText).toBe(item.text)
    expect(scene.input.focused).toBe(true)
  })
}

test("arrows and Ctrl+A/E still edit the focused Session prompt", async () => {
  await using tmp = await tmpdir()
  using scene = await mount(tmp.path)
  for (const item of cases) {
    scene.app.resize(item.width, 30)
    scene.prompt.set({ input: item.text, parts: [] })
    scene.input.cursorOffset = item.offset
    await scene.app.flush()
    expect(await scene.press("\x1b[D")).toBe(item.offset - 1)
    expect(await scene.press("\x1b[C")).toBe(item.offset)
    expect(await scene.press("\x01")).toBe(item.start)
    expect(await scene.press("\x05")).toBe(item.end)
    expect(scene.input.plainText).toBe(item.text)
    expect(scene.input.focused).toBe(true)
  }
})

test("Home and End navigate the transcript with an unfocused prompt", async () => {
  await using tmp = await tmpdir()
  using scene = await mount(tmp.path)
  scene.prompt.set({ input: "abcdef", parts: [] })
  scene.input.cursorOffset = 3
  await scene.app.flush()
  scene.prompt.blur()
  expect(scene.app.renderer.currentFocusedEditor).toBeNull()
  expect(await scene.press("\x1b[H")).toBe(3)
  expect(scene.scroll.scrollTop).toBe(0)
  scene.prompt.blur()
  expect(scene.app.renderer.currentFocusedEditor).toBeNull()
  expect(await scene.press("\x1b[F")).toBe(3)
  expect(scene.scroll.scrollTop).toBe(scene.scroll.scrollHeight - scene.scroll.viewport.height)
  expect(scene.input.plainText).toBe("abcdef")
})

test("Ctrl+G and Ctrl+Alt+G navigate the transcript while the prompt is focused", async () => {
  await using tmp = await tmpdir()
  using scene = await mount(tmp.path)
  scene.prompt.set({ input: "abcdef", parts: [] })
  scene.input.cursorOffset = 3
  await scene.app.flush()
  expect(await scene.press("\x07")).toBe(3)
  expect(scene.scroll.scrollTop).toBe(0)
  expect(await scene.press("\x1b\x07")).toBe(3)
  expect(scene.scroll.scrollTop).toBe(scene.scroll.scrollHeight - scene.scroll.viewport.height)
  expect(scene.input.focused).toBe(true)
  expect(scene.input.plainText).toBe("abcdef")
})

test("/cd completes a quoted directory with Tab, then stops the old chat before switching", async () => {
  await using tmp = await tmpdir()
  await mkdir(`${tmp.path}/space project`)
  const events: string[] = []
  using scene = await mount(tmp.path, 120, {
    directory: tmp.path,
    change: (dir) => events.push(dir),
    exit: () => events.push("exit"),
  })
  scene.prompt.set({ input: "/cd spa", parts: [] })
  await wait(() => scene.app.captureCharFrame().includes("space project/"))
  await scene.press("\t")
  await wait(() => scene.input.plainText === '/cd "space project/"')
  expect(events).toEqual([])
  await scene.press("\r")
  await wait(() => events.length === 2)
  expect(events).toEqual([`${tmp.path}/space project`, "exit"])
  expect(scene.requests.filter((url) => url.endsWith("/abort"))).toEqual(["/session/ses_home_end/abort"])
  expect(scene.requests.some((url) => url.endsWith("/prompt_async"))).toBe(false)
})

test("/cd invalid paths and completion dismissal preserve the existing chat", async () => {
  await using tmp = await tmpdir()
  const events: string[] = []
  using scene = await mount(tmp.path, 120, {
    directory: tmp.path,
    change: (dir) => events.push(dir),
    exit: () => events.push("exit"),
  })
  scene.prompt.set({ input: "/cd does-not-exist", parts: [] })
  await scene.app.flush()
  await scene.press("\x1b")
  // Let the terminal distinguish Escape from an Alt+Enter sequence.
  await Bun.sleep(80)
  expect(scene.input.plainText).toBe("/cd does-not-exist")
  await scene.press("\r")
  await wait(() => scene.toast.currentToast?.title === "Could not change directory").catch((err) => {
    throw new Error(
      JSON.stringify({
        text: scene.input.plainText,
        focused: scene.input.focused,
        toast: scene.toast.currentToast,
        events,
        frame: scene.app.captureCharFrame(),
      }),
      { cause: err },
    )
  })
  expect(events).toEqual([])
  expect(scene.requests.some((url) => url.endsWith("/abort"))).toBe(false)
  expect(scene.prompt.current.input).toBe("/cd does-not-exist")
})
