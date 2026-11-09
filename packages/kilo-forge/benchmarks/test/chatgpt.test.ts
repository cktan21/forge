import { expect, test } from "bun:test"
import { account } from "../chatgpt"
import { free, subscription } from "../ablation"
import { summarize } from "../report"

const auth = { type: "oauth", access: "test-access", refresh: "test-refresh", expires: 7_200_000, accountId: "test" } as const
const cost = { input: 0, output: 0, cache: { read: 0, write: 0 } }
const model = { id: "gpt-5.4-mini", cost }

test("ChatGPT entry point accepts only sufficiently fresh OpenAI OAuth and strips other credentials", () => {
  expect(account({ openai: { ...auth, baseURL: "https://invalid.example" }, kilo: { type: "api", key: "unused" } }, 0))
    .toEqual({ openai: auth })
  for (const value of [
    {},
    { openai: { type: "api", key: "unused" } },
    { openai: { ...auth, access: "" } },
    { openai: { ...auth, expires: 1000 } },
  ]) expect(() => account(value, 0)).toThrow()
  expect(() => account({ openai: { type: "api", key: "private-api-key" } }, 0))
    .toThrow("A valid OpenAI ChatGPT OAuth credential is required; API keys are not accepted")
})

test("subscription policy accepts zero-rate named GPT models but does not weaken free-only mode", () => {
  expect(() => subscription(model, "openai")).not.toThrow()
  expect(() => free(model)).toThrow()
  expect(() => subscription(model, "kilo")).toThrow()
  expect(() => subscription({ ...model, id: "auto/free" }, "openai")).toThrow()
  expect(() => subscription({ ...model, autoRouting: { models: ["other"] } }, "openai")).toThrow()
  expect(() => subscription({ ...model, cost: { ...cost, input: 1 } }, "openai")).toThrow()
  expect(() => subscription({ ...model, cost: { ...cost, cache: { read: 0, write: 1 } } }, "openai")).toThrow()
})

test("reports distinguish subscription allowance from free-model pricing", () => {
  const row = {
    task: "fixture", trial: 1, initial: "same", success: true, error: "", blocked: false,
    elapsed: 1, preparation: 0, tokens: 10, cost: 0, prepared: { input: 0, output: 0 },
    usage: { calls: 1 }, tools: [],
    grading: { passed: 1, total: 1, regression: true, changed: [] },
  }
  const report = summarize({
    version: 4, billing: "chatgpt-subscription", model: "openai/gpt-6.1-sol",
    started: "2026-11-09", trials: 1, tasks: 1, fixture: "fixture", limitations: [],
    rows: ["normal", "forge"].map((arm) => ({ ...row, arm })),
  })
  expect(report.text).toContain("OAuth subscription allowance")
  expect(report.text).not.toContain("Free status and zero advertised prices")
})
