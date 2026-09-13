import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { join } from "node:path"

/** Called only by the database worker when opening a connection. */
export function openDatabase(dataDir: string): Database {
  mkdirSync(dataDir, { recursive: true })
  const db = new Database(join(dataDir, "findings.sqlite"), { create: true })
  try {
    db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON")
    db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS findings (
          id TEXT PRIMARY KEY, issue_id TEXT NOT NULL, cwd TEXT NOT NULL, root_session TEXT NOT NULL,
          task_id TEXT NOT NULL, reviewed_revision TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0,
          state TEXT NOT NULL CHECK(state IN ('open', 'resolved', 'dismissed', 'deferred')),
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS finding_sources (
          note_id TEXT PRIMARY KEY, finding_id TEXT NOT NULL REFERENCES findings(id),
          advisor_slug TEXT NOT NULL, model TEXT NOT NULL, time TEXT NOT NULL, reviewed_revision TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS finding_dispositions (
          seq INTEGER PRIMARY KEY AUTOINCREMENT, finding_id TEXT NOT NULL REFERENCES findings(id),
          state TEXT NOT NULL, reason TEXT NOT NULL, reviewed_revision TEXT NOT NULL,
          evidence TEXT NOT NULL, time TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS finding_verifications (
          finding_id TEXT PRIMARY KEY REFERENCES findings(id), revision TEXT NOT NULL,
          evidence TEXT NOT NULL, in_scope INTEGER NOT NULL, affected_action TEXT, cost_if_delayed TEXT
        );
        CREATE TABLE IF NOT EXISTS task_context (
          cwd TEXT NOT NULL, root_session TEXT NOT NULL, task_id TEXT NOT NULL,
          revision TEXT NOT NULL, user_message_id TEXT, stopped INTEGER NOT NULL,
          next_action TEXT, PRIMARY KEY (cwd, root_session)
        );
      `)
      const columns = db.query<{ name: string }, []>("PRAGMA table_info(findings)").all()
      if (!columns.some((column) => column.name === "issue_id")) {
        db.exec("ALTER TABLE findings ADD COLUMN issue_id TEXT; UPDATE findings SET issue_id = id WHERE issue_id IS NULL")
      }
      if (!columns.some((column) => column.name === "version")) {
        db.exec("ALTER TABLE findings ADD COLUMN version INTEGER NOT NULL DEFAULT 0")
      }
      db.exec(`
        CREATE INDEX IF NOT EXISTS findings_scope_updated ON findings(cwd, root_session, updated_at DESC);
        CREATE INDEX IF NOT EXISTS findings_scope_issue ON findings(cwd, root_session, issue_id);
        CREATE INDEX IF NOT EXISTS sources_finding_time ON finding_sources(finding_id, time, note_id);
        CREATE INDEX IF NOT EXISTS dispositions_finding_seq ON finding_dispositions(finding_id, seq DESC);
      `)
    }).immediate()
    return db
  } catch (error) {
    db.close()
    throw error
  }
}
