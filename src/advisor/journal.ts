import { createHash, randomUUID } from "node:crypto"
import { FindingStore } from "../notes/findings"
import { EMPTY_JOURNAL, parseJournal, type JournalData, type JournalKey, type PendingPass } from "./journal-data"
import type { Cursor } from "../delta"

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH")
  }
}

export class ReviewJournal {
  readonly #store: FindingStore
  readonly #lanes = new Set<JournalLane>()
  #closing: Promise<void> | undefined
  #closed = false
  constructor(dataDir: string, readonly directory: string) { this.#store = new FindingStore(dataDir) }
  lane(root: string, slug: string, configuration: unknown): JournalLane {
    if (this.#closed) throw new Error("Advisor journal is closed")
    const lane = new JournalLane(this.#store, { cwd: this.directory, root_session: root, advisor_slug: slug },
      createHash("sha256").update(JSON.stringify(configuration)).digest("hex"), () => this.#lanes.delete(lane))
    this.#lanes.add(lane)
    return lane
  }
  close(): Promise<void> {
    this.#closed = true
    return this.#closing ??= (async () => {
      await Promise.all([...this.#lanes].map((lane) => lane.close()))
      await this.#store.close()
    })().catch((error: unknown) => { this.#closing = undefined; throw error })
  }
}

export class JournalLane {
  readonly #owner = randomUUID()
  #data: JournalData = EMPTY_JOURNAL
  #owned = false
  #closed = false
  #loading: Promise<boolean> | undefined
  #writing: Promise<void> = Promise.resolve()
  #closing: Promise<void> | undefined
  constructor(private readonly store: FindingStore, private readonly key: JournalKey, readonly fingerprint: string,
    private readonly onClosed: () => void = () => {}) {}
  get data(): JournalData { return this.#data }
  get compatible(): boolean { return this.#data.fingerprint === this.fingerprint }
  load(): Promise<boolean> {
    if (this.#closed) return Promise.resolve(false)
    if (this.#owned) return Promise.resolve(true)
    return this.#loading ??= this.#load().finally(() => { this.#loading = undefined })
  }
  async #load(): Promise<boolean> {
    const row = await this.store.readJournal(this.key)
    if (this.#closed || (row?.owner != null && row.owner !== this.#owner && row.pid !== null && alive(row.pid))) return false
    if (!await this.store.claimJournal(this.key, this.#owner, process.pid, row?.owner ?? null)) return false
    if (this.#closed) { await this.store.releaseJournal(this.key, this.#owner); return false }
    try {
      const current = await this.store.readJournal(this.key)
      if (current?.owner !== this.#owner) throw new Error("Advisor journal ownership changed")
      this.#data = parseJournal(current.payload)
      this.#owned = true
      return true
    } catch (error) {
      await this.store.releaseJournal(this.key, this.#owner)
      throw error
    }
  }
  begin(pending: PendingPass, generation: number): Promise<void> {
    return this.#save(() => ({ fingerprint: this.fingerprint,
      cursor: this.compatible ? this.#data.cursor : {}, generation, pending,
      ...(this.compatible && this.#data.content !== undefined ? { content: this.#data.content } : {}) }))
  }
  settle(id: string, cursor?: Cursor): Promise<void> {
    return this.#save(() => {
      if (this.#data.pending?.id !== id) return this.#data
      const { content: previousContent, ...previous } = this.#data
      const content = cursor === undefined ? (this.compatible ? previousContent : undefined) : this.#data.pending.content
      return { ...previous, fingerprint: this.fingerprint, cursor: cursor ?? (this.compatible ? previous.cursor : {}), pending: null,
        ...(content === undefined ? {} : { content }) }
    })
  }
  #save(next: () => JournalData): Promise<void> {
    const work = this.#writing.then(async () => {
      if (!this.#owned || this.#closed) throw new Error("Advisor journal ownership was released")
      // A previous reply may have been lost after commit. Read proof before another write.
      const stored = await this.store.readJournal(this.key)
      if (stored?.owner !== this.#owner) throw new Error("Advisor journal ownership changed")
      this.#data = parseJournal(stored.payload)
      const value = next()
      if (value === this.#data || JSON.stringify(value) === stored.payload) return
      if (!await this.store.saveJournal(this.key, this.#owner, JSON.stringify(value))) throw new Error("Advisor journal ownership changed")
      this.#data = value
    })
    this.#writing = work.catch(() => {})
    return work
  }
  close(): Promise<void> {
    this.#closed = true
    return this.#closing ??= this.#close().catch((error: unknown) => { this.#closing = undefined; throw error })
  }
  async #close(): Promise<void> {
    await this.#loading?.catch(() => {})
    await this.#writing
    if (this.#owned) await this.store.releaseJournal(this.key, this.#owner)
    this.#owned = false
    this.onClosed()
  }
}
