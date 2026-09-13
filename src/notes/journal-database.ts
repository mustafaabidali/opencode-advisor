import type { Database } from "bun:sqlite"
import { EMPTY_JOURNAL, type JournalKey, type JournalRow } from "../advisor/journal-data"

/** A lane's owner is distinct from optional provider admission; no time-based takeover. */
export class JournalDatabase {
  constructor(private readonly db: Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS review_journal (
      cwd TEXT NOT NULL, root_session TEXT NOT NULL, advisor_slug TEXT NOT NULL,
      owner TEXT, pid INTEGER, payload TEXT NOT NULL, PRIMARY KEY(cwd, root_session, advisor_slug)
    )`)
  }
  read(key: JournalKey): JournalRow | undefined {
    return this.db.query<JournalRow, string[]>(
      "SELECT * FROM review_journal WHERE cwd = ? AND root_session = ? AND advisor_slug = ?",
    ).get(key.cwd, key.root_session, key.advisor_slug) ?? undefined
  }
  claim(key: JournalKey, owner: string, pid: number, previous: string | null): boolean {
    return this.db.query(`INSERT INTO review_journal VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(cwd, root_session, advisor_slug) DO UPDATE SET owner = excluded.owner, pid = excluded.pid
      WHERE review_journal.owner IS ?`).run(key.cwd, key.root_session, key.advisor_slug,
        owner, pid, JSON.stringify(EMPTY_JOURNAL), previous).changes === 1
  }
  save(key: JournalKey, owner: string, payload: string): boolean {
    return this.db.query(`UPDATE review_journal SET payload = ? WHERE
      cwd = ? AND root_session = ? AND advisor_slug = ? AND owner = ?`)
      .run(payload, key.cwd, key.root_session, key.advisor_slug, owner).changes === 1
  }
  release(key: JournalKey, owner: string): void {
    this.db.query(`UPDATE review_journal SET owner = NULL, pid = NULL WHERE
      cwd = ? AND root_session = ? AND advisor_slug = ? AND owner = ?`)
      .run(key.cwd, key.root_session, key.advisor_slug, owner)
  }
}
