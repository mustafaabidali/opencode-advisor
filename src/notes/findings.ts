import { acquireDatabase, DatabaseRequestNotSentError, DatabaseUnavailableError, type DatabaseHandle } from "./database-client"
import type { Arguments, Operation, Result } from "./database-protocol"
import type { DispositionInput, Finding, FindingQuery, Note, TaskSnapshot } from "./types"
import type { UsageAttempt, UsageCoverage, UsageRecord, UsageState } from "../usage/types"
import type { CatalogCursor } from "./catalog-database"
import type { JournalKey } from "../advisor/journal-data"

/** Async interface: SQLite and lock waits run only in the database worker. */
export class FindingStore {
  #handle: DatabaseHandle | undefined
  #closed = false
  #closing: Promise<void> | undefined
  constructor(private readonly dataDir: string) {}
  readJournal(key: JournalKey) { return this.#request("readJournal", [key]) }
  claimJournal(key: JournalKey, owner: string, pid: number, previous: string | null) {
    return this.#request("claimJournal", [key, owner, pid, previous])
  }
  saveJournal(key: JournalKey, owner: string, payload: string) { return this.#request("saveJournal", [key, owner, payload]) }
  releaseJournal(key: JournalKey, owner: string) { return this.#request("releaseJournal", [key, owner]) }

  beginUsage(attempt: UsageAttempt) { return this.#request("beginUsage", [attempt]) }
  getUsage(id: string) { return this.#request("getUsage", [id]) }
  usageForPass(id: string) { return this.#request("usageForPass", [id]) }
  findUsage(sessionID: string, created: number, parentID: string) {
    return this.#request("findUsage", [sessionID, created, parentID])
  }
  usagePrompt(id: string, promptID: string) { return this.#request("usagePrompt", [id, promptID]) }
  finishUsage(id: string, state: UsageState, time: number, coverage: UsageCoverage) {
    return this.#request("finishUsage", [id, state, time, coverage])
  }
  recordUsage(row: UsageRecord, authoritative = false) { return this.#request("recordUsage", [row, authoritative]) }
  usageSummary(cwd: string, rootSession?: string) { return this.#request("usageSummary", [cwd, rootSession]) }
  catalogProgress() { return this.#request("catalogProgress", []) }
  catalogMissing(ids: readonly string[]) { return this.#request("catalogMissing", [ids]) }
  catalogIndex(notes: readonly Note[], unavailable: readonly string[], cursor?: string, complete?: boolean) {
    return this.#request("catalogIndex", [notes, unavailable, cursor, complete])
  }
  catalogPage(cwd: string, limit: number, cursor?: CatalogCursor) { return this.#request("catalogPage", [cwd, limit, cursor]) }
  acknowledge(ids: readonly string[], at: string) { return this.#request("acknowledge", [ids, at]) }
  receipts(ids: readonly string[]) { return this.#request("receipts", [ids]) }
  receiptPage(after: string, limit: number) { return this.#request("receiptPage", [after, limit]) }
  delivered(findings: readonly Pick<Finding, "id" | "reopened_at">[]) { return this.#request("delivered", [findings]) }

  readTask(cwd: string, rootSession: string): Promise<TaskSnapshot | undefined> {
    return this.#request("readTask", [cwd, rootSession])
  }

  writeTask(cwd: string, rootSession: string, context: TaskSnapshot): Promise<void> {
    return this.#request("writeTask", [cwd, rootSession, context])
  }

  recordDispositions(cwd: string, rootSession: string, changes: readonly DispositionInput[], time: string): Promise<void> {
    return this.#request("recordDispositions", [cwd, rootSession, changes, time])
  }

  record(note: Note): Promise<void> {
    return this.#request("record", [note])
  }

  list(cwd: string, rootSession?: string, query?: FindingQuery): Promise<Finding[]> {
    if (!this.#closed && query !== undefined && "ids" in query && query.ids.length === 0) return Promise.resolve([])
    return this.#request("list", [cwd, rootSession, query])
  }

  close(): Promise<void> {
    if (this.#closing !== undefined) return this.#closing
    this.#closed = true
    const handle = this.#handle
    this.#handle = undefined
    return this.#closing = handle?.close() ?? Promise.resolve()
  }

  async #request<K extends Exclude<Operation, "close">>(operation: K, args: Arguments<K>): Promise<Result<K>> {
    if (this.#closed) throw new Error("Finding store closed")
    const handle = this.#handle ??= acquireDatabase(this.dataDir)
    try {
      return await handle.request(operation, args)
    } catch (error) {
      if ((error instanceof DatabaseUnavailableError || error instanceof DatabaseRequestNotSentError) && this.#handle === handle) {
        this.#handle = undefined
        // Preserve whether the write was uncertain or never posted; the next call gets a fresh worker.
        await handle.close().catch(() => {})
      }
      throw error
    }
  }
}
