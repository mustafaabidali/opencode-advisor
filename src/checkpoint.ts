import type { DispositionInput, Finding, Note, NoteStore } from "./notes"
import { decideAdvice, decideUnavailableAdvice, findingIsActive, needsCompletionDisposition, type AdviceContext, type AdviceDecision } from "./policy"
import { severityRank } from "./advice"

export type CheckpointUpdate = Omit<DispositionInput, "verification"> & Readonly<{
  verification?: Omit<NonNullable<DispositionInput["verification"]>, "revision">
}>

type Proposal = Readonly<{
  finding: Finding
  decision: AdviceDecision
  requires_disposition: boolean
  verification_current: boolean
  reports: readonly Note[]
}>

type Issue = { id: string; proposals: Proposal[] }

type CheckpointInput = Readonly<{
  store: Pick<NoteStore, "listFindings" | "readNotes" | "recordDispositions">
  directory: string
  sessionID: string
  phase: "inspect" | "before_action" | "complete"
  context: AdviceContext
  updates?: readonly CheckpointUpdate[]
}>

/** Compare all remedies together; a disposition applies to one proposal only. */
export async function runCheckpoint(input: CheckpointInput) {
  const { store, directory, sessionID, context } = input
  const updates = (input.updates ?? []).map(({ verification, ...update }): DispositionInput => {
    if (verification === undefined) return update
    if (context.revision === undefined) throw new Error("Capture the current revision before verifying findings")
    return { ...update, verification: { ...verification, revision: context.revision } }
  })
  if (updates.length > 0) await store.recordDispositions(directory, sessionID, updates)
  const allFindings = await store.listFindings(directory, sessionID, {
    checkpoint: context, updated_ids: updates.map((update) => update.id),
  })
  const updatedIDs = new Set(updates.map((update) => update.id))
  const visibleIssues = new Set(allFindings.filter((finding) => findingIsActive(finding, context) ||
    updatedIDs.has(finding.id) || finding.provenance.some((source) => updatedIDs.has(source.note_id)))
    .map((finding) => finding.issue_id))
  const findings = allFindings.filter((finding) => visibleIssues.has(finding.issue_id))
  const notes = await store.readNotes(directory, sessionID, findings.flatMap((finding) =>
    finding.provenance.map((source) => source.note_id)))
  const available = new Set(notes.map((note) => note.id))
  const unavailableReports = findings.map((finding) => ({
    finding, decision: decideUnavailableAdvice(finding, context),
    note_ids: finding.provenance.map((source) => source.note_id).filter((id) => !available.has(id)),
  })).filter((entry) => entry.note_ids.length > 0)
  const reports = new Map<string, Note[]>()
  for (const note of notes) {
    if (note.finding_id === undefined || note.quarantined) continue
    const group = reports.get(note.finding_id) ?? []
    group.push(note)
    reports.set(note.finding_id, group)
  }
  const issues = new Map<string, Issue>()
  let completionAllowed = !unavailableReports.some(({ finding }) => findingIsActive(finding, context))
  let actionAllowed = !context.stopped &&
    !unavailableReports.some(({ decision }) => decision.action === "pause_affected_action")
  for (const finding of findings) {
    const group = reports.get(finding.id) ?? []
    const representative = [...group].sort((a, b) => severityRank(b.severity) - severityRank(a.severity))[0]
    if (representative === undefined) continue
    const decision = decideAdvice(representative, finding, context)
    const requiresDisposition = needsCompletionDisposition(representative, finding, context)
    if (requiresDisposition) completionAllowed = false
    if (decision.action === "pause_affected_action") actionAllowed = false
    const issue = issues.get(finding.issue_id) ?? { id: finding.issue_id, proposals: [] }
    issue.proposals.push({
      finding, decision, requires_disposition: requiresDisposition,
      verification_current: finding.verification !== undefined && finding.verification.revision === context.revision,
      reports: group,
    })
    issues.set(issue.id, issue)
  }
  return {
    phase: input.phase, context, completion_allowed: completionAllowed, action_allowed: actionAllowed,
    unavailable_reports: unavailableReports,
    issues: [...issues.values()].sort((a, b) => a.id.localeCompare(b.id)).map((issue) => ({
      ...issue, proposals: issue.proposals.sort((a, b) => a.finding.id.localeCompare(b.finding.id)),
    })),
  }
}
