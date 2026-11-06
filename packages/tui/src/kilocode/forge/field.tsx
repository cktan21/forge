import { createSignal, onCleanup, onMount } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import type { TextareaRenderable } from "@opentui/core"
import { useTuiConfig } from "../../config"
import { useTheme } from "../../context/theme"
import { useBindings } from "../../keymap"
import { useDialog } from "../../ui/dialog"

export function ForgeField(props: {
  title: string
  value: string
  change: (value: string) => void
  submit: (value: string) => void
  back: () => void
}) {
  const { theme } = useTheme()
  const config = useTuiConfig()
  const dialog = useDialog()
  const dimensions = useTerminalDimensions()
  const [target, setTarget] = createSignal<TextareaRenderable>()
  let editor: TextareaRenderable | undefined
  onMount(() => {
    const timer = setTimeout(() => { if (editor && !editor.isDestroyed) { editor.focus(); editor.gotoBufferEnd() } }, 0)
    onCleanup(() => clearTimeout(timer))
  })
  useBindings(() => ({
    target,
    enabled: target() != null,
    priority: 4,
    bindings: [
      { key: "return", desc: "Submit enhancement input", group: "Forge Enhance", cmd: () => { if (editor) props.submit(editor.plainText) } },
      { key: "shift+return", desc: "Insert newline", group: "Forge Enhance", cmd: () => editor?.insertText("\n") },
      { key: "escape", desc: "Return without submitting", group: "Forge Enhance", cmd: props.back },
      { key: "ctrl+c", desc: "Close enhancement without sending", group: "Forge Enhance", cmd: () => dialog.clear() },
    ],
  }))
  return <box gap={1}>
    <text fg={theme.primary}>{props.title}</text>
    <textarea height={Math.max(3, Math.min(8, dimensions().height - 18))} initialValue={props.value}
      ref={(value: TextareaRenderable) => { editor = value; setTarget(value) }}
      onContentChange={() => { if (editor) props.change(editor.plainText) }}
      placeholder="Enter text" placeholderColor={theme.textMuted}
      textColor={theme.text} focusedTextColor={theme.text} cursorColor={theme.primary} cursorStyle={config.cursor} />
    <text fg={theme.textMuted}>Enter Continue · Shift+Enter New line · Esc Back</text>
  </box>
}
