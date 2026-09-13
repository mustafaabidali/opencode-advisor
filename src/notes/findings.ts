import { acquireDatabase, DatabaseRequestNotSentError, DatabaseUnavailableError, type DatabaseHandle } from "./database-client"
import type { Arguments, Operation, Result } from "./database-protocol"
import type { DispositionInput, Finding, FindingQuery, Note, TaskSnapshot } from "./types"

/** Async interface: SQLite and lock waits run only in the database worker. */
export class FindingStore {
  #handle: DatabaseHandle | undefined
  #closed = false
  #closing: Promise<void> | undefined
  constructor(private readonly dataDir: string) {}

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
