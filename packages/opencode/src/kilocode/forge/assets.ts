import path from "node:path"
import { access } from "node:fs/promises"

export function publicAsset(method: string, pathname: string) {
  return method === "GET" && (pathname === "/forge" || pathname === "/forge/" || /^\/forge\/assets\/[A-Za-z0-9_.-]+\.(?:js|css|svg|png|woff2)$/.test(pathname))
}

export async function resolve(pathname: string): Promise<{ file: string } | { missing: true } | undefined> {
  if (!publicAsset("GET", pathname)) return undefined
  const relative = pathname === "/forge" || pathname === "/forge/" ? "index.html" : pathname.slice("/forge/".length)
  const roots = [path.join(path.dirname(process.execPath), "forge"), path.resolve(import.meta.dirname, "../../../../kilo-forge-ui/dist")]
  for (const root of roots) {
    const file = path.resolve(root, relative)
    if (!file.startsWith(`${root}${path.sep}`)) continue
    if (await access(file).then(() => true, () => false)) return { file }
  }
  return { missing: true }
}
