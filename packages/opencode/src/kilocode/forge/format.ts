export function format(model: {
  id: string
  providerID: string
  api: { npm: string }
  autoRouting?: { models: readonly string[] }
}) {
  // A gateway alias can route to a different model on each call. Its downstream
  // structured-output support is not guaranteed by a prior successful request.
  const gateway = model.providerID === "kilo" || model.api.npm === "@kilocode/kilo-gateway"
  return gateway && (model.id.startsWith("kilo-auto/") || model.autoRouting != null) ? "prompt" : "schema"
}
