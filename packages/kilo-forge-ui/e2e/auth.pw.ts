import { expect, test } from "@playwright/test"

for (const body of ["", "Unauthorized"]) {
  test(`hard reload explains reauthentication for ${body ? "text" : "empty"} 401 responses`, async ({ page }) => {
    const base = process.env.FORGE_TEST_URL ?? "http://127.0.0.1:4096"
    const authorization = "Basic Zml4dHVyZTp0ZXN0"
    const headers: (string | undefined)[] = []
    const cookies: (string | undefined)[] = []
    await page.context().addCookies([{ name: "ambient", value: "not-a-handoff", url: base }])
    await page.route("**/event?**", async (route) => {
      cookies.push((await route.request().allHeaders()).cookie)
      return route.fulfill({ status: 200, contentType: "text/event-stream", body: "" })
    })
    await page.route(/\/forge\/(status|view|requests|policy|knowledge)(?:\?|$)/, async (route) => {
      const request = await route.request().allHeaders()
      cookies.push(request.cookie)
      headers.push(request.authorization)
      if (request.authorization !== authorization) return route.fulfill({
        status: 401, contentType: "text/plain", body, headers: { "www-authenticate": 'Basic realm="Secure Area"' },
      })
      const endpoint = new URL(route.request().url()).pathname.split("/").at(-1)
      return route.fulfill({
        json: endpoint === "status"
          ? { inventory: { root: "/fixture", generation: "fixture", counts: {}, files: 0, warnings: [], indexed: false }, session: "", job: { state: "idle", message: "Ready" }, semantic: { state: "disabled", searchable: false } }
          : endpoint === "view"
            ? { root: "/fixture", generation: "fixture", sources: [], relations: [], page: { offset: 0, limit: 100 }, warnings: [] }
            : endpoint === "requests" ? []
              : endpoint === "policy" ? { version: "fixture", session: "", pin: [], exclude: [] }
                : { collections: [], provider: "", generation: "fixture", page: { offset: 0, limit: 10 } },
      })
    })
    const url = `${base}/forge/?directory=/fixture#${new URLSearchParams({ authorization })}`
    await page.goto(url)
    await expect(page.getByText("Semantic index: disabled;", { exact: false })).toBeVisible()
    expect(new URL(page.url()).hash).toBe("")
    expect(headers.every((header) => header === authorization)).toBe(true)
    headers.length = 0
    await page.reload()
    await expect(page.getByRole("alert").first()).toHaveText("Open /map in the terminal and press Ctrl+B to authenticate this browser session.")
    await expect(page.getByText("Semantic index: disabled;", { exact: false })).toHaveCount(0)
    expect(headers.length).toBeGreaterThan(0)
    expect(headers.every((header) => header === undefined)).toBe(true)
    expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0])
    await page.getByRole("button", { name: "Reload view", exact: true }).click()
    await expect(page.getByRole("alert").first()).toHaveText("Open /map in the terminal and press Ctrl+B to authenticate this browser session.")
    await page.goto(url)
    await expect(page.getByText("Semantic index: disabled;", { exact: false })).toBeVisible()
    await expect(page.getByRole("alert")).toHaveCount(0)
    expect(new URL(page.url()).hash).toBe("")
    expect(cookies.length).toBeGreaterThan(0)
    expect(cookies.every((cookie) => cookie === undefined)).toBe(true)
  })
}
