import type { AdvisorConfig } from "../config"
import type { ModelCatalog, ModelRef } from "../models"
import type { AdvisorStore } from "./pass-types"

export function contextBudget(config: AdvisorConfig, model: ModelRef, catalog: ModelCatalog): number | undefined {
  const capacity = catalog.limits?.get(model.long)
  const known = capacity === undefined ? undefined : Math.floor(capacity * config.context_budget_fraction)
  const explicit = config.context_budget_tokens > 0 ? config.context_budget_tokens : undefined
  return explicit === undefined ? known : known === undefined ? explicit : Math.min(explicit, known)
}

/** All required proposals travel together. No new tool grant or model summarization is needed. */
export async function carryFindings(store: AdvisorStore, cwd: string, root: string, slug: string,
  taskID: string | undefined, maxChars: number): Promise<string | undefined> {
  if (store.listFindings === undefined || store.readNotes === undefined) return ""
  const findings = (await store.listFindings(cwd, root))
    .filter((finding) => (taskID === undefined || finding.task_id === taskID) &&
      finding.provenance.some((source) => source.advisor_slug === slug))
    .sort((a, b) => a.id.localeCompare(b.id))
  const open = findings.filter((finding) => finding.state === "open")
  const sourceIDs = open.flatMap((finding) => {
    const source = finding.provenance.findLast((source) => source.advisor_slug === slug)
    return source === undefined ? [] : [source.note_id]
  })
  const notes = new Map((await store.readNotes(cwd, root, sourceIDs)).map((note) => [note.id, note]))
  const carried = open.map((finding, index) => {
    const sourceID = sourceIDs[index]
    const note = sourceID === undefined ? undefined : notes.get(sourceID)
    return {
      finding_id: finding.id, issue_id: finding.issue_id, state: finding.state,
      reviewed_revision: finding.reviewed_revision, disposition: finding.disposition, verification: finding.verification,
      report_id: sourceID, report_unavailable: note === undefined,
      ...(note === undefined ? {} : { reasoning: note.reasoning, proposal: note.note, evidence: note.evidence }),
    }
  })
  if (carried.some((item) => item.report_unavailable && item.state === "open")) return undefined
  const closed = findings.filter((finding) => finding.state !== "open")
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id))
    .map((finding) => ({
      finding_id: finding.id, issue_id: finding.issue_id, state: finding.state,
      ...(finding.disposition === undefined ? {} : { disposition: {
        state: finding.disposition.state, reason: finding.disposition.reason.slice(0, 200),
      } }),
    }))
  const retained: typeof closed = []
  const serialize = () => JSON.stringify({ open: carried, closed: retained, closed_omitted: closed.length - retained.length })
  let text = serialize()
  if (text.length > maxChars) return undefined
  for (const item of closed) {
    retained.push(item)
    const next = serialize()
    if (next.length > maxChars) { retained.pop(); break }
    text = next
  }
  return text
}
