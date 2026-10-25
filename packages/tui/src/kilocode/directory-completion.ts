import { createResource } from "solid-js"
import type { TextareaRenderable } from "@opentui/core"
import type { AutocompleteOption } from "../component/prompt/autocomplete"
import type { PromptInfo } from "../prompt/history"
import { useDirectoryChange } from "./directory-context"
import { complete, isCd } from "./directory"

export function useDirectoryCompletion(props: {
  value: () => string
  cwd: () => string
  home: string
  disabled: () => boolean
  input: () => TextareaRenderable
  setPrompt: (update: (prompt: PromptInfo) => void) => void
}) {
  const change = useDirectoryChange()
  const enabled = () => !!change && !props.disabled()
  const active = () => enabled() && isCd(props.value()) && /^\/cd[ \t]/.test(props.value())
  const insert = (text: string) => {
    const input = props.input()
    input.setText(text)
    input.cursorOffset = Bun.stringWidth(text)
    props.setPrompt((draft) => {
      draft.input = text
      draft.parts = []
    })
  }
  const [items] = createResource(
    () => (active() ? { text: props.value().slice(3), cwd: props.cwd() } : undefined),
    async (query) => complete(query.text, query.cwd, props.home).catch(() => []),
  )
  return {
    active,
    commands: (): AutocompleteOption[] =>
      enabled()
        ? [
            {
              display: "/cd",
              description: "Change project and start a fresh chat",
              onSelect: () => insert("/cd "),
            },
          ]
        : [],
    options: (): AutocompleteOption[] =>
      (items() ?? []).map((item) => ({
        display: item.name,
        value: item.value,
        description: item.description,
        isDirectory: true,
        onSelect: () => insert("/cd " + item.value),
      })),
  }
}
