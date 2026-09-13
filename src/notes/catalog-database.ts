import type { Database } from "bun:sqlite"
import type { Finding, Note } from "./types"

export type CatalogCursor = Readonly<{ time: string; id: string }>
export type CatalogProgress = Readonly<{ cursor: string; complete: boolean; indexed: number; unavailable: number }>
export type Receipt = Readonly<{ note_id: string; delivered_at: string }>

/** Metadata and receipts share the finding transaction; report JSON remains the evidence archive. */
export class CatalogDatabase {
  constructor(private readonly db: Database) {
    db.transaction(() => db.exec(`
      CREATE TABLE IF NOT EXISTS note_catalog (
        id TEXT PRIMARY KEY, cwd TEXT NOT NULL, root_session TEXT NOT NULL,
        finding_id TEXT, time TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS catalog_scope_time ON note_catalog(cwd, time DESC, id DESC);
      CREATE TABLE IF NOT EXISTS note_receipts (note_id TEXT PRIMARY KEY, delivered_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS catalog_progress (id INTEGER PRIMARY KEY CHECK(id = 1), cursor TEXT NOT NULL, complete INTEGER NOT NULL);
      INSERT OR IGNORE INTO catalog_progress VALUES (1, '', 0);
      CREATE TABLE IF NOT EXISTS catalog_unavailable (note_id TEXT PRIMARY KEY);
    `)).immediate()
  }

  index(note: Note): void {
    this.db.query("INSERT OR IGNORE INTO note_catalog VALUES (?, ?, ?, ?, ?)")
      .run(note.id, note.cwd, note.root_session, note.finding_id ?? null, note.time)
    this.db.query("DELETE FROM catalog_unavailable WHERE note_id = ?").run(note.id)
    if (note.delivered_at !== undefined) this.acknowledge([note.id], note.delivered_at)
  }

  indexBatch(notes: readonly Note[], unavailable: readonly string[], cursor?: string, complete = false): void {
    this.db.transaction(() => {
      for (const note of notes) this.index(note)
      for (const id of unavailable) this.db.query("INSERT OR IGNORE INTO catalog_unavailable VALUES (?)").run(id)
      if (cursor !== undefined) this.db.query(`UPDATE catalog_progress
        SET cursor = CASE WHEN cursor = '' OR cursor > ? THEN ? ELSE cursor END, complete = MAX(complete, ?) WHERE id = 1`)
        .run(cursor, cursor, complete ? 1 : 0)
    }).immediate()
  }

  progress(): CatalogProgress {
    const row = this.db.query<{ cursor: string; complete: number }, []>("SELECT cursor, complete FROM catalog_progress WHERE id = 1").get()
    const count = (table: string) => this.db.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count ?? 0
    return { cursor: row?.cursor ?? "", complete: row?.complete === 1,
      indexed: count("note_catalog"), unavailable: count("catalog_unavailable") }
  }

  missing(ids: readonly string[]): string[] {
    return this.db.query<{ id: string }, [string]>(`
      SELECT value AS id FROM json_each(?) WHERE value NOT IN (SELECT id FROM note_catalog)
    `).all(JSON.stringify(ids)).map((row) => row.id)
  }

  page(cwd: string, limit: number, cursor?: CatalogCursor): CatalogCursor[] {
    return this.db.query<CatalogCursor, [string, string | null, string | null, string | null, string | null, number]>(`
      SELECT id, time FROM note_catalog WHERE cwd = ?
      AND (? IS NULL OR time < ? OR (time = ? AND id < ?))
      ORDER BY time DESC, id DESC LIMIT ?
    `).all(cwd, cursor?.time ?? null, cursor?.time ?? null,
      cursor?.time ?? null, cursor?.id ?? null, limit)
  }

  acknowledge(ids: readonly string[], at: string): void {
    this.db.query(`INSERT INTO note_receipts SELECT value, ? FROM json_each(?) WHERE true
      ON CONFLICT(note_id) DO UPDATE SET delivered_at = MIN(delivered_at, excluded.delivered_at)`)
      .run(at, JSON.stringify(ids))
  }

  receipts(ids: readonly string[]): Receipt[] {
    return this.db.query<Receipt, [string]>("SELECT * FROM note_receipts WHERE note_id IN (SELECT value FROM json_each(?))")
      .all(JSON.stringify(ids))
  }

  receiptPage(after: string, limit: number): Receipt[] {
    return this.db.query<Receipt, [string, number]>("SELECT * FROM note_receipts WHERE note_id > ? ORDER BY note_id LIMIT ?").all(after, limit)
  }

  delivered(findings: readonly Pick<Finding, "id" | "reopened_at">[]): string[] {
    return this.db.query<{ id: string }, [string]>(`
      SELECT DISTINCT s.finding_id AS id FROM finding_sources s JOIN note_receipts r ON r.note_id = s.note_id
      JOIN json_each(?) f ON s.finding_id = json_extract(f.value, '$.id')
      WHERE json_extract(f.value, '$.reopened_at') IS NULL OR s.time >= json_extract(f.value, '$.reopened_at')
    `).all(JSON.stringify(findings)).map((row) => row.id)
  }
}
