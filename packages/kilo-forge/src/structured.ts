function record(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value)
}

// Effect emits scalar refinements inside allOf. Strict response schemas reject
// allOf, but the same disjoint constraints can be attached directly to the node.
export function structured(input: Record<string, unknown>): Record<string, unknown> {
  const result = { ...input }
  if (input.allOf != null) {
    if (!Array.isArray(input.allOf)) throw new Error("Invalid enhancement schema intersection")
    for (const part of input.allOf) {
      if (!record(part)) throw new Error("Unsupported enhancement schema intersection")
      for (const [key, value] of Object.entries(part)) {
        const valid = key === "pattern" ? typeof value === "string"
          : ["minLength", "maxLength", "minItems", "maxItems"].includes(key)
            && typeof value === "number" && Number.isSafeInteger(value) && value >= 0
        if (!valid || Object.hasOwn(result, key) && result[key] !== value) {
          throw new Error("Enhancement schema intersection cannot be flattened without changing its constraints")
        }
        result[key] = value
      }
    }
    delete result.allOf
  }
  for (const key of ["properties", "$defs", "definitions"]) {
    const value = result[key]
    if (record(value)) {
      result[key] = Object.fromEntries(Object.entries(value).map(([name, item]) =>
        [name, record(item) ? structured(item) : item]))
    }
  }
  for (const key of ["items", "additionalProperties"]) {
    const value = result[key]
    if (record(value)) result[key] = structured(value)
  }
  for (const key of ["anyOf", "oneOf", "prefixItems"]) {
    const value = result[key]
    if (Array.isArray(value)) result[key] = value.map((item) => record(item) ? structured(item) : item)
  }
  return result
}
