import { expect, test } from "bun:test"
import { grade, materialize } from "../grading"
import { tasks } from "../tasks"
import { evaluate, settings } from "../evaluate"
import { baseline, covered, describe, failure, order, recover, timed } from "../harness"
import { summarize } from "../report"
import { type Manifest, usage } from "../../src/schema"
import { prepare } from "../../src/preparation"
import { rm } from "node:fs/promises"
import path from "node:path"
import { rejects } from "node:assert/strict"

function captured(item: Manifest): Manifest {
  return {
    ...item,
    discarded: 0,
    attempts: [
      {
        id: `${item.id}-http`,
        sequence: 1,
        started: item.observed,
        state: "response",
        status: 200,
        sent: [],
        membership: "unknown",
        response: {
          state: "completed",
          bytes: 120,
          usage: {
            format: "openai-chat",
            input: item.usage.input,
            output: item.usage.output,
            cached: item.usage.cached,
          },
        },
      },
    ],
  }
}

for (const task of tasks) {
  test(`independent evaluator detects unfixed ${task.id} and accepts the reference solution`, async () => {
    const baseline = await grade(task, task.files)
    expect(baseline.regression).toBe(true)
    expect(baseline.success).toBe(false)
    expect(baseline.passed).toBeLessThan(baseline.total)
    const solved = await grade(task, { ...task.files, ...task.solution })
    expect(solved.success).toBe(true)
    expect(solved.passed).toBe(task.checks.length)
    expect(solved.hidden.code).toBe(0)
  })
}

test("three-arm order balances positions, predecessors and repeated tasks", () => {
  const permutations = Array.from({ length: 6 }, (_, index) => order(index))
  expect(new Set(permutations.map((value) => value.join(","))).size).toBe(6)
  for (const arm of ["normal", "generic", "forge"]) {
    for (let position = 0; position < 3; position++) {
      expect(permutations.filter((value) => value.at(position) === arm)).toHaveLength(2)
      expect([1, 2, 3].filter((trial) => order(0, trial).at(position) === arm)).toHaveLength(1)
    }
  }
})

test("failed phases record elapsed time and classify provider failures separately from workflow", async () => {
  const durations: number[] = []
  await rejects(
    timed(
      async () => {
        throw new Error("malformed inspect")
      },
      (value) => durations.push(value),
    ),
    /malformed inspect/,
  )
  expect(durations.at(0)).toBeGreaterThan(0)
  expect(failure("HTTP 500: ForgeError invalid inspect")).toBe("workflow")
  expect(failure(describe({ message: "PROMOTION_MODEL_LIMIT_REACHED" }))).toBe("quota")
  expect(failure("HTTP 401 Unauthorized")).toBe("auth")
  expect(failure("HTTP 503 Service Unavailable")).toBe("infrastructure")
  expect(failure("HTTP 500: ForgeError ECONNREFUSED")).toBe("infrastructure")
  expect(failure("TimeoutError: operation timed out")).toBe("infrastructure")
  expect(failure("AbortError")).toBe("interrupted")
})

test("request recovery is scoped, deduplicated and never claims missing usage is zero", () => {
  const item: Manifest = captured({
    id: "request",
    root: "/fixture",
    session: "session",
    purpose: "enhance",
    observed: 10,
    generation: "fixture",
    entries: [],
    coverage: [],
    model: "fixture",
    state: "completed",
    usage: { ...usage("fixture"), input: 100, output: 20, measured: true },
  })
  const result = recover(
    [
      item,
      item,
      { ...item, id: "old", observed: 9 },
      { ...item, id: "other", root: "/other" },
      { ...item, id: "coding", purpose: "coding" },
      { ...item, id: "session", session: "other" },
    ],
    "/fixture",
    "session",
    10,
  )
  expect(result.usage.input).toBe(100)
  expect(result.complete).toBe(true)
  expect(recover([], "/fixture", "session", 10).complete).toBe(false)
  expect(
    recover([item, { ...item, id: "missing", attempts: undefined, usage: usage() }], "/fixture", "session", 10)
      .complete,
  ).toBe(false)
  const incomplete = recover(
    [item, { ...item, id: "normalized", attempts: undefined, usage: { ...usage(), measured: true } }],
    "/fixture",
    "session",
    10,
  )
  expect(incomplete.complete).toBe(false)
  expect(incomplete.usage.input).toBe(100)
  expect(recover([{ ...item, session: "" }], "/fixture", "session", 10).complete).toBe(true)
  expect(recover([{ ...item, attempts: undefined }], "/fixture", "session", 10).complete).toBe(false)
})

test("direct generic HTTP is authenticated, bounded and schema validated", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      expect(url.pathname).toBe("/forge/baseline")
      expect(url.searchParams.get("directory")).toBe("/fixture with spaces")
      expect(request.headers.get("authorization")).toBe("Basic fixture")
      const body: { text: string } = await request.json()
      if (body.text === "quota") return new Response("quota", { status: 429 })
      if (body.text === "large") return new Response("a".repeat(1_000_001))
      if (body.text === "invalid") return Response.json({ text: {} })
      if (body.text === "redirect") return Response.redirect(new URL("/elsewhere", request.url))
      return Response.json({ text: "Rewritten", usage: { ...usage("fixture"), measured: true } })
    },
  })
  try {
    const call = (text: string, signal = AbortSignal.timeout(1000)) =>
      baseline(server.url.toString(), "Basic fixture", "/fixture with spaces", text, signal)
    expect((await call("original")).text).toBe("Rewritten")
    await rejects(call("quota"), /HTTP 429/)
    await rejects(call("large"), /size limit/)
    await rejects(call("invalid"))
    await rejects(call("redirect"))
    await rejects(call("original", AbortSignal.abort()))
  } finally {
    await server.stop(true)
  }
})

test("request coverage requires a fresh empty start and a coherent complete retained list", () => {
  const initial = { revision: "0".repeat(32), since: 1, before: "unknown" as const, deleted: false, admitted: 0 }
  const final = { ...initial, revision: "1".repeat(32), admitted: 1 }
  const record: Manifest = {
    id: "request",
    root: "/fixture",
    session: "",
    purpose: "coding",
    observed: 1,
    generation: "",
    entries: [],
    coverage: [],
    model: "",
    state: "completed",
    usage: usage(),
  }
  expect(covered(initial, final, final, [record], "/fixture")).toBe(true)
  expect(covered(null, final, final, [record], "/fixture")).toBe(false)
  expect(covered({ ...initial, admitted: 1 }, final, final, [record], "/fixture")).toBe(false)
  expect(covered(initial, final, { ...final, revision: "2".repeat(32) }, [record], "/fixture")).toBe(false)
  expect(covered(initial, final, { ...final, admitted: 2 }, [record], "/fixture")).toBe(false)
  expect(covered(initial, { ...final, deleted: true }, { ...final, deleted: true }, [record], "/fixture")).toBe(false)
  expect(covered(initial, final, final, [], "/fixture")).toBe(false)
  expect(covered(initial, final, final, [{ ...record, root: "/other" }], "/fixture")).toBe(false)
})

for (const scenario of [
  "ready",
  "malformed",
  "missing",
  "quota",
  "coding-timeout",
  "zero-coding",
  "partial-coding",
  "response-usage",
  "zero-generic",
  "zero-forge",
  "history-503-first",
  "history-503-last",
  "retry-preparation",
  "retry-coding",
  "legacy-transport",
  "lost-history",
  "changed-inspection",
  "explicit-zero-coding",
  "unknown-cache",
  "compaction",
  "unexpected-model-phase",
] as const) {
  test(`offline runner preserves comparable attempts and accounting: ${scenario}`, async () => {
    const task = tasks.at(0)!
    const model = settings.model!
    const split = model.indexOf("/")
    const reference = { providerID: model.slice(0, split), modelID: model.slice(split + 1) }
    const roots = new Set<string>()
    const sessions = new Map<string, string>()
    const prompts: Array<{ arm: string; text: string; model: unknown; tools: Record<string, boolean> }> = []
    const records: Manifest[] = []
    const outputs = new Set<string>()
    const measured = { ...usage(model), input: 100, output: 20, measured: true }
    const zero = { ...usage(model), measured: true }
    const missing = {
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      cost: 0,
    }
    const assistant = {
      id: "answer",
      role: "assistant",
      ...reference,
      time: { created: 1, completed: 2 },
      tokens: { input: 200, output: 30, reasoning: 0, cache: { read: 0, write: 0 } },
      cost: 0.001,
      ...(scenario === "zero-coding" || scenario === "explicit-zero-coding" ? missing : {}),
    }
    const draft = {
      objective: "Implement the change",
      reuse: [],
      inspect: ["Read the tests"],
      changes: [],
      constraints: [],
      hypotheses: [],
      questions: [],
      acceptance: [],
      verification: [],
      evidence: [],
    }
    function retain(item: Manifest) {
      const value = captured(item)
      const missing =
        (item.purpose === "enhance" && (scenario === "missing" || scenario === "zero-forge")) ||
        (item.purpose === "generic-enhance" && scenario === "zero-generic") ||
        (item.purpose === "coding" && scenario === "zero-coding")
      const attempts = missing
        ? value.attempts?.map((attempt) => ({ ...attempt, response: undefined }))
        : value.attempts?.map((attempt) =>
            scenario === "unknown-cache" && item.purpose !== "coding"
              ? {
                  ...attempt,
                  response: {
                    ...attempt.response!,
                    usage: { format: "openai-chat" as const, input: item.usage.input, output: item.usage.output },
                  },
                }
              : attempt,
          )
      const retry =
        (scenario === "retry-preparation" && item.purpose !== "coding") ||
        (scenario === "retry-coding" && item.purpose === "coding")
      records.push({
        ...value,
        attempts:
          scenario === "legacy-transport"
            ? undefined
            : retry
              ? [
                  {
                    ...attempts!.at(0)!,
                    id: `${item.id}-first`,
                    ...(scenario === "retry-preparation" ? { status: 503, response: undefined } : {}),
                  },
                  { ...attempts!.at(0)!, sequence: 2 },
                ]
              : attempts,
      })
    }
    // A loopback protocol fixture exercises the real runner and graders without any provider calls.
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url)
        const root = url.searchParams.get("directory")!
        expect(request.headers.get("authorization")).toBe(`Basic ${Buffer.from("kilo:offline").toString("base64")}`)
        if (url.pathname === "/config") {
          outputs.add(root)
          return Response.json(settings)
        }
        if (url.pathname === "/provider")
          return Response.json({
            all: [
              {
                id: reference.providerID,
                models: { [reference.modelID]: { cost: { input: 1, output: 2, cache: { read: 0.5, write: 1 } } } },
              },
            ],
            default: {},
            connected: [reference.providerID],
          })
        if (url.pathname === "/session") {
          const body: { title: string } = await request.json()
          const arm = body.title.split("-").at(-1)!
          roots.add(root)
          sessions.set(root, arm)
          return Response.json({ id: arm })
        }
        if (url.pathname === "/forge/baseline") {
          const body: { text: string } = await request.json()
          expect(body.text).toBe(task.prompt)
          if (scenario === "quota") return new Response("PROMOTION_MODEL_LIMIT_REACHED", { status: 429 })
          retain({
            id: "generic-request",
            root,
            session: "",
            observed: Date.now(),
            purpose: "generic-enhance",
            generation: "fixture",
            entries: [],
            coverage: [],
            model,
            state: "completed",
            usage: scenario === "zero-generic" ? zero : measured,
          })
          return Response.json({
            text: "Generic notes omit the edge cases",
            usage: scenario === "zero-generic" ? zero : measured,
          })
        }
        if (url.pathname === "/forge/enhance") {
          const body: { text: string; session: string } = await request.json()
          expect(body.text).toBe(task.prompt)
          retain({
            id: "request",
            root,
            session: body.session,
            observed: Date.now(),
            purpose: "enhance",
            generation: "fixture",
            entries: [],
            coverage: [],
            model,
            state: "completed",
            usage: scenario === "missing" ? usage(model) : scenario === "zero-forge" ? zero : measured,
          })
          if (scenario === "malformed" || scenario === "missing") {
            try {
              prepare({ ...draft, inspect: [{ action: "Read the tests" }] }, body.text)
            } catch (err) {
              return Response.json({ _tag: "ForgeError", message: describe(err) }, { status: 500 })
            }
            return Response.json({ text: "Unexpectedly accepted malformed inspect" })
          }
          return Response.json({
            id: "proposal",
            original: body.text,
            generation: "fixture",
            ...prepare(draft, body.text),
            context: {
              matches: [],
              text: "Repository evidence",
              tokens: 10,
              budget: 100,
              estimator: "fixture",
              omitted: [],
            },
            usage: scenario === "zero-forge" ? zero : measured,
            warnings: ["Fixture preparation warning"],
          })
        }
        if (url.pathname === "/forge/validate") return Response.json({ valid: true })
        if (url.pathname === "/forge/requests-observation") {
          const retained = records.filter((record) => record.root === root)
          return Response.json({
            revision:
              scenario === "changed-inspection"
                ? crypto.randomUUID().replaceAll("-", "")
                : retained.length.toString(16).padStart(32, "0"),
            since: 1,
            before: "unknown",
            deleted: scenario === "lost-history" && retained.length > 0,
            admitted: retained.length + (scenario === "lost-history" && retained.length > 0 ? 1 : 0),
          })
        }
        if (url.pathname === "/forge/requests") return Response.json(records.filter((record) => record.root === root))
        if (url.pathname.endsWith("/abort")) return Response.json(true)
        if (url.pathname.endsWith("/message") && request.method === "POST") {
          const body: { parts: Array<{ text: string }>; model: unknown; tools: Record<string, boolean> } =
            await request.json()
          prompts.push({ arm: sessions.get(root)!, text: body.parts.at(0)!.text, model: body.model, tools: body.tools })
          retain({
            id: `coding-${root}`,
            root,
            session: sessions.get(root)!,
            observed: Date.now(),
            purpose: "coding",
            generation: "fixture",
            entries: [],
            coverage: [],
            model,
            state: "completed",
            usage: { ...usage(model), input: assistant.tokens.input, output: assistant.tokens.output, measured: true },
          })
          if (scenario === "compaction" || scenario === "unexpected-model-phase")
            retain({
              id: `extra-${root}`,
              root,
              session: sessions.get(root)!,
              observed: Date.now(),
              purpose: scenario === "compaction" ? "compaction" : "routing",
              generation: "fixture",
              entries: [],
              coverage: [],
              model,
              state: "completed",
              usage: measured,
            })
          if (scenario === "coding-timeout") return new Response("TimeoutError: provider timeout", { status: 504 })
          if (scenario.startsWith("history-503")) await materialize(root, task.solution)
          return Response.json({ info: assistant, parts: [] })
        }
        if (url.pathname.endsWith("/message")) {
          if (
            (scenario === "history-503-first" && sessions.get(root) === "normal") ||
            (scenario === "history-503-last" && sessions.get(root) === "forge")
          )
            return new Response("History store offline", { status: 503 })
          return Response.json(
            prompts.some((item) => item.arm === sessions.get(root))
              ? [
                  ...(scenario === "partial-coding"
                    ? [{ info: { ...assistant, ...missing, id: "unmeasured" }, parts: [] }]
                    : []),
                  ...(scenario === "compaction"
                    ? [
                        {
                          info: {
                            ...assistant,
                            id: "summary",
                            tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
                            cost: 0.00014,
                          },
                          parts: [],
                        },
                      ]
                    : []),
                  { info: scenario === "response-usage" ? { ...assistant, ...missing } : assistant, parts: [] },
                ]
              : [],
          )
        }
        return new Response(`Unexpected endpoint ${url.pathname}`, { status: 404 })
      },
    })
    try {
      const run = evaluate({
        base: server.url.toString(),
        password: "offline",
        trials: scenario.startsWith("history-503") ? 2 : 1,
        limit: 1,
      })
      if (scenario === "quota" || scenario === "coding-timeout" || scenario.startsWith("history-503"))
        await rejects(run, /partial report saved/)
      else outputs.add(await run)
      const output = [...outputs].at(0)!
      const result: {
        version: number
        provenance: { revision: string; configuration: string; harness: string }
        rows: Array<{
          arm: string
          initial: string
          preparation: number
          coding: number
          tokens: number | null
          cost: number | null
          failure: string | null
          known: { preparation: boolean; coding: boolean }
          prepared: { input: number }
          reported: { tokens: number; cost: number }
          usage: { calls: number }
          success: boolean
          error: string
          warnings: string[]
          grading: { success: boolean }
          models: { coding: string[] }
          state: string
        }>
      } = await Bun.file(path.join(output, "results.json")).json()
      expect(result.version).toBe(2)
      expect(result.provenance.revision).toMatch(/^[a-f0-9]{40}$/)
      expect(result.provenance.configuration).toHaveLength(64)
      expect(result.provenance.harness).toHaveLength(64)
      expect(new Set(result.rows.map((row) => row.initial)).size).toBe(1)
      expect(result.rows.every((row) => row.state === "completed")).toBe(true)
      expect(roots.size).toBe(result.rows.length)
      const summary = summarize(result, true)
      for (const item of prompts) {
        expect(item.text).toContain(task.prompt)
        if (item.arm === "normal") expect(item.text).toBe(task.prompt)
        expect(item.model).toEqual(reference)
        expect(Object.values(item.tools).every((value) => value === (item.arm === "forge"))).toBe(true)
      }
      const last = result.rows.at(-1)!
      if (scenario.startsWith("history-503")) {
        expect(result.rows).toHaveLength(scenario === "history-503-first" ? 1 : 3)
        expect(prompts).toHaveLength(result.rows.length)
        expect(last.failure).toBe("infrastructure")
        expect(last.grading.success).toBe(true)
        expect(last.success).toBe(false)
        expect(last.error).toContain("HTTP 503")
        expect(last.warnings.join("\n")).toContain("History store offline")
        expect(last.known.coding).toBe(false)
        expect(last.tokens).toBeNull()
        expect(last.cost).toBeNull()
        expect(last.reported.tokens).toBe(scenario === "history-503-first" ? 230 : 350)
        expect(last.reported.cost).toBeCloseTo(scenario === "history-503-first" ? 0.001 : 0.00114)
        expect(last.usage.calls).toBe(1)
        expect(summary.arms.every((arm) => arm.runs === 0 && arm.successes === 0)).toBe(true)
        expect(summary.text).toContain("Coding history unavailable: Error: HTTP 503: History store offline")
        expect(summary.text).toContain(scenario === "history-503-first" ? "230 reported tokens" : "930 reported tokens")
        expect(summary.text).toContain(
          scenario === "history-503-first" ? "UNAVAILABLE (unpaired)" : "UNAVAILABLE (excluded group)",
        )
        const response = await Bun.file(path.join(output, `${task.id}-1-${last.arm}`, "response.json")).json()
        expect(response.info.tokens.input).toBe(200)
      } else if (scenario === "zero-coding" || scenario === "partial-coding") {
        expect(result.rows.every((row) => !row.known.coding && row.tokens == null && row.cost == null)).toBe(true)
        expect(result.rows.at(0)?.reported.tokens).toBe(scenario === "zero-coding" ? 0 : 230)
        expect(last.reported.tokens).toBe(scenario === "zero-coding" ? 120 : 350)
        expect(last.usage.calls).toBe(scenario === "zero-coding" ? 1 : 2)
        expect(summary.arms.every((arm) => arm.runs === 1 && arm.tokens == null && arm.cost == null)).toBe(true)
        expect(summary.text).toContain("3 attempt(s) have unknown token or cost totals")
        expect(summary.text).toContain("Coding usage is incomplete or unavailable")
      } else if (scenario === "zero-generic" || scenario === "zero-forge") {
        const arm = scenario === "zero-generic" ? "generic" : "forge"
        const row = result.rows.find((row) => row.arm === arm)!
        expect(row.known).toEqual({ preparation: false, coding: true })
        expect(row.tokens).toBeNull()
        expect(row.cost).toBeNull()
        expect(row.reported.tokens).toBe(230)
        expect(summary.arms.find((item) => item.arm === arm)).toMatchObject({
          runs: 1,
          tokens: null,
          overhead: null,
          cost: null,
        })
        expect(summary.text).toContain("1 attempt(s) have unknown token or cost totals")
        expect(summary.text).toContain("Preparation usage is incomplete or unavailable")
      } else if (scenario === "retry-preparation") {
        expect(result.rows.at(0)?.tokens).toBe(230)
        for (const row of result.rows.slice(1)) {
          expect(row.known).toEqual({ preparation: false, coding: true })
          expect(row.tokens).toBeNull()
          expect(row.cost).toBeNull()
          expect(row.reported.tokens).toBe(350)
        }
      } else if (scenario === "retry-coding") {
        expect(result.rows.map((row) => row.tokens)).toEqual([460, 580, 580])
        expect(result.rows.every((row) => row.known.coding)).toBe(true)
        expect(result.rows.every((row) => row.cost == null)).toBe(true)
        expect(result.rows.every((row) => row.usage.calls === 1)).toBe(true)
      } else if (scenario === "explicit-zero-coding") {
        expect(result.rows.every((row) => row.known.coding)).toBe(true)
        expect(result.rows.map((row) => row.tokens)).toEqual([0, 120, 120])
        expect(result.rows.every((row) => row.cost != null)).toBe(true)
      } else if (scenario === "unknown-cache") {
        expect(result.rows.map((row) => row.tokens)).toEqual([230, 350, 350])
        expect(result.rows.slice(1).every((row) => row.cost == null && row.known.preparation)).toBe(true)
        expect(last.reported.cost).toBeCloseTo(0.00109)
      } else if (scenario === "compaction") {
        expect(result.rows.map((row) => row.tokens)).toEqual([350, 470, 470])
        expect(result.rows.every((row) => row.known.coding && row.usage.calls === 2)).toBe(true)
      } else if (scenario === "unexpected-model-phase") {
        expect(result.rows.every((row) => row.tokens == null && !row.known.coding)).toBe(true)
        expect(result.rows.map((row) => row.reported.tokens)).toEqual([350, 470, 470])
        expect(last.warnings.join("\n")).toContain("Unexpected model transport phase")
      } else if (scenario === "legacy-transport" || scenario === "lost-history" || scenario === "changed-inspection") {
        expect(result.rows.every((row) => row.tokens == null && row.cost == null)).toBe(true)
        expect(result.rows.map((row) => row.reported.tokens)).toEqual([230, 350, 350])
      } else if (scenario === "quota") {
        expect(last.arm).toBe("generic")
        expect(last.failure).toBe("quota")
        expect(last.preparation).toBeGreaterThan(0)
        expect(last.tokens).toBeNull()
        expect(last.cost).toBeNull()
        expect(prompts).toHaveLength(1)
      } else if (scenario === "coding-timeout") {
        expect(last.coding).toBeGreaterThan(0)
        expect(last.failure).toBe("infrastructure")
        expect(last.tokens).toBeNull()
        expect(last.reported.tokens).toBe(230)
        expect(result.rows).toHaveLength(1)
      } else if (scenario === "malformed" || scenario === "missing") {
        expect(last.failure).toBe("workflow")
        expect(last.preparation).toBeGreaterThan(0)
        expect(last.coding).toBe(0)
        expect(last.known.preparation).toBe(scenario === "malformed")
        expect(last.tokens).toBe(scenario === "malformed" ? 120 : null)
        expect(last.prepared.input).toBe(scenario === "malformed" ? 100 : 0)
        expect(prompts).toHaveLength(2)
      } else {
        expect(prompts).toHaveLength(3)
        expect(last.tokens).toBe(350)
        expect(last.usage.calls).toBe(1)
        expect(summary.arms.map((arm) => arm.tokens)).toEqual([230, 350, 350])
        expect(summary.text).toContain("Fixture preparation warning")
        expect(last.models.coding).toEqual([model])
      }
    } finally {
      await server.stop(true)
      await Promise.all([...roots, ...outputs].map((root) => rm(root, { recursive: true, force: true })))
    }
  })
}
