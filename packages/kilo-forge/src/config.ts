import { readFile } from "node:fs/promises"
import path from "node:path"
import { parse, type ParseError } from "jsonc-parser"
import { Schema } from "effect"
import { decode } from "./schema"

const Limit = Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 100_000 }))
export const Config = Schema.Struct({
  files: Schema.optional(Limit),
  bytes: Schema.optional(Limit),
  budget: Schema.optional(Limit),
  candidates: Schema.optional(Limit),
  exclude: Schema.optional(Schema.Array(Schema.String)),
  selector: Schema.optional(Schema.Literals(["ranked", "greedy", "knapsack"])),
  history: Schema.optional(Schema.Boolean),
  routing: Schema.optional(Schema.Literals(["flat", "domains"])),
  documents: Schema.optional(Schema.Struct({ server: Schema.String })),
  database: Schema.optional(Schema.Struct({ server: Schema.String, resource: Schema.String })),
  knowledge: Schema.optional(Schema.Struct({
    collections: Schema.Array(Schema.Struct({
      id: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,80}$/)),
      path: Schema.String,
      include: Schema.optional(Schema.Array(Schema.String)),
      exclude: Schema.optional(Schema.Array(Schema.String)),
      watch: Schema.optional(Schema.Boolean),
      scope: Schema.optional(Schema.Literals(["workspace"])),
      sharing: Schema.optional(Schema.Literals(["ask"])),
    })),
  })),
})
export type Config = typeof Config.Type

export async function config(root: string) {
  const file = path.join(root, ".kilo", "forge.jsonc")
  const text = await readFile(file, "utf8").catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return "{}"
    throw err
  })
  const errors: ParseError[] = []
  const input: unknown = parse(text, errors, { allowTrailingComma: true })
  if (errors.length) throw new Error(`Invalid Forge configuration: ${file}`)
  const cfg = decode(Config, input)
  return {
    files: cfg.files ?? 5000,
    bytes: cfg.bytes ?? 100_000,
    budget: cfg.budget ?? 24_000,
    candidates: cfg.candidates ?? 100,
    exclude: cfg.exclude ?? [],
    selector: cfg.selector ?? "greedy",
    history: cfg.history ?? false,
    ...(cfg.routing ? { routing: cfg.routing } : {}),
    documents: cfg.documents,
    database: cfg.database,
    ...(cfg.knowledge ? { knowledge: cfg.knowledge } : {}),
  }
}
export type Settings = Awaited<ReturnType<typeof config>>
