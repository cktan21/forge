import type { DialogContext } from "../../ui/dialog"
import { ForgeDialog } from "./dialog"

export function forgePrompt(text: string, dialog: DialogContext, skip = false) {
  if (skip) return false
  const match = text.match(/^\/(overview|ideas|enhance|map)(?:\s+([\s\S]*))?$/)
  const command = match?.at(1)
  if (command !== "overview" && command !== "ideas" && command !== "enhance" && command !== "map") return false
  dialog.replace(() => <ForgeDialog command={command} text={text} />)
  return true
}
