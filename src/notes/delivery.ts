import type { Finding, Note } from "./types"

/** A shown report suppresses only its own finding, and only within the current open lifecycle. */
export async function deliveredFindingIDs(
  findings: readonly Finding[],
  readNote: (id: string) => Promise<Note | undefined>,
): Promise<ReadonlySet<string>> {
  const current = findings.map((finding) => ({
    id: finding.id,
    reports: finding.provenance
      .filter((source) => finding.reopened_at === undefined || source.time >= finding.reopened_at)
      .map((source) => source.note_id),
  }))
  const ids = [...new Set(current.flatMap((finding) => finding.reports))]
  const notes = await Promise.all(ids.map(readNote))
  const delivered = new Set(notes.filter((note): note is Note => note?.delivered_at !== undefined).map((note) => note.id))
  return new Set(current.filter((finding) => finding.reports.some((id) => delivered.has(id))).map((finding) => finding.id))
}
