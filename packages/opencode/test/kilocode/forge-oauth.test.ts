import { expect, test } from "bun:test"
import { createOpenAI } from "@ai-sdk/openai"
import { jsonSchema, Output } from "ai"
import { limits } from "@kilocode/forge/investigation"
import { complete } from "@/kilocode/forge/completion"
import { oauth } from "./fixture/forge-oauth"

for (const mode of ["tool", "writer", "large", "reported", "failure"] as const) {
  test(`OAuth completion ${mode} uses the real adapter and bounded streaming SDK`, async () => {
    expect(limits.output).toBe(12000)
    const requests: Record<string, unknown>[] = []
    const focus = "reliability ".repeat(450)
    const value = mode === "writer"
      ? JSON.stringify({ prompt: "Add a regression test. ".repeat(250) })
      : JSON.stringify({ focus })
    const item = mode === "writer" || mode === "large"
      ? { type: "message", id: "message" }
      : { type: "function_call", id: "function", call_id: "call", name: "forge_finish", arguments: "", status: "completed" }
    const server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      async fetch(request) {
        const body: Record<string, unknown> = await request.json()
        requests.push(body)
        expect(request.headers.get("authorization")).toBe("Bearer fixture-access")
        expect(body).toMatchObject({ instructions: "Read-only investigation.", stream: true, store: false })
        expect(body).not.toHaveProperty("max_output_tokens")
        expect(body).not.toHaveProperty("temperature")
        if (mode !== "writer") expect(body).toMatchObject({ tools: [{ name: "forge_finish", strict: false }] })
        if (mode === "failure") return Response.json({ error: { message: "Rate limited" } }, { status: 429 })
        if (mode === "writer") expect(body).toMatchObject({ text: { format: { type: "json_schema" } } })
        const events = [
          { type: "response.created", response: { id: "response", created_at: 1, model: "gpt-5.4-mini" } },
          { type: "response.output_item.added", output_index: 0, item },
          item.type === "message"
            ? { type: "response.output_text.delta", item_id: item.id, delta: mode === "large" ? "x".repeat(limits.output + 1) : value }
            : { type: "response.function_call_arguments.delta", item_id: item.id, output_index: 0, delta: value },
          { type: "response.output_item.done", output_index: 0, item: { ...item, arguments: value } },
          { type: "response.completed", response: { usage: { input_tokens: 30, output_tokens: mode === "reported" ? limits.output + 1 : 6000 } } },
        ]
        return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
          headers: { "content-type": "text/event-stream" },
        })
      },
    })
    try {
      const adapter = await oauth(new URL("/responses", server.url).href)
      const provider = createOpenAI({ apiKey: "unused", fetch: adapter.fetch })
      const result = complete({
        model: provider.responses("gpt-5.4-mini"),
        system: "Read-only investigation.",
        prompt: "Ask which area to improve.",
        maxOutputTokens: limits.output,
        temperature: 0.1,
        ...(mode === "writer" ? {
          output: Output.object({ schema: jsonSchema<{ prompt: string }>({
            type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"], additionalProperties: false,
          }) }),
        } : {
          tools: { forge_finish: { inputSchema: jsonSchema<{ focus: string }>({
            type: "object", properties: { focus: { type: "string" } }, required: ["focus"], additionalProperties: false,
          }) } },
        }),
      }, { adapter: "openai-codex-v1" })
      if (mode === "large" || mode === "reported" || mode === "failure") {
        const error = await result.then(() => undefined, (err: unknown) => err)
        expect(error).toBeInstanceOf(Error)
        expect(error instanceof Error ? error.message : "").toContain(mode === "failure" ? "Rate limited" : "output limit")
        expect(requests).toHaveLength(1)
        return
      }
      const completed = await result
      expect(value.length).toBeGreaterThan(4000)
      expect(completed.totalUsage.outputTokens).toBe(6000)
      if (mode === "writer") expect(completed.text).toBe(value)
      if (mode === "tool") expect(completed.toolCalls).toMatchObject([{ toolName: "forge_finish", input: { focus } }])
      expect(requests).toHaveLength(1)
    } finally {
      await server.stop(true)
    }
  })
}
