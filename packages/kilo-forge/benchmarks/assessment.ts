import { Schema } from "effect"
import { arms as variants, type Arm } from "./harness"

type Identity = { task: string; trial: number; arm: Arm }

const Artifact = Schema.Struct({ path: Schema.String, sha256: Schema.String })
const Assessment = Schema.Struct({
  version: Schema.Literal(1),
  protocol: Artifact,
  method: Schema.Literal("manual-archived-evidence"),
  rows: Schema.Array(
    Schema.Struct({
      task: Schema.String,
      trial: Schema.Finite,
      arm: Schema.Literals(variants),
      reviewer: Schema.String,
      evidence: Schema.Array(Artifact),
      retrieval: Schema.optional(
        Schema.Struct({ expected: Schema.Array(Schema.String), retrieved: Schema.Array(Schema.String) }),
      ),
      intent: Schema.optional(
        Schema.Struct({
          constraints: Schema.Array(
            Schema.Struct({ id: Schema.String, text: Schema.String, preserved: Schema.Boolean }),
          ),
        }),
      ),
    }),
  ),
})

function text(value: string) {
  if (!value.trim() || value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value))
    throw new Error("Expected nonempty trimmed text without control characters")
}

function identifier(value: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) throw new Error("Invalid assessment task or constraint ID")
}

function path(value: string) {
  text(value)
  if (/[:\\]/.test(value) || value.split("/").some((part) => !part || part === "." || part === ".."))
    throw new Error("Expected a normalized relative file path")
}

function unique(values: readonly string[]) {
  if (new Set(values).size !== values.length) throw new Error("Duplicate assessment label or evidence path")
}

function artifact(value: typeof Artifact.Type) {
  path(value.path)
  if (!/^[a-f0-9]{64}$/.test(value.sha256)) throw new Error("Expected lowercase SHA-256 artifact digest")
}

export function key(row: Identity) {
  identifier(row.task)
  if (!Number.isSafeInteger(row.trial) || row.trial < 1) throw new Error("Invalid assessment trial ID")
  if (!variants.includes(row.arm)) throw new Error("Invalid assessment arm ID")
  return JSON.stringify([row.task, row.trial, row.arm])
}

export function assess(
  value: unknown,
  observed: readonly Identity[],
  comparable: readonly Identity[],
  arms: readonly Arm[],
) {
  const available = new Set(observed.map(key))
  if (available.size !== observed.length) throw new Error("Duplicate report identity")
  const document =
    value === undefined ? null : Schema.decodeUnknownSync(Assessment, { onExcessProperty: "error" })(value)
  const labels = new Map<string, (typeof Assessment.Type.rows)[number]>()
  const expected = new Map<string, string>()
  const constraints = new Map<string, string>()
  if (document) artifact(document.protocol)
  for (const row of document?.rows ?? []) {
    const id = key(row)
    if (!available.has(id)) throw new Error("Assessment does not match a recorded task/trial/arm")
    if (labels.has(id)) throw new Error("Duplicate assessment task/trial/arm")
    text(row.reviewer)
    if (!row.evidence.length) throw new Error("Assessment requires archived evidence")
    row.evidence.forEach(artifact)
    unique(row.evidence.map((item) => item.path))
    if (!row.retrieval && !row.intent) throw new Error("Assessment requires retrieval or intent labels")
    if (row.retrieval) {
      if (!row.retrieval.expected.length) throw new Error("Retrieval requires nonempty expected relevant paths")
      for (const paths of [row.retrieval.expected, row.retrieval.retrieved]) {
        paths.forEach(path)
        unique(paths)
      }
      const signature = JSON.stringify([...row.retrieval.expected].sort())
      if (expected.has(row.task) && expected.get(row.task) !== signature)
        throw new Error("Expected retrieval labels differ across task assessments")
      expected.set(row.task, signature)
    }
    if (row.intent) {
      if (!row.intent.constraints.length) throw new Error("Intent requires nonempty explicit constraints")
      for (const item of row.intent.constraints) {
        identifier(item.id)
        text(item.text)
      }
      unique(row.intent.constraints.map((item) => item.id))
      unique(row.intent.constraints.map((item) => item.text))
      const signature = JSON.stringify(
        row.intent.constraints.map((item) => [item.id, item.text]).sort((a, b) => a[0]!.localeCompare(b[0]!)),
      )
      if (constraints.has(row.task) && constraints.get(row.task) !== signature)
        throw new Error("Intent rubric differs across task assessments")
      constraints.set(row.task, signature)
    }
    labels.set(id, row)
  }
  const groups = new Map<string, Identity[]>()
  for (const row of comparable) {
    const id = JSON.stringify([row.task, row.trial])
    const group = groups.get(id) ?? []
    group.push(row)
    groups.set(id, group)
  }
  const matched = (metric: "retrieval" | "intent") =>
    [...groups.values()]
      .filter(
        (group) =>
          group.length === arms.length &&
          arms.every((arm) => group.some((row) => row.arm === arm && labels.get(key(row))?.[metric] != null)),
      )
      .flat()
  const retrieval = matched("retrieval")
  const intent = matched("intent")
  return {
    document,
    arms: arms.map((arm) => {
      const selected = comparable.filter((row) => row.arm === arm)
      const reviewed = (metric: "retrieval" | "intent") =>
        selected.filter((row) => labels.get(key(row))?.[metric] != null).length
      const paths = retrieval.filter((row) => row.arm === arm).map((row) => labels.get(key(row))!.retrieval!)
      const rules = intent.filter((row) => row.arm === arm).map((row) => labels.get(key(row))!.intent!.constraints)
      const hits = paths.reduce(
        (sum, row) => sum + row.retrieved.filter((file) => row.expected.includes(file)).length,
        0,
      )
      const predicted = paths.reduce((sum, row) => sum + row.retrieved.length, 0)
      const relevant = paths.reduce((sum, row) => sum + row.expected.length, 0)
      const total = rules.reduce((sum, row) => sum + row.length, 0)
      const passed = rules.reduce((sum, row) => sum + row.filter((item) => item.preserved).length, 0)
      return {
        arm,
        eligible: selected.length,
        retrieval: {
          reviewed: reviewed("retrieval"),
          matched: paths.length,
          hits,
          retrieved: predicted,
          expected: relevant,
          precision: predicted ? hits / predicted : null,
          recall: relevant ? hits / relevant : null,
        },
        intent: {
          reviewed: reviewed("intent"),
          matched: rules.length,
          passed,
          total,
          preservation: total ? passed / total : null,
          preserved: rules.length ? rules.filter((row) => row.every((item) => item.preserved)).length : null,
        },
      }
    }),
  }
}
