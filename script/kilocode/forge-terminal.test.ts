import { expect, test } from "bun:test"
import { screen } from "./forge-terminal"

test("terminal observer applies incremental cursor overwrites", async () => {
  using terminal = screen(
    () => {},
    () => {},
  )
  await terminal.write("Collection embedding: Launch manuals")
  await terminal.write("\x1b[1;21H")
  await terminal.write("s: Launch manuals")
  expect(terminal.text().trim()).toBe("Collection embeddings: Launch manuals")
})

test("terminal observer parses split escape sequences", async () => {
  using terminal = screen(
    () => {},
    () => {},
  )
  await terminal.write("old\x1b[")
  await terminal.write("1;1Hnew")
  expect(terminal.text().trim()).toBe("new")
})

test("terminal observer does not retain erased content", async () => {
  using terminal = screen(
    () => {},
    () => {},
  )
  await terminal.write("old result\r\nstale warning")
  await terminal.write("\x1b[2J\x1b[Hloading")
  expect(terminal.text().trim()).toBe("loading")
  await terminal.write("\rready\x1b[K")
  expect(terminal.text().trim()).toBe("ready")
})

test("terminal observer restores the normal buffer after alternate screen exit", async () => {
  using terminal = screen(
    () => {},
    () => {},
  )
  await terminal.write("shell\x1b[?1049h\x1b[Hdialog")
  expect(terminal.text().trim()).toBe("dialog")
  await terminal.write("\x1b[?1049l")
  expect(terminal.text().trim()).toBe("shell")
})

test("terminal observer orders writes and resizes", async () => {
  using terminal = screen(
    () => {},
    () => {},
  )
  const writes = [
    terminal.resize(10, 4),
    terminal.write("abcdefghij"),
    terminal.resize(12, 4),
    terminal.write("\x1b[1;12HZ\x1b[2;1Hnew row"),
  ]
  await Promise.all(writes)
  expect(terminal.text().split("\n").slice(0, 2)).toEqual(["abcdefghij Z", "new row"])
  expect(terminal.text().split("\n")).toHaveLength(4)
})

test("terminal observer responds with the actual cursor position", async () => {
  const replies: string[] = []
  using terminal = screen(
    (data) => replies.push(data),
    () => {},
  )
  await terminal.write("\x1b[4;7H\x1b[6n")
  expect(replies).toEqual(["\x1b[4;7R"])
})
