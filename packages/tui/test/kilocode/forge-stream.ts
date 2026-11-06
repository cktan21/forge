export async function stream(response: Response) {
  if (!response.ok || response.headers.get("content-type")?.includes("text/event-stream")) return response
  return new Response(`data: ${JSON.stringify({ type: "result", proposal: await response.json() })}\n\n`, {
    headers: { "content-type": "text/event-stream" },
  })
}
