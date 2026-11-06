import { defineConfig } from "@playwright/test"

export default defineConfig({
  testDir: "e2e",
  testMatch: "**/*.pw.ts",
  timeout: 60_000,
  use: { headless: true, viewport: { width: 1512, height: 1100 }, launchOptions: process.env.FORGE_CHROME ? { executablePath: process.env.FORGE_CHROME } : {} },
  reporter: "list",
})
