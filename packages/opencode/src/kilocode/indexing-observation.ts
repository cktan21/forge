type Observation = { initialized: boolean; state: string } | undefined

let inspect: ((directory: string) => Observation) | undefined

// Observe the owner's live cache without importing or initializing indexing.
export function register(read: (directory: string) => Observation) {
  inspect = read
}

export function peek(directory: string): Observation {
  return inspect?.(directory)
}
