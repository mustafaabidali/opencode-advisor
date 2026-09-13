import { expect, test } from "bun:test"
import { runCheckpoint } from "../src/checkpoint"
import type { Finding, Note } from "../src/notes"

const context = { task_id: "task", revision: "revision", next_action: "publish" }
function report(id: string, findingID = "finding"): Note {
  return {
    id, finding_id: findingID, issue_id: "issue", cwd: "/project", root_session: "root",
    advisor_session: "child", advisor_slug: "oracle", roster_name: "Oracle", provider: "test",
    model: "test/model", model_display: "Test", variant: "default", severity: "blocker",
    reasoning: "Evidence ".repeat(400), note: "Fix ".repeat(1000), evidence: ["file.ts:20"],
    is_fallback: false, quarantined: false, time: "2026-09-13T12:00:00.000Z",
    review: context,
  }
}
function finding(id: string, notes: readonly Note[]): Finding {
  return {
    id, issue_id: "issue", cwd: "/project", root_session: "root", task_id: "task",
    reviewed_revision: "revision", version: 1, state: "open", updated_at: notes[0]?.time ?? "",
    verification: { revision: "revision", evidence: ["checked file.ts"], in_scope: true,
      affected_action: "publish", cost_if_delayed: "would ship the defect" },
    provenance: notes.map((note) => ({ note_id: note.id, advisor_slug: note.advisor_slug,
      model: note.model, time: note.time, reviewed_revision: "revision" })),
  }
}

test("a checkpoint with 100 reports returns a bounded summary and retrievable details", async () => {
  const notes = Array.from({ length: 100 }, (_, i) => report(`note-${i}`))
  const store = { listFindings: async () => [finding("finding", notes)], readNotes: async () => notes,
    recordDispositions: async () => {} }
  const input = { store, directory: "/project", sessionID: "root", phase: "inspect", context } as const
  const summary = await runCheckpoint(input)
  expect(JSON.stringify(summary).length).toBeLessThan(8_192)
  expect(summary.issues[0]?.proposals[0]?.report_count).toBe(100)
  expect(summary.issues[0]?.proposals[0]?.reports).toHaveLength(1)
  const first = await runCheckpoint({ ...input, detail: { finding_id: "finding", report_offset: 99, text_offset: 0 } })
  expect(first.details?.reports[0]?.note_id).toBe("note-99")
  const chunk = first.details?.reports[0]
  expect(chunk?.next_offset).toBeGreaterThan(0)
  const rest = await runCheckpoint({ ...input, detail: {
    finding_id: "finding", report_offset: 99, text_offset: chunk?.next_offset ?? 0,
  } })
  const complete = JSON.parse((chunk?.json ?? "") + (rest.details?.reports[0]?.json ?? ""))
  expect(complete).toEqual(notes[99])
})

test("paging cannot hide a blocker or an unavailable report from global gates", async () => {
  const notes = [report("available", "a"), report("missing", "z")]
  const findings = notes.map((note) => finding(note.finding_id ?? "", [note]))
  const result = await runCheckpoint({
    store: { listFindings: async () => findings, readNotes: async () => [notes[0]!],
      recordDispositions: async () => {} },
    directory: "/project", sessionID: "root", phase: "before_action", context, limit: 1, offset: 0,
  })
  expect(result.page.total).toBe(2)
  expect(result.page.next_offset).toBe(1)
  expect(result.completion_allowed).toBe(false)
  expect(result.action_allowed).toBe(false)
  expect(result.pause_required).toBe(true)
  expect(result.unavailable_report_count).toBe(1)
  expect(result.unavailable_reports).toHaveLength(0)
})
