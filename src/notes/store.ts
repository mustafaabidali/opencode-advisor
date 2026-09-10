import { createHash } from "node:crypto"
import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises"
import { dirname, join, parse } from "node:path"

import { redact } from "../log"
import {
  isMissingFile,
  parseNote,
  parsePendingPointer,
  parseStateSnapshot,
  type PendingPointer,
} from "./parse"
import type {
  Note,
  NoteInput,
  NoteStoreOptions,
  StateSnapshot,
  TranscriptRecord,
} from "./types"

type LocatedPointer = Readonly<{
  key: string
  name: string
  pointer: PendingPointer
}>

export class NoteStore {
  readonly #dataDir: string
  readonly #log: NoteStoreOptions["log"]
  readonly #clock: () => Date
  readonly #random: () => number

  constructor(options: NoteStoreOptions) {
    this.#dataDir = options.dataDir
    this.#log = options.log
    this.#clock = options.clock ?? (() => new Date())
    this.#random = options.random ?? Math.random
  }

  async writeNote(input: NoteInput): Promise<Note> {
    const time = this.#clock().toISOString()
    const stamp = time.slice(0, 19).replaceAll("-", "").replace("T", "-").replaceAll(":", "")
    const suffix = Math.floor(this.#random() * 0x1000000)
      .toString(16)
      .padStart(6, "0")
      .slice(-6)
    const note: Note = {
      ...input,
      reasoning: redact(input.reasoning),
      note: redact(input.note),
      id: `${stamp}-${suffix}`,
      time,
    }
    const directory = join(this.#dataDir, "notes")
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, `${note.id}.json`), JSON.stringify(note), "utf8")
    return note
  }

  async enqueuePending(cwd: string, noteIDs: readonly string[]): Promise<void> {
    const key = this.#cwdKey(cwd)
    const directory = join(this.#dataDir, "pending", key)
    await mkdir(directory, { recursive: true })
    for (const noteID of noteIDs) {
      const note = await this.#readNote(noteID)
      if (note === undefined) continue
      await writeFile(
        join(directory, `${noteID}.json`),
        JSON.stringify({ noteID, time: note.time } satisfies PendingPointer),
        "utf8",
      )
    }
  }

  async claimPending(
    cwd: string,
    options: Readonly<{ ttlMs: number; noteID?: string }>,
  ): Promise<Note[]> {
    for (const candidate of this.#cwdParents(cwd)) {
      const claimed = await this.#claimKey(this.#cwdKey(candidate), options)
      if (claimed.length > 0) return claimed
    }
    const newest = await this.#newestPendingKey()
    return newest === undefined ? [] : this.#claimKey(newest, options)
  }

  async removePending(cwd: string, noteIDs: readonly string[]): Promise<void> {
    const directory = join(this.#dataDir, "pending", this.#cwdKey(cwd))
    await Promise.all(noteIDs.map((id) => rm(join(directory, `${id}.json`), { force: true })))
  }

  async markDelivered(noteIDs: readonly string[], at: string): Promise<void> {
    await Promise.all(
      noteIDs.map(async (noteID) => {
        const note = await this.#readNote(noteID)
        if (note === undefined) return
        await writeFile(
          join(this.#dataDir, "notes", `${noteID}.json`),
          JSON.stringify({ ...note, delivered_at: at } satisfies Note),
          "utf8",
        )
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
    await writeFile(join(directory, `${this.#cwdKey(cwd)}.json`), JSON.stringify(snapshot), "utf8")
  }

  async readState(cwd: string): Promise<StateSnapshot | undefined> {
    try {
      return parseStateSnapshot(
        await readFile(join(this.#dataDir, "state", `${this.#cwdKey(cwd)}.json`), "utf8"),
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

  async #claimKey(
    key: string,
    options: Readonly<{ ttlMs: number; noteID?: string }>,
  ): Promise<Note[]> {
    const pointers = (await this.#readPointers(key)).filter(
      (located) => options.noteID === undefined || located.pointer.noteID === options.noteID,
    )
    const claimed: Note[] = []
    for (const located of pointers.sort((a, b) => a.pointer.time.localeCompare(b.pointer.time))) {
      const source = join(this.#dataDir, "pending", key, located.name)
      if (this.#clock().getTime() - Date.parse(located.pointer.time) > options.ttlMs) {
        await rm(source, { force: true })
        await this.#log.warn({
          msg: "discarding stale pending pointer",
          noteID: located.pointer.noteID,
          cwdKey: key,
        })
        continue
      }
      const claimedDirectory = join(this.#dataDir, "claimed", key)
      await mkdir(claimedDirectory, { recursive: true })
      try {
        await rename(source, join(claimedDirectory, located.name))
      } catch (error) {
        if (isMissingFile(error)) continue
        throw error
      }
      const note = await this.#readNote(located.pointer.noteID)
      if (note !== undefined) claimed.push(note)
    }
    return claimed
  }

  async #readPointers(key: string): Promise<LocatedPointer[]> {
    const directory = join(this.#dataDir, "pending", key)
    let names: string[]
    try {
      names = await readdir(directory)
    } catch (error) {
      if (isMissingFile(error)) return []
      throw error
    }
    const pointers: LocatedPointer[] = []
    for (const name of names.filter((entry) => entry.endsWith(".json"))) {
      const path = join(directory, name)
      try {
        const pointer = parsePendingPointer(await readFile(path, "utf8"))
        if (pointer === undefined) throw new SyntaxError("invalid pending pointer")
        pointers.push({ key, name, pointer })
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error
        await rm(path, { force: true })
        await this.#log.warn({ msg: "discarding corrupt pending pointer", path })
      }
    }
    return pointers
  }

  async #newestPendingKey(): Promise<string | undefined> {
    let keys: string[]
    try {
      keys = await readdir(join(this.#dataDir, "pending"))
    } catch (error) {
      if (isMissingFile(error)) return undefined
      throw error
    }
    const groups = await Promise.all(keys.map((key) => this.#readPointers(key)))
    return groups
      .flat()
      .sort((left, right) => right.pointer.time.localeCompare(left.pointer.time))[0]?.key
  }

  async #readNote(noteID: string): Promise<Note | undefined> {
    try {
      return parseNote(await readFile(join(this.#dataDir, "notes", `${noteID}.json`), "utf8"))
    } catch (error) {
      if (isMissingFile(error)) return undefined
      throw error
    }
  }

  #cwdKey(cwd: string): string {
    return createHash("sha1").update(cwd).digest("hex")
  }

  #cwdParents(cwd: string): readonly string[] {
    const parents: string[] = []
    let current = cwd
    while (true) {
      parents.push(current)
      const parent = dirname(current)
      if (parent === current) return parents
      current = parent
    }
  }
}
