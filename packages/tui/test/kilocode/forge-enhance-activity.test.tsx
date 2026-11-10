/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { unwrap } from "solid-js/store"
import { tmpdir } from "../fixture/fixture"
import { json } from "../fixture/tui-sdk"
import { enhanced, mount } from "./forge-composer-fixture"

test("file activity is split into collapsed sections with independent keyboard expansion", async () => {
  await using root = await tmpdir()
  const original = "Improve the guide"
  using ui = await mount(root.path, true, [], [], async (path) => {
    if (path !== "/forge/enhance/stream") return undefined
    return json({
      ...(await enhanced(original).json()),
      activity: {
        total: 26,
        counts: { repository: 25, context: 1 },
        entries: [
          { action: "Read locally", path: "read-only.ts", detail: "Local repository read" },
          { action: "Selected for model", path: "selected.ts:10-20", detail: "Selected excerpt" },
        ],
      },
    })
  })
  ui.prompt.set({ input: `/enhance ${original}`, parts: [] })
  const draft = structuredClone(unwrap(ui.prompt.current))
  await ui.press("\r")
  await ui.frame("[a] Use prompt")
  await ui.press("t")
  await ui.frame("Repository reads (25 updates)")
  expect(ui.app.captureCharFrame()).not.toContain("read-only.ts")
  expect(ui.app.captureCharFrame()).not.toContain("selected.ts:10-20")
  await ui.press("\r")
  await ui.frame("read-only.ts")
  await ui.frame("Showing the latest 1 updates")
  await ui.press("\r")
  await ui.press("\t")
  await ui.press("\t")
  await ui.press("\t")
  await ui.press(" ")
  await ui.frame("selected.ts:10-20")
  expect(ui.app.captureCharFrame()).not.toContain("read-only.ts")
  expect(ui.requests).toHaveLength(1)
  expect(ui.prompt.current).toEqual(draft)
  await ui.press("\x1b")
  await ui.frame("[a] Use prompt")
})
