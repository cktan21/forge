import { createSimpleContext } from "./helper"
import type { PromptRef } from "../component/prompt"

export const { use: usePromptRef, provider: PromptRefProvider, context: PromptRefContext } = createSimpleContext({ // kilocode_change - allow read-only Forge dialogs outside the composer
  name: "PromptRef",
  init: () => {
    let current: PromptRef | undefined

    return {
      get current() {
        return current
      },
      set(ref: PromptRef | undefined) {
        current = ref
      },
    }
  },
})
