export function response(text: string, reason = "stop") {
  const frames = [
    { object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "PRIVATE_REASONING_CANARY" }, finish_reason: null }] },
    { object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: text }, finish_reason: null }] },
    { object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: reason }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, prompt_tokens_details: { cached_tokens: 0 } } },
  ]
  return new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n", {
    headers: { "content-type": "text/event-stream" },
  })
}
