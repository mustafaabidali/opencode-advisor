import { createHash } from "node:crypto"
import { severityRank } from "./advice"
import type { Finding, Note, NoteInput, ReviewContext } from "./notes/types"

export type AdviceContext = Partial<ReviewContext> & Readonly<{ stopped?: boolean; next_action?: string }>

export type AdviceDecision = Readonly<{
  action: "ignore" | "defer" | "fix_in_scope" | "pause_affected_action"
  attention: "none" | "checkpoint" | "affected_action"
  reason: string
}>

export function findingIsActive(finding: Finding, context: AdviceContext = {}): boolean {
  return finding.state === "open" && !context.stopped &&
    (context.task_id === undefined || finding.task_id === context.task_id)
}

function checkedActionAtRisk(finding: Finding | undefined, context: AdviceContext): boolean {
  const proof = finding?.verification
  return proof !== undefined && proof.revision === (context.revision ?? finding?.reviewed_revision) &&
    proof.in_scope && proof.evidence.some((item) => item.trim() !== "") &&
    proof.affected_action !== undefined && proof.affected_action === context.next_action &&
    (proof.cost_if_delayed?.trim().length ?? 0) > 0
}

/** Losing a report cannot clear its current, verified evidence of an affected action's risk. */
export function decideUnavailableAdvice(finding: Finding, context: AdviceContext): AdviceDecision {
  if (!findingIsActive(finding, context)) return { action: "defer", attention: "none", reason: "report_unavailable" }
  if (checkedActionAtRisk(finding, context)) {
    return { action: "pause_affected_action", attention: "affected_action", reason: "verified_report_unavailable" }
  }
  return { action: "defer", attention: "checkpoint", reason: "report_unavailable" }
}

export function decideAdvice(note: Note, finding?: Finding, context: AdviceContext = {}): AdviceDecision {
  if (note.quarantined || note.expired_at !== undefined) {
    return { action: "ignore", attention: "none", reason: note.quarantined ? "quarantined" : "expired" }
  }
  if (finding !== undefined && finding.state !== "open") {
    return { action: "ignore", attention: "none", reason: finding.state }
  }
  if (note.finding_id !== undefined && finding === undefined) {
    return { action: "defer", attention: "none", reason: "finding_state_unavailable" }
  }
  if (context.stopped) return { action: "defer", attention: "none", reason: "user_stopped_work" }
  const task = note.review?.task_id ?? finding?.task_id
  if (context.task_id !== undefined && task !== undefined && task !== context.task_id) {
    return { action: "defer", attention: "none", reason: "task_changed" }
  }
  const proof = finding?.verification
  const revision = context.revision ?? finding?.reviewed_revision
  if (proof !== undefined && proof.revision === revision && proof.evidence.some((item) => item.trim() !== "")) {
    if (!proof.in_scope) return { action: "defer", attention: "none", reason: "outside_authorized_scope" }
    if (note.severity === "blocker" && checkedActionAtRisk(finding, context)) {
      return { action: "pause_affected_action", attention: "affected_action", reason: "verified_cost_of_delay" }
    }
    return { action: "fix_in_scope", attention: "checkpoint", reason: "verified_relevant_defect" }
  }
  if (note.reasoning.trim() === "" || !note.evidence.some((item) => item.trim() !== "")) {
    return { action: "defer", attention: "none", reason: "unsupported_observation" }
  }
  return { action: "defer", attention: "checkpoint", reason: "verify_current_state" }
}

/** A later edit invalidates proof freshness; it does not resolve a verified defect. */
export function needsCompletionDisposition(note: Note, finding: Finding, context: AdviceContext): boolean {
  return finding.state === "open" && !note.quarantined && note.severity !== "nit" &&
    (context.task_id === undefined || finding.task_id === context.task_id) &&
    finding.verification?.in_scope === true &&
    finding.verification.evidence.some((item) => item.trim() !== "")
}

function normalized(text: string): string {
  return text.replaceAll("\r\n", "\n").trim().replace(/[.,;!?]+$/, "")
}

function proposalText(text: string): string {
  return text.replaceAll("\r\n", "\n").trim()
}

export function findingKey(note: Note): string {
  return note.finding_id ?? note.id
}

export function uniqueFindings(notes: readonly Note[]): Note[] {
  const unique = new Map<string, Note>()
  for (const note of notes) {
    const key = findingKey(note)
    const prior = unique.get(key)
    if (prior === undefined || severityRank(note.severity) > severityRank(prior.severity)) unique.set(key, note)
  }
  return [...unique.values()]
}

/** Group the problem without choosing among reviewers' proposed remedies. */
export function issueIdentity(note: NoteInput): string {
  const locations = (note.location === undefined ? [...note.evidence] : [note.location])
    .map((value) => normalized(value.replace(/:\d+(?::\d+)?(?:-\d+)?/g, "")))
    .sort()
  const key = [
    note.cwd, note.root_session, note.review?.task_id ?? note.root_session,
    normalized(note.failure ?? note.note), locations.join("\n"),
  ].join("\0")
  return `iss_${createHash("sha256").update(key).digest("hex").slice(0, 24)}`
}

/** Suppress only redundant proposals. Different fixes or evidence remain independent. */
export function findingIdentity(note: NoteInput): string {
  const key = [
    issueIdentity(note),
    proposalText(note.note),
    [...note.evidence].map(proposalText).sort().join("\n"),
  ].join("\0")
  return `fnd_${createHash("sha256").update(key).digest("hex").slice(0, 24)}`
}
