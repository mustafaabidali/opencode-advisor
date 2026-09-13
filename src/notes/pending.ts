import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

import type { Logger } from "../log"
import { isMissingFile, parsePendingPointer, type PendingPointer } from "./parse"
import { cwdKey, cwdParents } from "./paths"
import type { DeliveryNote, Note } from "./types"

type LocatedPointer = Readonly<{ key: string; name: string; pointer: PendingPointer }>
type ClaimOptions = Readonly<{ ttlMs: number; noteID?: string }>

export class PendingQueue {
  constructor(private readonly options: Readonly<{
    dataDir: string
    log: Logger
    readNote: (id: string) => Promise<Note | undefined>
    readForDelivery: (note: Note, ttlMs: number) => Promise<DeliveryNote>
  }>) {}

  async enqueue(cwd: string, noteIDs: readonly string[]): Promise<void> {
    const directory = join(this.options.dataDir, "pending", cwdKey(cwd))
    await mkdir(directory, { recursive: true })
    for (const noteID of noteIDs) {
      const note = await this.options.readNote(noteID)
      if (note === undefined) continue
      await writeFile(
        join(directory, `${noteID}.json`),
        JSON.stringify({ noteID, time: note.time } satisfies PendingPointer),
        "utf8",
      )
    }
  }

  async claim(cwd: string, options: ClaimOptions): Promise<Note[]> {
    for (const candidate of cwdParents(cwd)) {
      const claimed = await this.#claimKey(cwdKey(candidate), options)
      if (claimed.length > 0) return claimed
    }
    const newest = await this.#newestPendingKey()
    return newest === undefined ? [] : this.#claimKey(newest, options)
  }

  async remove(cwd: string, noteIDs: readonly string[]): Promise<void> {
    const directory = join(this.options.dataDir, "pending", cwdKey(cwd))
    await Promise.all(noteIDs.map((id) => rm(join(directory, `${id}.json`), { force: true })))
  }

  async #claimKey(key: string, options: ClaimOptions): Promise<Note[]> {
    const pointers = (await this.#readPointers(key)).filter(
      (located) => options.noteID === undefined || located.pointer.noteID === options.noteID,
    )
    const claimed: Note[] = []
    for (const located of pointers.sort((a, b) => a.pointer.time.localeCompare(b.pointer.time))) {
      const source = join(this.options.dataDir, "pending", key, located.name)
      const note = await this.options.readNote(located.pointer.noteID)
      const ready = note === undefined ? undefined : await this.options.readForDelivery(note, options.ttlMs)
      if (ready?.status !== "ready") {
        await rm(source, { force: true })
        if (ready?.status === "expired") await this.options.log.warn({
          msg: "discarding stale pending pointer",
          noteID: located.pointer.noteID,
          cwdKey: key,
        })
        continue
      }
      const claimedDirectory = join(this.options.dataDir, "claimed", key)
      await mkdir(claimedDirectory, { recursive: true })
      try {
        await rename(source, join(claimedDirectory, located.name))
      } catch (error) {
        if (isMissingFile(error)) continue
        throw error
      }
      claimed.push(ready.note)
    }
    return claimed
  }

  async #readPointers(key: string): Promise<LocatedPointer[]> {
    const directory = join(this.options.dataDir, "pending", key)
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
        await this.options.log.warn({ msg: "discarding corrupt pending pointer", path })
      }
    }
    return pointers
  }

  async #newestPendingKey(): Promise<string | undefined> {
    let keys: string[]
    try {
      keys = await readdir(join(this.options.dataDir, "pending"))
    } catch (error) {
      if (isMissingFile(error)) return undefined
      throw error
    }
    const groups = await Promise.all(keys.map((key) => this.#readPointers(key)))
    return groups.flat().sort((left, right) => right.pointer.time.localeCompare(left.pointer.time))[0]?.key
  }
}
