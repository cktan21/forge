import { expect, test } from "bun:test"
import { invocation } from "../../src/kilocode/cli/cmd/tui/directory"

test("relaunch the bundled CLI without resuming or forwarding chat content", () => {
  const args = { model: "provider/model", agent: "ask", session: "old", continue: true, prompt: "old chat", fork: true }
  expect(invocation("/new project", args, { command: "/bin/kilo", args: [] })).toEqual([
    "/bin/kilo",
    "--model",
    "provider/model",
    "--agent",
    "ask",
    "--",
    "/new project",
  ])
})

test("preserve the source entry point and explicit permission mode", () => {
  expect(
    invocation(
      "/new",
      { yolo: true },
      {
        command: "/bin/bun",
        args: ["--conditions=node", "/repo/src/index.ts"],
      },
    ),
  ).toEqual(["/bin/bun", "--conditions=node", "/repo/src/index.ts", "--auto", "--", "/new"])
})
