import { openDatabase } from "./schema"
import { readFindings } from "./queries"
import type { DispositionInput, Finding, FindingQuery, Note, TaskSnapshot } from "./types"
import { UsageDatabase } from "../usage/database"
import type { UsageAttempt, UsageCoverage, UsageRecord, UsageState } from "../usage/types"
import { CatalogDatabase, type CatalogCursor } from "./catalog-database"
import { JournalDatabase } from "./journal-database"
import type { JournalKey } from "../advisor/journal-data"

type FindingRow = Omit<Finding, "provenance" | "disposition" | "verification" | "reopened_at">
type TaskRow = { task_id: string; revision: string; user_message_id: string | null; stopped: number; next_action: string | null }

/** Synchronous implementation, owned exclusively by the database worker. */
export class FindingDatabase {
  readonly #db
  readonly #usage
  readonly #catalog
  readonly #journal
  constructor(dataDir: string) {
    this.#db = openDatabase(dataDir)
    this.#usage = new UsageDatabase(this.#db)
    this.#catalog = new CatalogDatabase(this.#db)
    this.#journal = new JournalDatabase(this.#db)
  }
  close(): void { this.#db.close(true) }
  readJournal(key: JournalKey) { return this.#journal.read(key) }
  claimJournal(key: JournalKey, owner: string, pid: number, previous: string | null) { return this.#journal.claim(key, owner, pid, previous) }
  saveJournal(key: JournalKey, owner: string, payload: string) { return this.#journal.save(key, owner, payload) }
  releaseJournal(key: JournalKey, owner: string) { return this.#journal.release(key, owner) }

  beginUsage(attempt: UsageAttempt): void { this.#usage.begin(attempt) }
  getUsage(id: string) { return this.#usage.get(id) }
  usageForPass(id: string) { return this.#usage.forPass(id) }
  findUsage(sessionID: string, created: number, parentID: string) { return this.#usage.find(sessionID, created, parentID) }
  usagePrompt(id: string, promptID: string): void { this.#usage.prompt(id, promptID) }
  finishUsage(id: string, state: UsageState, time: number, coverage: UsageCoverage): void {
    this.#usage.finish(id, state, time, coverage)
  }
  recordUsage(row: UsageRecord, authoritative: boolean): boolean { return this.#usage.record(row, authoritative) }
  usageSummary(cwd: string, rootSession?: string) { return this.#usage.summary(cwd, rootSession) }
  catalogProgress() { return this.#catalog.progress() }
  catalogMissing(ids: readonly string[]) { return this.#catalog.missing(ids) }
  catalogIndex(notes: readonly Note[], unavailable: readonly string[], cursor?: string, complete?: boolean) {
    this.#catalog.indexBatch(notes, unavailable, cursor, complete)
  }
  catalogPage(cwd: string, limit: number, cursor?: CatalogCursor) { return this.#catalog.page(cwd, limit, cursor) }
  acknowledge(ids: readonly string[], at: string) { this.#catalog.acknowledge(ids, at) }
  receipts(ids: readonly string[]) { return this.#catalog.receipts(ids) }
  receiptPage(after: string, limit: number) { return this.#catalog.receiptPage(after, limit) }
  delivered(findings: readonly Pick<Finding, "id" | "reopened_at">[]) { return this.#catalog.delivered(findings) }

  readTask(cwd: string, rootSession: string): TaskSnapshot | undefined {
    const row = this.#db.query<TaskRow, [string, string]>(
      "SELECT task_id, revision, user_message_id, stopped, next_action FROM task_context WHERE cwd = ? AND root_session = ?",
    ).get(cwd, rootSession)
    return row === null ? undefined : {
      task_id: row.task_id, revision: row.revision, stopped: row.stopped === 1,
      ...(row.user_message_id === null ? {} : { user_message_id: row.user_message_id }),
      ...(row.next_action === null ? {} : { next_action: row.next_action }),
    }
  }

  writeTask(cwd: string, rootSession: string, context: TaskSnapshot): void {
    this.#db.query(`INSERT INTO task_context VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(cwd, root_session) DO UPDATE SET task_id = excluded.task_id,
      revision = excluded.revision, user_message_id = excluded.user_message_id,
      stopped = excluded.stopped, next_action = excluded.next_action`)
      .run(cwd, rootSession, context.task_id, context.revision, context.user_message_id ?? null,
        context.stopped ? 1 : 0, context.next_action ?? null)
  }

  recordDispositions(cwd: string, rootSession: string, changes: readonly DispositionInput[], time: string): void {
    const db = this.#db
    db.transaction(() => {
      for (const change of changes) {
        const row = db.query<FindingRow, [string, string, string, string]>(`
          SELECT * FROM findings WHERE cwd = ? AND root_session = ? AND (
            id = ? OR id = (SELECT finding_id FROM finding_sources WHERE note_id = ?)
          )
        `).get(cwd, rootSession, change.id, change.id)
        if (row === null) throw new Error(`Unknown finding in this session: ${change.id}`)
        if (row.reviewed_revision !== change.reviewed_revision || row.version !== change.version) {
          throw new Error(`Finding changed; recheck ${change.id}`)
        }
        const evidence = (change.evidence ?? []).map((item) => item.trim()).filter(Boolean)
        if (change.reason.trim() === "") throw new Error("A disposition needs a reason")
        if ((change.state === "resolved" || (change.state === "open" && row.state !== "open")) && evidence.length === 0) {
          throw new Error("Resolving or reopening a finding requires checked evidence")
        }
        if (change.verification !== undefined && evidence.length === 0) {
          throw new Error("Verification requires checked evidence")
        }
        db.query("UPDATE findings SET state = ?, updated_at = ?, version = version + 1 WHERE id = ?").run(change.state, time, row.id)
        db.query(`
          INSERT INTO finding_dispositions (finding_id, state, reason, reviewed_revision, evidence, time)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(row.id, change.state, change.reason, change.reviewed_revision, JSON.stringify(evidence), time)
        if (change.verification !== undefined && change.state === "open") {
          const proof = change.verification
          db.query(`INSERT INTO finding_verifications VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(finding_id) DO UPDATE SET revision = excluded.revision,
            evidence = excluded.evidence, in_scope = excluded.in_scope,
            affected_action = excluded.affected_action, cost_if_delayed = excluded.cost_if_delayed`)
            .run(row.id, proof.revision, JSON.stringify(evidence), proof.in_scope ? 1 : 0,
              proof.affected_action ?? null, proof.cost_if_delayed ?? null)
        } else if (change.state !== "open" || row.state !== "open") {
          db.query("DELETE FROM finding_verifications WHERE finding_id = ?").run(row.id)
        }
      }
    }).immediate()
  }

  record(note: Note): void {
    const id = note.finding_id
    const db = this.#db
    db.transaction(() => {
      this.#catalog.index(note)
      if (id === undefined) return
      const revision = note.review?.revision ?? "unversioned"
      db.query(`
        INSERT INTO findings (id, issue_id, cwd, root_session, task_id, reviewed_revision, state, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'open', ?)
        ON CONFLICT(id) DO UPDATE SET updated_at = MAX(updated_at, excluded.updated_at)
      `).run(id, note.issue_id ?? id, note.cwd, note.root_session, note.review?.task_id ?? note.root_session, revision, note.time)
      db.query("INSERT OR IGNORE INTO finding_sources VALUES (?, ?, ?, ?, ?, ?)")
        .run(note.id, id, note.advisor_slug, note.model, note.time, revision)
    }).immediate()
  }

  list(cwd: string, rootSession?: string, query?: FindingQuery): Finding[] {
    return readFindings(this.#db, cwd, rootSession, query)
  }
}
