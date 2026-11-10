import { expect, test } from "bun:test"
import { tasks } from "../preparation"
import { tasks as originals } from "../tasks"
import { preflight } from "../grading"
import { dataset } from "../repositories"

test("preparation tasks give every arm the same documented constraints and keep graders private", async () => {
  expect(tasks).toHaveLength(4)
  for (const [index, task] of tasks.entries()) {
    const original = originals.at(index)!
    expect(task.checks).toEqual(original.checks)
    expect(task.solution).toEqual(original.solution)
    expect(Object.values(task.files).some((text) => text.includes(original.prompt))).toBe(true)
    expect(task.prompt).not.toBe(original.prompt)
    expect(task.relevant?.every((file) => Object.hasOwn(task.files, file))).toBe(true)
    expect(Object.keys(task.files).some((file) => /solution|evaluator/.test(file))).toBe(false)
  }
  const controls = await preflight(tasks)
  expect(controls.every((row) => row.reference && row.regression && row.passed < row.total)).toBe(true)
  expect(dataset(tasks).hash).not.toBe(dataset(originals).hash)
}, 30000)
