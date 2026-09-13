import type { Database } from "bun:sqlite"
import type { UsageAttempt, UsageCoverage, UsageRecord, UsageState, UsageSummary, UsageTotals } from "./types"

const TOTALS = `COALESCE(SUM(cost), 0) AS cost, COUNT(*) AS messages,
  COALESCE(SUM(attempt_id IS NULL), 0) AS unattributed,
  COALESCE(SUM(unknown_usage), 0) AS unknown_usage,
  COALESCE(SUM(CASE WHEN summary = 1 THEN cost ELSE 0 END), 0) AS summary_cost,
  COALESCE(SUM(summary), 0) AS summary_messages,
  COALESCE(SUM(input), 0) AS input, COALESCE(SUM(output), 0) AS output,
  COALESCE(SUM(reasoning), 0) AS reasoning, COALESCE(SUM(cache_read), 0) AS cache_read,
  COALESCE(SUM(cache_write), 0) AS cache_write`

/** Owned by the existing SQLite worker; no database work runs in an event hook. */
export class UsageDatabase {
  constructor(private readonly db: Database) {
    db.transaction(() => db.exec(`
      CREATE TABLE IF NOT EXISTS usage_attempts (
        id TEXT PRIMARY KEY, pass_id TEXT NOT NULL, cwd TEXT NOT NULL, root_session TEXT NOT NULL,
        advisor_session TEXT NOT NULL, advisor_slug TEXT NOT NULL, model TEXT NOT NULL, variant TEXT NOT NULL,
        started_at INTEGER NOT NULL, settled_at INTEGER, prompt_id TEXT, state TEXT NOT NULL, coverage TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS usage_attempts_child ON usage_attempts(advisor_session, started_at DESC);
      CREATE INDEX IF NOT EXISTS usage_attempts_scope ON usage_attempts(cwd, root_session, advisor_slug);
      CREATE INDEX IF NOT EXISTS usage_attempts_pass ON usage_attempts(pass_id);
      CREATE TABLE IF NOT EXISTS usage_messages (
        message_id TEXT NOT NULL, advisor_session TEXT NOT NULL, cwd TEXT NOT NULL, root_session TEXT NOT NULL,
        advisor_slug TEXT NOT NULL, attempt_id TEXT, parent_id TEXT NOT NULL, created_at INTEGER NOT NULL,
        completed_at INTEGER, model TEXT NOT NULL, cost REAL NOT NULL,
        input REAL NOT NULL, output REAL NOT NULL, reasoning REAL NOT NULL,
        cache_read REAL NOT NULL, cache_write REAL NOT NULL, summary INTEGER NOT NULL,
        PRIMARY KEY(advisor_session, message_id)
      );
      CREATE INDEX IF NOT EXISTS usage_messages_scope ON usage_messages(cwd, root_session, advisor_slug);
      CREATE INDEX IF NOT EXISTS usage_messages_attempt ON usage_messages(attempt_id);
    `)).immediate()
    db.transaction(() => {
      const columns = db.query<{ name: string }, []>("PRAGMA table_info(usage_messages)").all()
      if (!columns.some((column) => column.name === "unknown_usage")) {
        db.exec("ALTER TABLE usage_messages ADD COLUMN unknown_usage INTEGER NOT NULL DEFAULT 0")
      }
    }).immediate()
  }

  begin(attempt: UsageAttempt): void {
    this.db.query("INSERT INTO usage_attempts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(attempt.id, attempt.pass_id, attempt.cwd, attempt.root_session, attempt.advisor_session,
        attempt.advisor_slug, attempt.model, attempt.variant, attempt.started_at, attempt.settled_at,
        attempt.prompt_id, attempt.state, attempt.coverage)
  }

  get(id: string): UsageAttempt | undefined {
    return this.db.query<UsageAttempt, [string]>("SELECT * FROM usage_attempts WHERE id = ?").get(id) ?? undefined
  }
  forPass(id: string): UsageAttempt[] {
    return this.db.query<UsageAttempt, [string]>("SELECT * FROM usage_attempts WHERE pass_id = ?").all(id)
  }

  find(sessionID: string, created: number, parentID = ""): UsageAttempt | undefined {
    return this.db.query<UsageAttempt, [string, string, number, number]>(`
      SELECT * FROM usage_attempts WHERE advisor_session = ?
      ORDER BY CASE WHEN prompt_id = ? THEN 0
        WHEN started_at <= ? AND (settled_at IS NULL OR settled_at >= ?) THEN 1 ELSE 2 END,
        started_at DESC, id DESC LIMIT 1
    `).get(sessionID, parentID, created, created) ?? undefined
  }

  prompt(id: string, promptID: string): void {
    this.db.query("UPDATE usage_attempts SET prompt_id = COALESCE(prompt_id, ?) WHERE id = ?").run(promptID, id)
  }

  finish(id: string, state: UsageState, time: number, coverage: UsageCoverage): void {
    this.db.query(`UPDATE usage_attempts SET state = ?, coverage = CASE WHEN coverage = 'complete' THEN coverage ELSE ? END,
      settled_at = CASE WHEN ? = 'cancellation_uncertain' THEN NULL ELSE
        MAX(?, COALESCE(settled_at, 0), COALESCE((SELECT MAX(COALESCE(completed_at, created_at))
        FROM usage_messages WHERE attempt_id = ?), ?)) END WHERE id = ? AND (state != 'completed' OR ? = 'completed')`)
      .run(state, coverage, state, time, id, time, id, state)
  }

  record(row: UsageRecord, authoritative: boolean): boolean {
    return this.db.transaction(() => {
      const previous = this.db.query<UsageRecord, [string, string]>(
        "SELECT * FROM usage_messages WHERE advisor_session = ? AND message_id = ?",
      ).get(row.advisor_session, row.message_id)
      const fields = ["cost", "input", "output", "reasoning", "cache_read", "cache_write"] as const
      if (!authoritative && previous?.completed_at != null && previous.unknown_usage === 0 && row.completed_at !== null &&
        fields.some((field) => previous[field] !== row[field])) {
        this.db.query("UPDATE usage_attempts SET coverage = 'partial' WHERE id = ?")
          .run(previous.attempt_id ?? row.attempt_id)
        return false
      }
      this.#write(row)
      return true
    }).immediate()
  }

  #write(row: UsageRecord): void {
    this.db.query(`INSERT INTO usage_messages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(advisor_session, message_id) DO UPDATE SET
        attempt_id = COALESCE(usage_messages.attempt_id, excluded.attempt_id),
        completed_at = excluded.completed_at, cost = excluded.cost,
        input = excluded.input, output = excluded.output, reasoning = excluded.reasoning,
        cache_read = excluded.cache_read, cache_write = excluded.cache_write, summary = excluded.summary,
        unknown_usage = excluded.unknown_usage
      WHERE usage_messages.completed_at IS NULL OR excluded.completed_at IS NOT NULL`)
      .run(row.message_id, row.advisor_session, row.cwd, row.root_session, row.advisor_slug,
        row.attempt_id, row.parent_id, row.created_at, row.completed_at, row.model,
        row.cost, row.input, row.output, row.reasoning, row.cache_read, row.cache_write, row.summary, row.unknown_usage)
  }

  summary(cwd: string, rootSession?: string): UsageSummary {
    return this.db.transaction((): UsageSummary => {
      const where = rootSession === undefined ? "cwd = ?" : "cwd = ? AND root_session = ?"
      const args = rootSession === undefined ? [cwd] : [cwd, rootSession]
      const totals = this.db.query<UsageTotals, string[]>(`SELECT ${TOTALS} FROM usage_messages WHERE ${where}`).get(...args)
      if (totals === null) throw new Error("Usage aggregate unavailable")
      const attempts = this.db.query<{ attempts: number; incomplete: number }, string[]>(
        `SELECT COUNT(*) AS attempts, COALESCE(SUM(coverage != 'complete'), 0) AS incomplete
         FROM usage_attempts WHERE ${where}`,
      ).get(...args)
      const byAdvisor = this.db.query<UsageTotals & { advisor_slug: string }, string[]>(
        `SELECT advisor_slug, ${TOTALS} FROM usage_messages WHERE ${where} GROUP BY advisor_slug`,
      ).all(...args)
      return { ...totals, attempts: attempts?.attempts ?? 0,
        coverage: attempts?.attempts === 0 ? "unknown" : attempts?.incomplete || totals.unattributed || totals.unknown_usage ? "partial" : "complete",
        by_advisor: byAdvisor }
    })()
  }
}
