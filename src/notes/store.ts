import {
  appendFile,
  mkdir,
  readFile,
  rm,
} from "node:fs/promises"
import { join } from "node:path"

import {
  isMissingFile,
  parseStateSnapshot,
} from "./parse"
import { PendingQueue } from "./pending"
import { cwdKey, cwdParents } from "./paths"
import { FindingStore } from "./findings"
import { atomicWrite } from "./files"
import { DatabaseUnavailableError } from "./database-client"
import { withUsage } from "../usage/status"
import { decideAdvice } from "../policy"
import { ReportFiles } from "./report-files"
import { NoteCatalog } from "./catalog"
import type {
  Note,
  DeliveryNote,
  Finding,
  FindingQuery,
  DispositionInput,
  TaskSnapshot,
  NoteInput,
  NoteStoreOptions,
  StateSnapshot,
  TranscriptRecord,
} from "./types"

export class NoteStore {
  readonly #dataDir: string
  readonly #clock: () => Date
  readonly #random: () => number
  readonly #pending: PendingQueue
  readonly #findings: FindingStore
  readonly #files: ReportFiles
  readonly #catalog: NoteCatalog
  #closed = false

  constructor(options: NoteStoreOptions) {
    this.#dataDir = options.dataDir
    this.#clock = options.clock ?? (() => new Date())
    this.#random = options.random ?? Math.random
    this.#findings = new FindingStore(options.dataDir)
    this.#files = new ReportFiles(options.dataDir, options.log)
    this.#catalog = new NoteCatalog(this.#findings, this.#files, options.log)
    this.#pending = new PendingQueue({
      dataDir: options.dataDir,
      log: options.log,
      readNote: (id) => this.#files.read(id),
      readForDelivery: (note, ttlMs) => this.readForDelivery(note.cwd, note.id, ttlMs),
    })
  }

  async writeNote(input: NoteInput): Promise<Note> {
    if (this.#closed) throw new Error("Note store closed")
    const { note, created } = await this.#files.create(input, this.#clock().toISOString(), this.#random())
    try {
      await this.#findings.record(note)
    } catch (error) {
      if (created && !(error instanceof DatabaseUnavailableError)) await rm(this.#files.path(note.id), { force: true })
      throw error
    }
    return note
  }
  async recoverNote(input: NoteInput): Promise<Note | undefined> {
    const id = this.#files.identity(input)
    if (id === undefined) return undefined
    const note = await this.#files.read(id)
    if (note === undefined || note.finding_id === undefined) return undefined
    const findings = await this.#findings.list(input.cwd, input.root_session, { ids: [note.finding_id] })
    return findings.some((finding) => finding.provenance.some((source) => source.note_id === id)) ? note : undefined
  }

  async listFindings(cwd: string, rootSession?: string, query?: FindingQuery): Promise<Finding[]> {
    return this.#findings.list(cwd, rootSession, query)
  }

  deliveredFindingIDs(findings: readonly Finding[]): Promise<ReadonlySet<string>> {
    return this.#catalog.delivered(findings)
  }
  get metrics() { return { note_reads: this.#files.reads } }
  backfillNotes(limit?: number) { return this.#catalog.backfill(limit) }
  catalogStatus() { return this.#findings.catalogProgress() }
  repairReceipts() { return this.#catalog.repair() }

  close(): Promise<void> {
    this.#closed = true
    return this.#findings.close()
  }

  async readNotes(cwd: string, rootSession: string, ids: readonly string[]): Promise<Note[]> {
    const notes = await Promise.all(ids.map((id) => this.#files.read(id)))
    return notes.filter((note): note is Note =>
      note !== undefined && note.cwd === cwd && note.root_session === rootSession)
  }

  async recordDispositions(cwd: string, rootSession: string, changes: readonly DispositionInput[]): Promise<void> {
    await this.#findings.recordDispositions(cwd, rootSession, changes, this.#clock().toISOString())
  }

  async readTask(cwd: string, rootSession: string): Promise<TaskSnapshot | undefined> {
    return this.#findings.readTask(cwd, rootSession)
  }

  async writeTask(cwd: string, rootSession: string, context: TaskSnapshot): Promise<void> {
    await this.#findings.writeTask(cwd, rootSession, context)
  }

  async enqueuePending(cwd: string, noteIDs: readonly string[]): Promise<void> {
    await this.#pending.enqueue(cwd, noteIDs)
  }

  async claimPending(
    cwd: string,
    options: Readonly<{ ttlMs: number; noteID?: string }>,
  ): Promise<Note[]> {
    return this.#pending.claim(cwd, options)
  }

  async removePending(cwd: string, noteIDs: readonly string[]): Promise<void> {
    await this.#pending.remove(cwd, noteIDs)
  }

  async readForDelivery(cwd: string, noteID: string, ttlMs: number): Promise<DeliveryNote> {
    const note = await this.#files.read(noteID)
    if (note === undefined || !cwdParents(cwd).includes(note.cwd)) return { status: "missing" }
    if (note.delivered_at !== undefined || (await this.#findings.receipts([noteID])).length > 0) return { status: "delivered" }
    if (note.expired_at !== undefined) return { status: "expired" }
    const finding = note.finding_id === undefined ? undefined :
      (await this.listFindings(note.cwd, note.root_session, { ids: [note.finding_id] })).find((entry) => entry.id === note.finding_id)
    if (decideAdvice(note, finding).attention === "none") return { status: "inactive" }
    if (finding !== undefined && (await this.deliveredFindingIDs([finding])).has(finding.id)) return { status: "duplicate" }
    const age = this.#clock().getTime() - Date.parse(note.time)
    if (!Number.isFinite(age) || age > ttlMs) {
      await this.#files.mirror(note, { expired_at: this.#clock().toISOString() })
      await this.removePending(note.cwd, [note.id])
      return { status: "expired" }
    }
    return { status: "ready", note }
  }

  async markDelivered(noteIDs: readonly string[], at: string): Promise<void> {
    const notes = await this.#catalog.acknowledge(noteIDs, at)
    await Promise.all(notes.map((note) => this.removePending(note.cwd, [note.id])))
  }

  async appendTranscript(rootSession: string, record: TranscriptRecord): Promise<void> {
    const directory = join(this.#dataDir, "transcripts")
    await mkdir(directory, { recursive: true })
    await appendFile(join(directory, `${rootSession}.jsonl`), `${JSON.stringify(record)}\n`, "utf8")
  }

  async writeState(cwd: string, snapshot: StateSnapshot): Promise<void> {
    const directory = join(this.#dataDir, "state")
    await mkdir(directory, { recursive: true })
    await atomicWrite(join(directory, `${cwdKey(cwd)}.json`), JSON.stringify(snapshot))
  }

  async readState(cwd: string): Promise<StateSnapshot | undefined> {
    try {
      const snapshot = parseStateSnapshot(
        await readFile(join(this.#dataDir, "state", `${cwdKey(cwd)}.json`), "utf8"),
      )
      return snapshot === undefined ? undefined : withUsage(snapshot, await this.#findings.usageSummary(cwd))
    } catch (error) {
      if (isMissingFile(error)) {
        const accounting = await this.#findings.usageSummary(cwd)
        return accounting.attempts === 0 ? undefined :
          { advisors: [], watched_sessions: [], updated_at: this.#clock().toISOString(), accounting }
      }
      throw error
    }
  }

  async listNotes(cwd: string, options: Readonly<{ last: number }>): Promise<Note[]> {
    return this.#catalog.list(cwd, options.last)
  }
}
