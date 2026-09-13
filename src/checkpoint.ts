import type { DispositionInput, Note, NoteStore } from "./notes"
import { decideAdvice, decideUnavailableAdvice, findingIsActive, needsCompletionDisposition, type AdviceContext } from "./policy"
import { severityRank } from "./advice"
import { checkpointOutput, type CheckpointPage, type Proposal } from "./checkpoint/output"

export type CheckpointUpdate = Omit<DispositionInput, "verification"> & Readonly<{
  verification?: Omit<NonNullable<DispositionInput["verification"]>, "revision">
}>

type CheckpointInput = CheckpointPage & Readonly<{
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
  const proposals: Proposal[] = []
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
    proposals.push({
      finding, decision, requires_disposition: requiresDisposition,
      verification_current: finding.verification !== undefined && finding.verification.revision === context.revision,
      reports: [representative, ...group.filter((note) => note.id !== representative.id)],
    })
  }
  const paused = new Set([...proposals, ...unavailableReports]
    .filter((item) => item.decision.action === "pause_affected_action").map((item) => item.finding.id))
  return {
    phase: input.phase, context, completion_allowed: completionAllowed, action_allowed: actionAllowed,
    pause_required: paused.size > 0, paused_finding_count: paused.size,
    ...checkpointOutput(findings, proposals, unavailableReports, input),
  }
}
