import { useRenderer } from "@opentui/solid"
import { useBindings } from "../../keymap"

export function navigation(back: () => void, enabled = () => true) {
  const renderer = useRenderer()
  const run = () => {
    renderer.clearSelection()
    back()
  }
  useBindings(() => ({
    enabled: enabled(),
    priority: 3,
    bindings: [{ key: "escape", desc: "Back one level", group: "Forge", cmd: run }],
  }))
  useBindings(() => ({
    // Text fields retain Backspace for deletion, including empty confirmation inputs.
    enabled: () => enabled() && !renderer.currentFocusedEditor,
    priority: 3,
    bindings: [{ key: "backspace", desc: "Back one level", group: "Forge", cmd: run }],
  }))
}
