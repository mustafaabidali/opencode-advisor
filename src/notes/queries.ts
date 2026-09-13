import type { Database } from "bun:sqlite"
import type { Finding, FindingDisposition, FindingQuery, FindingSource } from "./types"

type FindingRow = Omit<Finding, "provenance" | "disposition" | "verification" | "reopened_at">
type DispositionRow = Omit<FindingDisposition, "evidence"> & { finding_id: string; evidence: string }
type ProofRow = {
  finding_id: string; revision: string; evidence: string; in_scope: number
  affected_action: string | null; cost_if_delayed: string | null
}

function strings(json: string): string[] {
  const value: unknown = JSON.parse(json)
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

const BY_IDS = `SELECT value FROM json_each(?) UNION
  SELECT finding_id FROM finding_sources WHERE note_id IN (SELECT value FROM json_each(?))`

/** Five batched queries share one read snapshot, regardless of the finding count. */
export function readFindings(db: Database, cwd: string, rootSession?: string, query?: FindingQuery): Finding[] {
  if (query !== undefined && "ids" in query && query.ids.length === 0) return []
  return db.transaction(() => {
    const parameters = [cwd]
    let where = "cwd = ?"
    if (rootSession !== undefined) {
      where += " AND root_session = ?"
      parameters.push(rootSession)
    }
    if (query !== undefined) {
      if ("ids" in query) {
        where += ` AND id IN (${BY_IDS})`
        const ids = JSON.stringify(query.ids)
        parameters.push(ids, ids)
      } else {
        const scope = where
        const scopeParameters = [...parameters]
        let active = query.checkpoint.stopped ? "0" : "state = 'open'"
        parameters.push(...scopeParameters)
        if (query.checkpoint.task_id !== undefined) {
          active += " AND task_id = ?"
          parameters.push(query.checkpoint.task_id)
        }
        where += ` AND issue_id IN (
          SELECT issue_id FROM findings WHERE ${scope} AND ((${active}) OR id IN (${BY_IDS}))
        )`
        const ids = JSON.stringify(query.updated_ids)
        parameters.push(ids, ids)
      }
    }
    const rows = db.query<FindingRow, string[]>(`SELECT * FROM findings WHERE ${where} ORDER BY updated_at DESC`).all(...parameters)
    if (rows.length === 0) return []
    const ids = JSON.stringify(rows.map((row) => row.id))
    const dispositions = new Map(db.query<DispositionRow, [string]>(`
      SELECT finding_id, state, reason, reviewed_revision, evidence, time FROM finding_dispositions
      WHERE seq IN (
        SELECT MAX(seq) FROM finding_dispositions
        WHERE finding_id IN (SELECT value FROM json_each(?)) GROUP BY finding_id
      )
    `).all(ids).map(({ finding_id, ...row }) => [finding_id, { ...row, evidence: strings(row.evidence) }]))
    const proofs = new Map(db.query<ProofRow, [string]>(`
      SELECT * FROM finding_verifications WHERE finding_id IN (SELECT value FROM json_each(?))
    `).all(ids).map((row) => [row.finding_id, {
      revision: row.revision, evidence: strings(row.evidence), in_scope: row.in_scope === 1,
      ...(row.affected_action === null ? {} : { affected_action: row.affected_action }),
      ...(row.cost_if_delayed === null ? {} : { cost_if_delayed: row.cost_if_delayed }),
    }]))
    const reopened = new Map(db.query<{ finding_id: string; time: string }, [string]>(`
      SELECT finding_id, MAX(time) AS time FROM (
        SELECT finding_id, state, time, LAG(state) OVER (PARTITION BY finding_id ORDER BY seq) AS previous
        FROM finding_dispositions WHERE finding_id IN (SELECT value FROM json_each(?))
      ) WHERE state = 'open' AND previous != 'open' GROUP BY finding_id
    `).all(ids).map((row) => [row.finding_id, row.time]))
    const sources = new Map<string, FindingSource[]>()
    for (const { finding_id, ...source } of db.query<FindingSource & { finding_id: string }, [string]>(`
      SELECT * FROM finding_sources WHERE finding_id IN (SELECT value FROM json_each(?)) ORDER BY time, note_id
    `).all(ids)) {
      const group = sources.get(finding_id) ?? []
      group.push(source)
      sources.set(finding_id, group)
    }
    return rows.map((row) => {
      const disposition = dispositions.get(row.id)
      const verification = proofs.get(row.id)
      const reopenedAt = reopened.get(row.id)
      return {
        ...row, provenance: sources.get(row.id) ?? [],
        ...(disposition === undefined ? {} : { disposition }),
        ...(verification === undefined ? {} : { verification }),
        ...(reopenedAt === undefined ? {} : { reopened_at: reopenedAt }),
      }
    })
  })()
}
