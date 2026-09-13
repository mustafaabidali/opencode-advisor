import type { Event, Message, Part } from "@opencode-ai/sdk"
import type { TranscriptMessage } from "../delta"
import { projectMessage, projectPart } from "./projection"

type Entry = {
  generation: number; bytes: number; loadedAt: number
  messages?: Map<string, TranscriptMessage> | undefined
  weights: Map<string, number>; dirty: Set<string>
  view?: readonly TranscriptMessage[] | undefined
  loading?: Promise<readonly TranscriptMessage[]> | undefined
}
type Options = Readonly<{
  read: (sessionID: string) => Promise<readonly TranscriptMessage[]>
  message?: (sessionID: string, messageID: string) => Promise<TranscriptMessage | undefined>
  clock?: () => number
  maxRoots?: number
  maxBytes?: number
  maxSessionBytes?: number
  refreshMs?: number
}>

/** Shared bounded event projection. Checkpoints request an authoritative refresh explicitly. */
export class SessionHistory {
  readonly #entries = new Map<string, Entry>()
  #fullReads = 0
  #pointReads = 0
  #cacheHits = 0
  #invalidations = 0
  readonly #clock: () => number
  constructor(private readonly options: Options) { this.#clock = options.clock ?? Date.now }
  get metrics() {
    return { full_reads: this.#fullReads, message_reads: this.#pointReads, cache_hits: this.#cacheHits,
      invalidations: this.#invalidations, roots: this.#entries.size,
      retained_bytes: [...this.#entries.values()].reduce((sum, entry) => sum + entry.bytes, 0) }
  }
  forget(id: string): void { this.#entries.delete(id) }
  clear(): void { this.#entries.clear() }
  invalidate(id: string): void {
    const entry = this.#entries.get(id)
    if (entry !== undefined) this.#invalidate(entry)
  }
  #invalidate(entry: Entry): void {
    entry.generation++
    entry.messages = undefined
    entry.view = undefined
    entry.weights.clear()
    entry.dirty.clear()
    entry.bytes = 0
    this.#invalidations++
  }
  read(id: string, fresh = false): Promise<readonly TranscriptMessage[]> {
    let entry = this.#entries.get(id)
    if (entry === undefined) entry = { generation: 0, bytes: 0, loadedAt: 0, weights: new Map(), dirty: new Set() }
    this.#entries.delete(id)
    this.#entries.set(id, entry)
    if (fresh && entry.loading !== undefined) {
      const current = entry
      return entry.loading.then(() => {
        if (this.#entries.get(id) !== current) throw new Error("Advisor history released during read")
        return this.read(id, true)
      })
    }
    if (fresh || (entry.messages !== undefined && this.#clock() - entry.loadedAt > (this.options.refreshMs ?? 30_000))) this.#invalidate(entry)
    if (entry.loading !== undefined) return entry.loading
    if (entry.messages !== undefined && entry.dirty.size === 0) {
      this.#cacheHits++
      entry.view ??= Object.freeze([...entry.messages.values()]
        .sort((a, b) => a.info.time.created - b.info.time.created || a.info.id.localeCompare(b.info.id)))
      return Promise.resolve(entry.view)
    }
    const state = entry
    const loading = this.#load(id, state).finally(() => {
      if (state.loading === loading) state.loading = undefined
      this.#trim()
    })
    state.loading = loading
    return loading
  }
  async #load(id: string, entry: Entry): Promise<readonly TranscriptMessage[]> {
    let generation = entry.generation
    let messages: readonly TranscriptMessage[]
    if (entry.messages === undefined || entry.dirty.size > 32 || this.options.message === undefined) {
      this.#fullReads++
      messages = await this.options.read(id)
    } else {
      const updated = new Map(entry.messages)
      for (const messageID of [...entry.dirty]) {
        this.#pointReads++
        const value = await this.options.message(id, messageID)
        if (value === undefined || value.info.id !== messageID || value.info.sessionID !== id) {
          this.#invalidate(entry)
          break
        }
        updated.set(messageID, value)
      }
      if (generation === entry.generation) messages = [...updated.values()]
      else {
        generation = entry.generation
        this.#fullReads++
        messages = await this.options.read(id)
      }
    }
    if (this.#entries.get(id) !== entry) throw new Error("Advisor history released during read")
    const view = Object.freeze(messages.map(projectMessage)
      .sort((a, b) => a.info.time.created - b.info.time.created || a.info.id.localeCompare(b.info.id)))
    // A server snapshot is useful even while the next step streams. Events after
    // its sampling point prevent caching; they must not force a retry storm.
    if (generation !== entry.generation) {
      this.#invalidate(entry)
      return view
    }
    entry.messages = new Map(view.map((message) => [message.info.id, message]))
    entry.weights = new Map(view.map((message) => [message.info.id, Buffer.byteLength(JSON.stringify(message))]))
    entry.bytes = [...entry.weights.values()].reduce((sum, size) => sum + size, 0)
    entry.view = view
    entry.dirty.clear()
    entry.loadedAt = this.#clock()
    if (entry.bytes > (this.options.maxSessionBytes ?? 2 * 1024 * 1024) || view.length > 2048) this.#invalidate(entry)
    return view
  }
  observe(event: Event): void {
    switch (event.type) {
      case "server.connected":
        for (const entry of this.#entries.values()) this.#invalidate(entry)
        return
      case "session.deleted": return this.forget(event.properties.info.id)
      case "session.compacted": return this.invalidate(event.properties.sessionID)
      case "message.updated": return this.message(event.properties.info)
      case "message.part.updated": return this.part(event.properties.part)
      case "message.removed": return this.invalidate(event.properties.sessionID)
      case "message.part.removed": return this.invalidate(event.properties.sessionID)
    }
  }
  message(info: Message, parts?: readonly Part[]): void {
    const entry = this.#entries.get(info.sessionID)
    if (entry === undefined) return
    entry.generation++
    if (entry.messages === undefined) return
    const previous = entry.messages.get(info.id)
    this.#put(entry, projectMessage({ info, parts: parts ?? previous?.parts ?? [] }))
    if (parts === undefined && (info.role === "user" || info.time.completed !== undefined)) entry.dirty.add(info.id)
  }
  part(part: Part): void {
    const entry = this.#entries.get(part.sessionID)
    if (entry === undefined) return
    entry.generation++
    const message = entry.messages?.get(part.messageID)
    if (message === undefined) { this.#invalidate(entry); return }
    const parts = [...message.parts]
    const index = parts.findIndex((item) => item.id === part.id)
    if (index === -1) parts.push(projectPart(part))
    else parts[index] = projectPart(part)
    this.#put(entry, Object.freeze({ info: message.info, parts: Object.freeze(parts) }))
  }
  #put(entry: Entry, message: TranscriptMessage): void {
    const size = Buffer.byteLength(JSON.stringify(message))
    entry.bytes += size - (entry.weights.get(message.info.id) ?? 0)
    entry.weights.set(message.info.id, size)
    entry.messages?.set(message.info.id, message)
    entry.view = undefined
    if (entry.bytes > (this.options.maxSessionBytes ?? 2 * 1024 * 1024) || (entry.messages?.size ?? 0) > 2048) {
      this.#invalidate(entry)
    }
    this.#trim()
  }
  #trim(): void {
    let bytes = this.metrics.retained_bytes
    for (const [id, entry] of this.#entries) {
      if (this.#entries.size <= (this.options.maxRoots ?? 200) && bytes <= (this.options.maxBytes ?? 16 * 1024 * 1024)) break
      if (entry.loading !== undefined) continue
      this.#entries.delete(id)
      bytes -= entry.bytes
    }
  }
}
