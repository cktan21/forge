import { createContext, type ParentProps } from "solid-js"
import { PromptRefProvider } from "../../context/prompt"
import { useLocal } from "../../context/local"
import { DialogProvider } from "../../ui/dialog"

export const ForgeModel = createContext<() => string | undefined>()

export function ForgeComposerProvider(props: ParentProps) {
  const local = useLocal()
  const model = () => {
    const current = local.model.current()
    return current ? `${current.providerID}/${current.modelID}` : undefined
  }
  // Dialogs render in their provider's owner, so the composer ref must be above it.
  return <ForgeModel.Provider value={model}><PromptRefProvider><DialogProvider>{props.children}</DialogProvider></PromptRefProvider></ForgeModel.Provider>
}
