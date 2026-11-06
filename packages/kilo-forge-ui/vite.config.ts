import { defineConfig } from "vite"
import solid from "vite-plugin-solid"

export default defineConfig({
  plugins: [solid()],
  base: "/forge/",
  define: { __FORGE_BUILD__: JSON.stringify(new Date().toISOString()) },
  build: { target: "es2022" },
  server: { proxy: { "^/event(?:\\?|$)": "http://127.0.0.1:4096", "^/forge/(?:status|view|index|knowledge|policy|graph|source|requests|enhance|validate|overview|ideas|opportunit|search)": "http://127.0.0.1:4096" } },
})
