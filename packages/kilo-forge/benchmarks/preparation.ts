import { tasks as originals, type Task } from "./tasks"

const definitions = [
  {
    prompt:
      "Implement atomic batch enqueue support for the Dispatch queue according to the repository API contract. Keep legacy behavior, add regression tests, and update the docs.",
    document: "docs/api.md",
    relevant: ["docs/api.md", "src/queue.ts", "src/index.ts", "tests/queue.test.ts"],
  },
  {
    prompt:
      "Implement the documented actor filtering and pagination contract for Dispatch history. Keep backward compatibility, add regression tests, and update the docs.",
    document: "docs/api.md",
    relevant: ["docs/api.md", "src/history.ts", "src/index.ts", "tests/queue.test.ts"],
  },
  {
    prompt:
      "Fix warehouse reserve stock validation to match the documented stock-count contract. Preserve the public API, add regression tests, and update the docs.",
    document: "docs/stock.md",
    relevant: ["docs/stock.md", "warehouse/stock.py", "warehouse/__init__.py", "tests/test_stock.py"],
  },
  {
    prompt:
      "Implement the documented active reservation uniqueness contract in the fresh-install warehouse schema. Add regression tests and update the docs. Do not implement an existing-database migration.",
    document: "docs/schema.md",
    relevant: ["docs/schema.md", "schema.sql", "tests/test_stock.py"],
  },
] as const

// Every arm can read the same normative documentation. Checks and reference
// solutions remain private; source-grounded preparation is the only treatment.
export const tasks: Task[] = originals.map((task, index) => {
  const spec = definitions.at(index)!
  return {
    ...task,
    id: `documented-${task.id}`,
    prompt: spec.prompt,
    files: {
      ...task.files,
      [spec.document]: `${task.files[spec.document]}\n\n## Required Contract\n\n${task.prompt}\n`,
      "README.md": `${task.files["README.md"]}\n\nCurrent behavior may not implement all contracts. The normative requirements live in ${spec.document}.\n`,
    },
    relevant: [...spec.relevant],
    constraints: [spec.prompt],
  }
})

if (import.meta.main) {
  if (!(process.env.FORGE_EVAL_MODEL ?? "").startsWith("openai/gpt-5."))
    throw new Error("This study requires an explicitly selected OpenAI GPT-5.x model")
  const { run } = await import("./free")
  await run({ subscription: true, preparation: true, tasks })
}
