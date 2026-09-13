import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { UserMessage } from "@opencode-ai/sdk"

import { TaskContexts } from "../src/advisor/context"
import { NoteStore } from "../src/notes"
import type { TranscriptMessage } from "../src/delta"

function user(id: string): UserMessage {
  return {
    id, role: "user", sessionID: "root", time: { created: Date.now() },
    agent: "build", model: { providerID: "test", modelID: "model" },
  }
}

test("a status question preserves the task; explicit replacement persists across restart", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "advisor-context-"))
  try {
    const store = new NoteStore({
      dataDir,
      log: { debug: async () => {}, info: async () => {}, warn: async () => {}, error: async () => {} },
    })
    const contexts = new TaskContexts(store, "/project")
    contexts.user(user("work-request"))
    const review = await contexts.capture("root", [{ info: user("work-request"), parts: [] }])
    contexts.user(user("status-question"))
    await contexts.checkpoint("root", "continue")
    expect(contexts.current("root").task_id).toBe(review.task_id)
    expect(contexts.current("root").user_message_id).toBe("status-question")

    await contexts.checkpoint("root", "replace")
    const restarted = new TaskContexts(store, "/project")
    await restarted.capture("root", [{ info: user("status-question"), parts: [] }])
    expect(restarted.current("root").task_id).toBe("status-question")
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})

test("checkpoints preserve a stop until explicitly resumed, and status messages do not invalidate checked work", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "advisor-context-"))
  try {
    const contexts = new TaskContexts(new NoteStore({
      dataDir, log: { debug: async () => {}, info: async () => {}, warn: async () => {}, error: async () => {} },
    }), "/project")
    const transcript: TranscriptMessage[] = [{ info: user("work-request"), parts: [] }]
    const before = await contexts.capture("root", transcript)
    contexts.user(user("status-question"))
    const after = await contexts.capture("root", [...transcript, { info: user("status-question"), parts: [] }])
    expect(after.revision).toBe(before.revision)
    await contexts.checkpoint("root", "stop")
    expect((await contexts.checkpoint("root", "continue")).stopped).toBeTrue()
    expect((await contexts.checkpoint("root", "resume")).stopped).toBeFalse()
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})
