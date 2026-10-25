import { createContext, useContext, type ParentProps } from "solid-js"

const context = createContext<((directory: string) => void) | undefined>()

export function DirectoryProvider(props: ParentProps<{ change?: (directory: string) => void }>) {
  return <context.Provider value={props.change}>{props.children}</context.Provider>
}

export function useDirectoryChange() {
  return useContext(context)
}
