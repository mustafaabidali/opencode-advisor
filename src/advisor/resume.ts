import { severityRank } from "../advice"
import type { Note } from "../notes"
import type { AdvisorStore } from "./pass-types"

export async function resumedNotes(store: AdvisorStore, cwd: string, root: string): Promise<Note[]> {
  if (store.listFindings === undefined || store.readNotes === undefined) return []
  const findings = (await store.listFindings(cwd, root)).filter((finding) => finding.state === "open")
  const notes: Note[] = []
  for (const finding of findings) {
    const reports = await store.readNotes(cwd, root, finding.provenance.map((source) => source.note_id))
    const representative = reports.filter((note) => !note.quarantined && note.expired_at === undefined)
      .sort((a, b) => severityRank(b.severity) - severityRank(a.severity))[0]
    if (representative !== undefined) notes.push(representative)
  }
  return notes
}
