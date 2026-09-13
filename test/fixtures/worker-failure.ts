import { mock } from "bun:test"
import { readdir } from "node:fs/promises"
import { join } from "node:path"
import * as threads from "node:worker_threads"
import type { NoteInput } from "../../src/notes/types"

const [dataDir, failure] = process.argv.slice(2)
if (dataDir === undefined || (failure !== "idle" && failure !== "after-commit")) {
  throw new Error("Expected a test directory and worker failure mode")
}
const RealWorker = threads.Worker
const workers: threads.Worker[] = []
class ObservedWorker extends RealWorker {
  constructor(...args: ConstructorParameters<typeof RealWorker>) {
    super(...args)
    workers.push(this)
  }
}
mock.module("node:worker_threads", () => ({ ...threads, Worker: ObservedWorker }))
const { NoteStore } = await import("../../src/notes/store")
const { DatabaseUnavailableError } = await import("../../src/notes/database-client")
let sequence = 0
const store = new NoteStore({
  dataDir, random: () => ++sequence / 0x1000000,
  clock: () => new Date("2026-09-13T00:00:00.000Z"),
  log: { debug: async () => {}, info: async () => {}, warn: async () => {}, error: async () => {} },
})
const input: NoteInput = {
  cwd: "/project", root_session: "root", advisor_session: "reviewer",
  advisor_slug: "reviewer", roster_name: "Reviewer", provider: "test", model: "test/model",
  model_display: "Reviewer", variant: "default", severity: "concern",
  reasoning: "The regression fails", note: "Fix the failing regression", evidence: ["Checked the failure"],
  review: { task_id: "task", revision: "r1" }, is_fallback: false, quarantined: false,
}

try {
  await store.writeTask("/project", "root", { task_id: "task", revision: "r1", stopped: false })
  const worker = workers[0]
  if (worker === undefined) throw new Error("Expected a real database worker")
  if (failure === "idle") {
    await worker.terminate()
  } else {
    // The real worker commits and replies, but its caller loses the reply before it can acknowledge the write.
    worker.removeAllListeners("message")
    worker.once("message", () => { void worker.terminate() })
  }
  let writeError: unknown
  try { await store.writeNote(input) } catch (error) { writeError = error }
  if (!(writeError instanceof Error)) throw new Error("Expected the interrupted write to fail")
  const retainedNotes = (await readdir(join(dataDir, "notes"))).filter((name) => name.endsWith(".json")).length
  const committedFindings = (await store.listFindings("/project", "root")).length
  const next = await store.writeNote({ ...input, note: "A different remedy after recovery" })
  const recovered = (await store.listFindings("/project", "root")).some((finding) => finding.id === next.finding_id)
  console.log(JSON.stringify({
    uncertain: writeError instanceof DatabaseUnavailableError, retainedNotes, committedFindings, recovered,
  }))
} finally {
  await store.close()
}
