import type { InternalTuiPlugin } from "@/plugin/tui/internal"
import { ForgeDialog, type Command } from "@tui/kilocode/forge/dialog"

const plugin: InternalTuiPlugin = {
  id: "internal:forge",
  tui: async (api) => {
    const commands: Command[] = ["overview", "ideas", "enhance", "map"]
    api.keymap.registerLayer({ commands: commands.map((command) => ({ namespace: "palette", name: `forge.${command}`, title: `Forge ${command}`, slashName: command, category: "Forge", run() { api.ui.dialog.replace(() => <ForgeDialog command={command} />) } })), bindings: [] })
  },
}
export default plugin
