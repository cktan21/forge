/** @jsxImportSource @opentui/solid */
import { test, expect } from "bun:test"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { chromium, expect as browserExpect } from "../../../kilo-forge-ui/e2e/status-client"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { onCleanup, onMount } from "solid-js"
import { TuiConfigProvider } from "../../src/config"
import { KVProvider } from "../../src/context/kv"
import { ProjectProvider } from "../../src/context/project"
import { RouteProvider } from "../../src/context/route"
import { SDKProvider } from "../../src/context/sdk"
import { ThemeProvider } from "../../src/context/theme"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../src/keymap"
import { forgePrompt } from "../../src/kilocode/forge/prompt"
import { DialogProvider, useDialog } from "../../src/ui/dialog"
import { ToastProvider } from "../../src/ui/toast"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"

for (const mode of ["source", "packaged"] as const) {
  test.skipIf((mode === "source" ? process.env.FORGE_HELD_SOURCE : process.env.FORGE_HELD_SERVER) !== "1")(
    `${mode} status stays usefully held in TUI and browser`,
    async () => {
      const root = path.resolve(import.meta.dir, "../../../..")
      const home = await mkdtemp(path.join(os.tmpdir(), `forge-status-${mode}-`))
      const directory = path.join(home, "workspace")
      await mkdir(directory)
      await Bun.write(path.join(home, "kv.json"), "{}")
      const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
      const port = probe.port
      await probe.stop(true)
      const origin = `http://127.0.0.1:${port}`
      const authorization = `Basic ${Buffer.from("kilo:held-status-fixture").toString("base64")}`
      const binary =
        process.env.FORGE_HELD_BINARY ??
        path.join(root, `packages/opencode/dist/@kilocode/cli-${process.platform}-${process.arch}/bin/kilo`)
      const command =
        mode === "source"
          ? [process.execPath, "run", "--cwd", root, "dev", "serve", "--hostname", "127.0.0.1", "--port", String(port)]
          : [binary, "serve", "--hostname", "127.0.0.1", "--port", String(port)]
      const proc = Bun.spawn(command, {
        cwd: directory,
        env: {
          ...process.env,
          HOME: home,
          XDG_DATA_HOME: path.join(home, "data"),
          XDG_CONFIG_HOME: path.join(home, "config"),
          XDG_STATE_HOME: path.join(home, "state"),
          XDG_CACHE_HOME: path.join(home, "cache"),
          KILO_TEST_HOME: home,
          KILO_SERVER_PASSWORD: "held-status-fixture",
          KILO_AUTH_CONTENT: "{}",
          KILO_DISABLE_PROJECT_CONFIG: "1",
          KILO_DISABLE_MODELS_FETCH: "1",
          KILO_TELEMETRY_LEVEL: "off",
          KILO_CONFIG_CONTENT: JSON.stringify({
            plugin: [],
            enabled_providers: [],
            indexing: { enabled: false },
            snapshot: false,
            formatter: false,
            lsp: false,
          }),
        },
        stdout: Bun.file(path.join(home, "stdout.log")),
        stderr: Bun.file(path.join(home, "stderr.log")),
      })
      const pending: { release: ReturnType<typeof Promise.withResolvers<void>>; status: number; body: string }[] = []
      const calls: { method: string; path: string }[] = []
      const proxy = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          const url = new URL(request.url)
          calls.push({ method: request.method, path: url.pathname })
          // Keep this response-gate probe independent of semantic-readiness SSE refreshes.
          if (url.pathname === "/event") return new Response("", { headers: { "content-type": "text/event-stream" } })
          const response = await fetch(new URL(url.pathname + url.search, origin), {
            headers: { authorization },
            signal: AbortSignal.timeout(15_000),
          })
          if (url.pathname !== "/forge/status") return response
          const item = { release: Promise.withResolvers<void>(), status: response.status, body: await response.text() }
          pending.push(item)
          await item.release.promise
          return new Response(item.body, { status: item.status, headers: { "content-type": "application/json" } })
        },
      })
      let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
      let app: Awaited<ReturnType<typeof testRender>> | undefined
      async function until(fn: () => boolean | Promise<boolean>, timeout = 10_000) {
        const end = performance.now() + timeout
        while (performance.now() < end) {
          if (await fn()) return
          await Bun.sleep(5)
        }
        throw new Error("Bounded condition timed out")
      }
      try {
        await until(() =>
          fetch(`${origin}/global/health`, { headers: { authorization }, signal: AbortSignal.timeout(500) }).then(
            (response) => response.ok,
            () => false,
          ),
        )
        browser = await chromium.launch({
          headless: true,
          executablePath:
            process.env.FORGE_CHROME ??
            (process.platform === "darwin"
              ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
              : undefined),
        })
        let opened = 0
        function Open() {
          const dialog = useDialog()
          onMount(() => {
            opened = performance.now()
            forgePrompt("/overview", dialog)
          })
          return <text>Chat remains available</text>
        }
        function Harness() {
          const renderer = useRenderer()
          const keymap = createDefaultOpenTuiKeymap(renderer)
          const config = createTuiResolvedConfig()
          onCleanup(registerOpencodeKeymap(keymap, renderer, config))
          return (
            <TestTuiContexts directory={directory} paths={{ home, state: home, worktree: directory }}>
              <OpencodeKeymapProvider keymap={keymap}>
                <TuiConfigProvider config={config}>
                  <SDKProvider
                    url={proxy.url.toString()}
                    directory={directory}
                    events={{ subscribe: async () => () => {} }}
                  >
                    <ProjectProvider>
                      <RouteProvider>
                        <KVProvider>
                          <ThemeProvider mode="dark" source={{ discover: async () => ({}) }}>
                            <ToastProvider>
                              <DialogProvider>
                                <Open />
                              </DialogProvider>
                            </ToastProvider>
                          </ThemeProvider>
                        </KVProvider>
                      </RouteProvider>
                    </ProjectProvider>
                  </SDKProvider>
                </TuiConfigProvider>
              </OpencodeKeymapProvider>
            </TestTuiContexts>
          )
        }
        app = await testRender(() => <Harness />, { width: 120, height: 42 })
        const frame = async (text: string) => {
          await app!.renderOnce()
          return app!.captureCharFrame().includes(text)
        }
        await until(() => frame("Backend progress is not observed"), 450)
        const tui = performance.now() - opened
        expect(tui).toBeLessThan(500)
        expect(app.captureCharFrame()).toContain("Saved inventory unknown")
        expect(app.captureCharFrame()).toContain("Inspection starts no model call or scan")
        await until(() => pending.length === 1)
        await until(() => frame("1s elapsed"))
        expect(pending.at(0)!.status).toBe(200)
        expect(JSON.parse(pending.at(0)!.body).job.state).toBe("idle")
        pending.at(0)!.release.resolve()
        await until(() => frame("No inventory yet."))
        await until(() => frame("Page 1"))
        expect(app.captureCharFrame()).not.toContain("Waiting for")
        app.mockInput.pressEscape()
        await until(() => frame("Chat remains available"))
        app.renderer.destroy()
        app = undefined

        const page = await browser.newPage()
        await page.addInitScript(() => {
          const fetch = window.fetch.bind(window)
          Object.assign(window, {
            fetch: (input: RequestInfo | URL, init?: RequestInit) => {
              if (
                new URL(input instanceof Request ? input.url : input, window.location.href).pathname === "/forge/status"
              )
                performance.mark("status-start")
              return fetch(input, init)
            },
          })
          const observer = new MutationObserver(() => {
            if (
              !document
                .querySelector('[aria-label="Inventory status"]')
                ?.textContent?.includes("Backend progress is not observed")
            )
              return
            observer.disconnect()
            requestAnimationFrame(() => performance.mark("status-useful"))
          })
          observer.observe(document, { subtree: true, childList: true })
        })
        await page.goto(`${proxy.url}forge/?directory=${encodeURIComponent(directory)}`, {
          waitUntil: "domcontentloaded",
        })
        const region = page.getByRole("region", { name: "Inventory status" })
        await browserExpect(region).toContainText("Saved inventory unknown")
        await browserExpect(region).toContainText("Inspection starts no model call or scan")
        await page.waitForFunction(() => performance.getEntriesByName("status-useful").length === 1)
        const web = await page.evaluate(() => performance.measure("useful", "status-start", "status-useful").duration)
        expect(web).toBeLessThan(500)
        await until(() => pending.length === 2)
        await browserExpect(region).toContainText("1s elapsed")
        expect(pending.at(1)!.status).toBe(200)
        expect(JSON.parse(pending.at(1)!.body).inventory).toEqual(JSON.parse(pending.at(0)!.body).inventory)
        expect(JSON.parse(pending.at(1)!.body).job.state).toBe("idle")
        pending.at(1)!.release.resolve()
        await browserExpect(page.locator("main")).toContainText("Last observed generation: unindexed")
        await browserExpect(region).not.toContainText("Waiting for")
        await browserExpect(region).not.toContainText("unknown")
        expect(calls.every((call) => call.method === "GET")).toBe(true)
        expect(calls.filter((call) => call.path === "/forge/status")).toHaveLength(2)
        console.log(
          JSON.stringify({
            tui,
            browser: web,
            heldResponses: pending.length,
            realStatus: JSON.parse(pending.at(0)!.body),
            calls,
            command,
            mode,
            boundary:
              "TUI dialog open / browser status dispatch to useful rendered wait; actual HTTP response held by loopback proxy",
          }),
        )
      } finally {
        app?.renderer.destroy()
        for (const item of pending) item.release.resolve()
        await browser?.close()
        await proxy.stop(true)
        proc.kill("SIGTERM")
        const timer = setTimeout(() => proc.kill("SIGKILL"), 5000)
        const code = await proc.exited
        clearTimeout(timer)
        console.log(JSON.stringify({ backendExit: code }))
        await until(() =>
          fetch(`${origin}/global/health`, { signal: AbortSignal.timeout(500) }).then(
            () => false,
            () => true,
          ),
        )
        await rm(home, { recursive: true, force: true })
      }
    },
    30_000,
  )
}
