import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AssistantMessage, UserMessage } from "@opencode-ai/sdk"
import { UsageLedger } from "../src/usage/ledger"
import { FindingStore } from "../src/notes/findings"

const directories: string[] = []
const ledgers: UsageLedger[] = []
afterEach(async () => {
  await Promise.all(ledgers.splice(0).map((ledger) => ledger.close()))
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
async function fixture(options: Partial<ConstructorParameters<typeof UsageLedger>[0]> = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "advisor-usage-"))
  directories.push(dataDir)
  const ledger = new UsageLedger({ dataDir, directory: "/project", clock: () => 1000, ...options })
  ledgers.push(ledger)
  return { ledger, dataDir }
}
function user(id = "prompt", created = 1001): UserMessage {
  return { id, sessionID: "child", role: "user", time: { created },
    agent: "advisor-reviewer", model: { providerID: "provider", modelID: "model" } }
}
function assistant(id: string, cost: number, created = 1002): AssistantMessage {
  return {
    id, sessionID: "child", role: "assistant", parentID: "prompt",
    time: { created, completed: created + 1 }, providerID: "provider", modelID: "model",
    mode: "advisor-reviewer", path: { cwd: "/project", root: "/project" }, cost,
    tokens: { input: 100, output: 10, reasoning: 5, cache: { read: 20, write: 30 } },
  }
}
const attemptInput = {
  root_session: "root", advisor_session: "child", advisor_slug: "reviewer",
  model: "provider/model", variant: "xhigh",
}

test("usage counts intermediate messages once and preserves totals across owners and restarts", async () => {
  const { ledger, dataDir } = await fixture()
  const attempt = await ledger.begin(attemptInput)
  await ledger.observe(user())
  await ledger.observe(assistant("step", 2))
  await ledger.observe(assistant("last", 0.25, 1004))
  await ledger.observe(assistant("step", 2))
  await ledger.finish(attempt.id, "completed")
  expect(await ledger.summary()).toMatchObject({ cost: 2.25, messages: 2, unattributed: 0 })
  await ledger.close()
  const reopened = new UsageLedger({ dataDir, directory: "/project" })
  ledgers.push(reopened)
  expect(await reopened.summary()).toMatchObject({ cost: 2.25, messages: 2, unattributed: 0 })
})

test("conflicting completed usage is reconciled from its message, and older incomplete events cannot overwrite it", async () => {
  const { ledger, dataDir } = await fixture()
  await ledger.begin(attemptInput)
  await ledger.observe(user())
  await ledger.observe(assistant("step", 2))
  let reads = 0
  const observer = new UsageLedger({
    dataDir, directory: "/project",
    readMessage: async () => { reads++; return assistant("step", 3) },
  })
  ledgers.push(observer)
  await observer.observe(assistant("step", 7))
  const incomplete = assistant("step", 0)
  await ledger.observe({ ...incomplete, time: { created: incomplete.time.created } })
  expect(reads).toBe(1)
  expect(await ledger.summary()).toMatchObject({ cost: 3, messages: 1, unattributed: 0 })
})

test("bounded reconciliation recovers missed steps and compaction costs without relying on the final parent", async () => {
  const summary = { ...assistant("summary", 0.5, 1030), summary: true, parentID: "compact" }
  const final = { ...assistant("final", 0.25, 1040), parentID: "compact" }
  const history = [user(), ...Array.from({ length: 20 }, (_, index) => assistant(`step-${index}`, 0.1, 1002 + index)),
    user("compact", 1029), summary, final]
  const limits: number[] = []
  const { ledger } = await fixture({
    readHistory: async (_sessionID, limit) => { limits.push(limit); return history.slice(-limit) },
    reconcileMaxMessages: 64,
  })
  const attempt = await ledger.begin(attemptInput)
  await ledger.finish(attempt.id, "completed", final)
  const totals = await ledger.summary()
  expect(totals.cost).toBeCloseTo(2.75)
  expect(totals).toMatchObject({ messages: 22, unattributed: 0, coverage: "complete" })
  expect(limits.length).toBeLessThanOrEqual(3)
  expect(Math.max(...limits)).toBeLessThanOrEqual(64)
})

test("a late cancellation cannot undo completed usage, and invalid provider numbers remain visibly unknown", async () => {
  const { ledger, dataDir } = await fixture({ readHistory: async () => [user(), assistant("final", 2)] })
  const attempt = await ledger.begin(attemptInput)
  await ledger.finish(attempt.id, "completed", assistant("final", 2))
  await ledger.finish(attempt.id, "cancellation_uncertain")
  const store = new FindingStore(dataDir)
  try { expect(await store.getUsage(attempt.id)).toMatchObject({ state: "completed", coverage: "complete" }) }
  finally { await store.close() }
  await ledger.observe(assistant("invalid", NaN, 1003))
  expect(await ledger.summary()).toMatchObject({ cost: 2, unknown_usage: 1, coverage: "partial" })
})

test("timed-out reconciliation cannot resume writing when its late history arrives", async () => {
  const history = Promise.withResolvers<readonly (UserMessage | AssistantMessage)[]>()
  const { ledger } = await fixture({ reconcileTimeoutMs: 5, readHistory: () => history.promise })
  const attempt = await ledger.begin(attemptInput)
  await ledger.finish(attempt.id, "cancelled_confirmed")
  history.resolve([user(), assistant("late", 9)])
  await new Promise((resolve) => setTimeout(resolve, 10))
  expect(await ledger.summary()).toMatchObject({ messages: 0, cost: 0, coverage: "partial" })
  // A genuinely observed late message still counts; only the abandoned scan is cancelled.
  await ledger.observe(assistant("late", 9))
  expect(await ledger.summary()).toMatchObject({ messages: 1, cost: 9 })
})
