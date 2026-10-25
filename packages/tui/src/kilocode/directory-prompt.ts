import { createSignal } from "solid-js"
import { useExit } from "../context/exit"
import { useProject } from "../context/project"
import { useSDK } from "../context/sdk"
import { useSync } from "../context/sync"
import { useTuiPaths } from "../context/runtime"
import { useToast } from "../ui/toast"
import { isCd, resolve } from "./directory"
import { useDirectoryChange } from "./directory-context"

export function useDirectoryPrompt(session: () => string | undefined) {
  const change = useDirectoryChange()
  const project = useProject()
  const sdk = useSDK()
  const sync = useSync()
  const paths = useTuiPaths()
  const toast = useToast()
  const exit = useExit()
  const [busy, setBusy] = createSignal(false)
  return {
    async submit(text: string) {
      if (!isCd(text)) return false
      if (busy()) return true
      if (!change || project.workspace.current()) {
        toast.show({
          variant: "error",
          message: "/cd is available in local projects. Exit the remote workspace before switching.",
        })
        return true
      }
      setBusy(true)
      try {
        const id = session()
        const cwd =
          (id && sync.session.get(id)?.directory) || project.instance.directory() || sdk.directory || paths.cwd
        const dir = await resolve(text.slice(3), cwd, paths.home)
        // Stop only this chat before replacing the local client. Keep its saved history.
        if (id) await sdk.client.session.abort({ sessionID: id, directory: cwd }, { throwOnError: true })
        change(dir)
        exit()
      } catch (err) {
        toast.show({
          variant: "error",
          title: "Could not change directory",
          message: err instanceof Error ? err.message : String(err),
        })
        setBusy(false)
      }
      return true
    },
  }
}
