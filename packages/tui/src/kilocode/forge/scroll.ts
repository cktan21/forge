import type { ScrollBoxRenderable } from "@opentui/core"
import { useBindings } from "../../keymap"

export function scrolling(read: () => ScrollBoxRenderable | undefined, enabled = () => true, arrows = () => true) {
  // Raw keyboard listeners run too late to override conversation paging.
  useBindings(() => ({
    enabled: enabled(),
    priority: 1,
    bindings: [
      ...(arrows()
        ? [
            { key: "down", desc: "Scroll knowledge down", group: "Forge", cmd: () => read()?.scrollBy(1) },
            { key: "up", desc: "Scroll knowledge up", group: "Forge", cmd: () => read()?.scrollBy(-1) },
          ]
        : []),
      { key: "pagedown", desc: "Page knowledge down", group: "Forge", cmd: () => read()?.scrollBy(16) },
      { key: "pageup", desc: "Page knowledge up", group: "Forge", cmd: () => read()?.scrollBy(-16) },
    ],
  }))
}
