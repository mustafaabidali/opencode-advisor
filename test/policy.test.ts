import { expect, test } from "bun:test"
import { decideAdvice } from "../src/policy"
import type { Finding, Note } from "../src/notes"

const note: Note = {
  id: "note-1", time: "2026-09-12T20:00:00Z", finding_id: "finding-1",
  cwd: "/project", root_session: "root", advisor_session: "reviewer",
  advisor_slug: "oracle", roster_name: "Oracle", provider: "test", model: "test/model",
  model_display: "Reviewer", variant: "default", severity: "concern",
  reasoning: "The failure is reproducible", note: "Check the result before acknowledging",
  evidence: ["the failing integration test"], is_fallback: false, quarantined: false,
  review: { task_id: "task-1", revision: "revision-1", user_message_id: "user-1" },
}
const finding: Finding = {
  id: "finding-1", issue_id: "issue-1", cwd: "/project", root_session: "root", task_id: "task-1",
  reviewed_revision: "revision-1", version: 0, state: "open", updated_at: note.time, provenance: [],
}

test("a late finding from an obsolete task is withheld until revalidated", () => {
  const decision = decideAdvice(note, finding, {
    task_id: "task-2", revision: "revision-2", user_message_id: "user-2",
  })

  expect(decision).toMatchObject({ action: "defer", attention: "none", reason: "task_changed" })
})

test("a verified in-scope concern calls for a fix while unrelated work remains available", () => {
  const decision = decideAdvice(note, {
    ...finding,
    verification: {
      revision: "revision-1", evidence: ["reproduced the false acknowledgment"],
      in_scope: true,
    },
  }, { task_id: "task-1", revision: "revision-1", next_action: "answer_status" })

  expect(decision.action).toBe("fix_in_scope")
  expect(decision.attention).toBe("checkpoint")
})

test("a verified blocker pauses only the named costly action and yields to an explicit stop", () => {
  const blocker = { ...note, severity: "blocker" as const }
  const verified = {
    ...finding,
    verification: {
      revision: "revision-1", evidence: ["reproduced the corrupt published output"], in_scope: true,
      affected_action: "publish", cost_if_delayed: "publishes corrupt output to users",
    },
  }
  const context = { task_id: "task-1", revision: "revision-1", next_action: "publish" }

  expect(decideAdvice(blocker, verified, context).action).toBe("pause_affected_action")
  expect(decideAdvice(blocker, verified, { ...context, next_action: "answer_status" }).action).toBe("fix_in_scope")
  expect(decideAdvice(blocker, verified, { ...context, stopped: true })).toMatchObject({
    action: "defer", attention: "none",
  })
})

test("an unsupported blocker remains a stored observation rather than an injected obligation", () => {
  expect(decideAdvice({ ...note, severity: "blocker", reasoning: "", evidence: [] }, finding)).toMatchObject({
    action: "defer", attention: "none", reason: "unsupported_observation",
  })
})
