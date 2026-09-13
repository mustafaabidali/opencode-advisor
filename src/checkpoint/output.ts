import type { Finding, Note } from "../notes"
import type { AdviceDecision } from "../policy"

export type Proposal = Readonly<{
  finding: Finding
  decision: AdviceDecision
  requires_disposition: boolean
  verification_current: boolean
  reports: readonly Note[]
}>
export type Unavailable = Readonly<{ finding: Finding; decision: AdviceDecision; note_ids: readonly string[] }>
export type CheckpointPage = Readonly<{
  offset?: number
  limit?: number
  detail?: Readonly<{ finding_id: string; kind?: "report" | "finding"; report_offset?: number; text_offset?: number }>
}>

const excerpt = (value: string, limit: number) => value.slice(0, limit)
const evidence = (items: readonly string[]) => items.slice(0, 4).map((item) => excerpt(item, 240))
const bounded = (value: number | undefined, fallback: number, max: number) =>
  value !== undefined && Number.isSafeInteger(value) ? Math.max(0, Math.min(value, max)) : fallback

function compactFinding(finding: Finding) {
  return {
    ...finding, provenance: finding.provenance.slice(0, 4), provenance_count: finding.provenance.length,
    ...(finding.disposition === undefined ? {} : { disposition: {
      ...finding.disposition, reason: excerpt(finding.disposition.reason, 600),
      evidence: evidence(finding.disposition.evidence),
    } }),
    ...(finding.verification === undefined ? {} : { verification: {
      ...finding.verification, evidence: evidence(finding.verification.evidence),
      ...(finding.verification.cost_if_delayed === undefined ? {} :
        { cost_if_delayed: excerpt(finding.verification.cost_if_delayed, 600) }),
    } }),
  }
}

function compactReport(note: Note) {
  return {
    ...note, reasoning: excerpt(note.reasoning, 600), note: excerpt(note.note, 1_200),
    evidence: evidence(note.evidence),
    ...(note.failure === undefined ? {} : { failure: excerpt(note.failure, 300) }),
    ...(note.location === undefined ? {} : { location: excerpt(note.location, 300) }),
    excerpt: true,
  }
}

/** Pagination controls presentation only. Callers compute all safety decisions before this step. */
export function checkpointOutput(findings: readonly Finding[], proposals: readonly Proposal[],
  unavailable: readonly Unavailable[], options: CheckpointPage) {
  const ordered = [...findings].sort((a, b) => a.issue_id.localeCompare(b.issue_id) || a.id.localeCompare(b.id))
  const offset = bounded(options.offset, 0, Number.MAX_SAFE_INTEGER)
  const limit = Math.max(1, bounded(options.limit, 20, 50))
  const visible = new Set(ordered.slice(offset, offset + limit).map((finding) => finding.id))
  const issues = new Map<string, { id: string; proposals: ReturnType<typeof compactProposal>[] }>()
  function compactProposal(proposal: Proposal) {
    return {
      ...proposal, finding: compactFinding(proposal.finding),
      reports: proposal.reports.slice(0, 1).map(compactReport), report_count: proposal.reports.length,
    }
  }
  for (const proposal of proposals) {
    if (!visible.has(proposal.finding.id)) continue
    const id = proposal.finding.issue_id
    const issue = issues.get(id) ?? { id, proposals: [] }
    issue.proposals.push(compactProposal(proposal))
    issues.set(id, issue)
  }
  const detail = options.detail
  const selected = detail === undefined ? undefined : proposals.find((item) => item.finding.id === detail.finding_id)
  const selectedFinding = ordered.find((finding) => finding.id === detail?.finding_id)
  const reportOffset = bounded(detail?.report_offset, 0, Number.MAX_SAFE_INTEGER)
  const textOffset = bounded(detail?.text_offset, 0, Number.MAX_SAFE_INTEGER)
  const chunk = (value: unknown) => {
    const json = JSON.stringify(value)
    return { json: json.slice(textOffset, textOffset + 6_000), total_chars: json.length,
      next_offset: textOffset + 6_000 < json.length ? textOffset + 6_000 : null }
  }
  const reports = selectedFinding?.provenance.slice(reportOffset, reportOffset + 1).map((source) => {
    const note = selected?.reports.find((report) => report.id === source.note_id)
    return { note_id: source.note_id, status: note === undefined ? "unavailable" : "available",
      ...chunk(note ?? { note_id: source.note_id, status: "unavailable" }) }
  }) ?? []
  return {
    schema_version: 2,
    page: { offset, limit, total: ordered.length, next_offset: offset + limit < ordered.length ? offset + limit : null },
    issues: [...issues.values()].sort((a, b) => a.id.localeCompare(b.id)).map((issue) => ({
      ...issue, proposals: issue.proposals.sort((a, b) => a.finding.id.localeCompare(b.finding.id)),
    })),
    unavailable_report_count: unavailable.reduce((count, entry) => count + entry.note_ids.length, 0),
    unavailable_reports: unavailable.filter((entry) => visible.has(entry.finding.id)).map((entry) => ({
      ...entry, finding: compactFinding(entry.finding), note_ids: entry.note_ids.slice(0, 20),
      note_count: entry.note_ids.length,
    })),
    ...(detail === undefined ? {} : { details: {
      finding_id: detail.finding_id, report_offset: reportOffset, reports,
      ...(detail.kind === "finding" && selectedFinding !== undefined ? { finding: chunk(selectedFinding) } : {}),
      total_reports: selectedFinding?.provenance.length ?? 0,
      next_report_offset: reportOffset + 1 < (selectedFinding?.provenance.length ?? 0) ? reportOffset + 1 : null,
    } }),
  }
}
