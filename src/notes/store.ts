import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rm,
} from "node:fs/promises"
import { join, parse } from "node:path"

import { redact, type Logger } from "../log"
import {
  isMissingFile,
  parseNote,
  parseStateSnapshot,
} from "./parse"
import { PendingQueue } from "./pending"
import { cwdKey, cwdParents } from "./paths"
import { FindingStore } from "./findings"
import { atomicWrite } from "./files"
import { DatabaseUnavailableError } from "./database-client"
import { deliveredFindingIDs } from "./delivery"
import { decideAdvice, findingIdentity, issueIdentity } from "../policy"
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
  readonly #log: Logger
  #closed = false

  constructor(options: NoteStoreOptions) {
    this.#dataDir = options.dataDir
    this.#log = options.log
    this.#clock = options.clock ?? (() => new Date())
    this.#random = options.random ?? Math.random
    this.#findings = new FindingStore(options.dataDir)
    this.#pending = new PendingQueue({
      dataDir: options.dataDir,
      log: options.log,
      readNote: (id) => this.#readNote(id),
      readForDelivery: (note, ttlMs) => this.readForDelivery(note.cwd, note.id, ttlMs),
    })
  }

  async writeNote(input: NoteInput): Promise<Note> {
    if (this.#closed) throw new Error("Note store closed")
    const time = this.#clock().toISOString()
    const stamp = time.slice(0, 19).replaceAll("-", "").replace("T", "-").replaceAll(":", "")
    const suffix = Math.floor(this.#random() * 0x1000000)
      .toString(16)
      .padStart(6, "0")
      .slice(-6)
    const safeInput: NoteInput = {
      ...input,
      reasoning: redact(input.reasoning),
      note: redact(input.note),
      evidence: input.evidence.map(redact),
      ...(input.failure === undefined ? {} : { failure: redact(input.failure) }),
      ...(input.location === undefined ? {} : { location: redact(input.location) }),
    }
    const note: Note = {
      ...safeInput,
      id: `${stamp}-${suffix}`,
      time,
      finding_id: findingIdentity(safeInput),
      issue_id: issueIdentity(safeInput),
    }
    const directory = join(this.#dataDir, "notes")
    await mkdir(directory, { recursive: true })
    const path = join(directory, `${note.id}.json`)
    await atomicWrite(path, JSON.stringify(note))
    try {
      await this.#findings.record(note)
    } catch (error) {
      if (!(error instanceof DatabaseUnavailableError)) await rm(path, { force: true })
      throw error
    }
    return note
  }

  async listFindings(cwd: string, rootSession?: string, query?: FindingQuery): Promise<Finding[]> {
    return this.#findings.list(cwd, rootSession, query)
  }

  deliveredFindingIDs(findings: readonly Finding[]): Promise<ReadonlySet<string>> {
    return deliveredFindingIDs(findings, (id) => this.#readNote(id))
  }

  close(): Promise<void> {
    this.#closed = true
    return this.#findings.close()
  }

  async readNotes(cwd: string, rootSession: string, ids: readonly string[]): Promise<Note[]> {
    const notes = await Promise.all(ids.map((id) => this.#readNote(id)))
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
    const note = await this.#readNote(noteID)
    if (note === undefined || !cwdParents(cwd).includes(note.cwd)) return { status: "missing" }
    if (note.delivered_at !== undefined) return { status: "delivered" }
    if (note.expired_at !== undefined) return { status: "expired" }
    const finding = note.finding_id === undefined ? undefined :
      (await this.listFindings(note.cwd, note.root_session, { ids: [note.finding_id] })).find((entry) => entry.id === note.finding_id)
    if (decideAdvice(note, finding).attention === "none") return { status: "inactive" }
    if (finding !== undefined && (await this.deliveredFindingIDs([finding])).has(finding.id)) return { status: "duplicate" }
    const age = this.#clock().getTime() - Date.parse(note.time)
    if (!Number.isFinite(age) || age > ttlMs) {
      await atomicWrite(
        join(this.#dataDir, "notes", `${note.id}.json`),
        JSON.stringify({ ...note, expired_at: this.#clock().toISOString() } satisfies Note),
      )
      await this.removePending(note.cwd, [note.id])
      return { status: "expired" }
    }
    return { status: "ready", note }
  }

  async markDelivered(noteIDs: readonly string[], at: string): Promise<void> {
    await Promise.all(
      noteIDs.map(async (noteID) => {
        const note = await this.#readNote(noteID)
        if (note === undefined || note.delivered_at !== undefined || note.expired_at !== undefined) return
        await atomicWrite(
          join(this.#dataDir, "notes", `${noteID}.json`),
          JSON.stringify({ ...note, delivered_at: at } satisfies Note),
        )
        await this.removePending(note.cwd, [note.id])
      }),
    )
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
      return parseStateSnapshot(
        await readFile(join(this.#dataDir, "state", `${cwdKey(cwd)}.json`), "utf8"),
      )
    } catch (error) {
      if (isMissingFile(error)) return undefined
      throw error
    }
  }

  async listNotes(cwd: string, options: Readonly<{ last: number }>): Promise<Note[]> {
    let names: string[]
    try {
      names = await readdir(join(this.#dataDir, "notes"))
    } catch (error) {
      if (isMissingFile(error)) return []
      throw error
    }
    const notes = await Promise.all(
      names.filter((name) => name.endsWith(".json")).map((name) => this.#readNote(parse(name).name)),
    )
    return notes
      .filter((note): note is Note => note !== undefined)
      .filter((note) => note.cwd === cwd)
      .sort((left, right) => right.time.localeCompare(left.time))
      .slice(0, options.last)
  }

  async #readNote(noteID: string): Promise<Note | undefined> {
    if (!/^[a-zA-Z0-9_-]+$/.test(noteID)) return undefined
    try {
      const note = parseNote(await readFile(join(this.#dataDir, "notes", `${noteID}.json`), "utf8"))
      if (note === undefined) await this.#log.warn({ msg: "advisor note corrupt", noteID })
      return note
    } catch (error) {
      if (isMissingFile(error)) return undefined
      if (error instanceof SyntaxError) {
        await this.#log.warn({ msg: "advisor note corrupt", noteID, error })
        return undefined
      }
      throw error
    }
  }

}
