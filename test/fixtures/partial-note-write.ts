import { mock } from "bun:test"
import * as fs from "node:fs/promises"
import type { NoteInput } from "../../src/notes/types"

const dataDir = process.argv[2]
if (dataDir === undefined) throw new Error("Missing isolated data directory")
const write = fs.writeFile
let fail = true
mock.module("node:fs/promises", () => ({
  ...fs,
  writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
    if (fail && String(args[0]).includes("/notes/")) {
      fail = false
      await write(args[0], '{"partial":', args[2])
      throw Object.assign(new Error("simulated partial write"), { code: "ENOSPC" })
    }
    return write(...args)
  },
}))

const { NoteStore } = await import("../../src/notes/store")
const { runCheckpoint } = await import("../../src/checkpoint")
let random = 0
const store = new NoteStore({
  dataDir, random: () => (random += 0.01),
  log: { debug: async () => {}, info: async () => {}, warn: async () => {}, error: async () => {} },
})
const input: NoteInput = {
  cwd: "/project", root_session: "root", advisor_session: "reviewer",
  advisor_slug: "reviewer", roster_name: "Reviewer", provider: "test", model: "test/model",
  model_display: "Reviewer", variant: "default", severity: "concern",
  reasoning: "A reproduced failure", note: "Fix this failure", evidence: ["regression fails"],
  failure: "first failure", review: { task_id: "task", revision: "r1" },
  is_fallback: false, quarantined: false,
}
let writeFailed = false
try {
  await store.writeNote(input)
} catch {
  writeFailed = true
}
const valid = await store.writeNote({ ...input, failure: "independent failure", note: "Independent fix" })
const report = await runCheckpoint({
  store, directory: "/project", sessionID: "root", phase: "inspect",
  context: { task_id: "task", revision: "r1" },
})
console.log(JSON.stringify({
  writeFailed, findings: (await store.listFindings("/project", "root")).length,
  reports: report.issues.flatMap((issue) => issue.proposals).flatMap((proposal) => proposal.reports).map((note) => note.id),
  validID: valid.id,
}))
