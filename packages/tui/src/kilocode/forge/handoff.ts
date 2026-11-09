import type { KiloClient } from "@kilocode/sdk/v2"
import type { PromptInfo } from "../../prompt/history"
import type { EnhancementModel } from "@kilocode/forge/schema"
import type { PreparationBinding } from "@kilocode/forge/writing"
import { metadata, reference, tagged } from "@kilocode/forge/handoff"
import { deadline } from "@kilocode/forge/deadline"

export { tagged, metadata }

export function attach(draft: PromptInfo, value: PreparationBinding): PromptInfo {
  return {
    ...draft,
    parts: [...draft.parts.filter((part) => !tagged(part)), { type: "text", text: "", synthetic: true, metadata: metadata(value) }],
  }
}

export async function submit(input: {
  client: KiloClient
  draft: PromptInfo
  text: string
  scope: { directory?: string; workspace?: string; session: string }
  model: EnhancementModel
  mode: "normal" | "shell"
  valid: () => boolean
}) {
  const binding = reference(input.draft.parts)
  if (!binding) return undefined
  if (input.mode !== "normal" || input.text.startsWith("/")) throw new Error("A prepared prompt must be sent as a normal coding request, not a shell or slash command")
  return deadline(async (signal) => {
    const options = { throwOnError: true as const, signal }
    const scope = { ...input.scope, session: binding.session ?? input.scope.session }
    const result = (await input.client.forge.preparedPrompt({ ...scope, id: binding.id }, options)).data
    if (!input.valid()) throw new Error("The composer changed during preparation validation; your current draft was preserved")
    if (result.state !== "ready" || result.revision !== binding.revision || result.hash !== binding.hash) throw new Error("Prepared prompt is no longer current. Reopen the workshop to review it.")
    const edited = result.prompt === input.text ? result
      : (await input.client.forge.editPrompt({ ...scope, id: result.id, revision: result.revision, text: input.text }, options)).data
    if (!input.valid()) throw new Error("The composer changed during preparation validation; your current draft was preserved")
    const bound = (await input.client.forge.bindPrompt({
      ...input.scope, model: input.model, text: input.text,
      binding: { id: edited.id, revision: edited.revision, hash: edited.hash, session: edited.session },
    }, options)).data
    if (!input.valid()) throw new Error("The composer changed before submission; your current draft was preserved")
    return { id: bound.id, revision: bound.revision, hash: bound.hash, session: bound.session }
  }, undefined, 30_000, new Error("Prepared prompt validation timed out. The prompt was not submitted."))
}
