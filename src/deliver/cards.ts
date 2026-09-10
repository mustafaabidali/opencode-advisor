import type { Event } from "@opencode-ai/sdk"

import type { AdvisorConfig } from "../config"
import type { Logger } from "../log"
import type { Note, NoteStore } from "../notes"
import { showNoteToast, showToast, type ToastClient } from "./toast"
import {
  BlockerTransformer,
  type MessagesTransformOutput,
  type PendingBlocker,
  type SystemTransformInput,
  type SystemTransformOutput,
} from "./transform"

type ClientResult = Readonly<{
  data: unknown
  error: unknown
  response: Pick<Response, "ok" | "status">
}>

type ShellRequest = Readonly<{
  path: Readonly<{ id: string }>
  query: Readonly<{ directory: string }>
  body: Readonly<{ agent: "advisor-delivery"; command: string }>
}>

export type DeliveryClient = Readonly<{
  session: Readonly<{
    shell: (request: ShellRequest) => Promise<ClientResult>
    abort: (request: Readonly<{ path: Readonly<{ id: string }> }>) => Promise<ClientResult>
  }>
  tui: ToastClient
}>

export type DeliveryStore = Pick<NoteStore, "enqueuePending" | "markDelivered" | "removePending">

export type DelivererOptions = Readonly<{
  config: Pick<AdvisorConfig, "toast" | "abort_on_blocker" | "note_ttl_turns">
  store: DeliveryStore
  log: Logger
  client: DeliveryClient
  directory: string
  clock: () => number
  isWatched: (sessionID: string) => boolean
  suppress: (sessionID: string, milliseconds: number) => void
}>

type QueuedCards = {
  notes: Note[]
  attempts: number
}

export class Deliverer {
  readonly #options: DelivererOptions
  readonly #transformer: BlockerTransformer
  readonly #lastStatus = new Map<string, "idle" | "busy" | "retry">()
  readonly #queued = new Map<string, QueuedCards>()
  readonly #flushing = new Set<string>()

  constructor(options: DelivererOptions) {
    this.#options = options
    this.#transformer = new BlockerTransformer({
      noteTtlTurns: options.config.note_ttl_turns,
      clock: options.clock,
      isWatched: options.isWatched,
    })
  }

  get pendingBlockers(): Map<string, PendingBlocker[]> {
    return this.#transformer.pendingBlockers
  }

  get compacting(): Set<string> {
    return this.#transformer.compacting
  }

  async deliver(watchedID: string, notes: readonly Note[]): Promise<void> {
    if (notes.length === 0) return
    const blockers = notes.filter((entry) => entry.severity === "blocker")
    this.#transformer.add(watchedID, blockers)
    if (blockers.length > 0 && this.#options.config.abort_on_blocker) {
      await this.#abort(watchedID)
    }
    if (this.#options.config.toast) {
      await Promise.all(
        notes.map((entry) => showNoteToast(this.#options.client.tui, this.#options.log, entry)),
      )
    }

    const noteIDs = notes.map((entry) => entry.id)
    await this.#options.store.enqueuePending(this.#options.directory, noteIDs)
    const queued = this.#queued.get(watchedID) ?? { notes: [], attempts: 0 }
    const known = new Set(queued.notes.map((entry) => entry.id))
    queued.notes.push(...notes.filter((entry) => !known.has(entry.id)))
    this.#queued.set(watchedID, queued)
    await this.#options.log.info({
      msg: "advisor card queued",
      sessionID: watchedID,
      noteIDs,
      status: this.#lastStatus.get(watchedID),
    })
    if (this.#lastStatus.get(watchedID) === "idle") await this.flushOnIdle(watchedID)
  }

  async onEvent(event: Event): Promise<void> {
    switch (event.type) {
      case "session.status":
        this.#lastStatus.set(event.properties.sessionID, event.properties.status.type)
        if (event.properties.status.type === "idle") {
          await this.flushOnIdle(event.properties.sessionID)
        }
        return
      case "session.compacted":
        this.#transformer.clearSession(event.properties.sessionID)
        return
      default:
        return
    }
  }

  async flushOnIdle(sessionID: string): Promise<void> {
    const queued = this.#queued.get(sessionID)
    if (queued === undefined || this.#flushing.has(sessionID)) return
    this.#flushing.add(sessionID)
    this.#lastStatus.set(sessionID, "busy")
    try {
      for (let current = queued.notes[0]; current !== undefined; current = queued.notes[0]) {
        this.#options.suppress(sessionID, 3000)
        const messageID = await this.#shell(sessionID, current)
        queued.notes.shift()
        await this.#recordDelivered(sessionID, current, messageID)
      }
      this.#queued.delete(sessionID)
    } catch (error) {
      await this.#deliveryFailed(sessionID, queued, error)
    } finally {
      this.#flushing.delete(sessionID)
    }
  }

  async #shell(sessionID: string, note: Note): Promise<string | undefined> {
    const result = await this.#options.client.session.shell({
      path: { id: sessionID },
      query: { directory: this.#options.directory },
      body: { agent: "advisor-delivery", command: `advisor --note ${note.id}` },
    })
    const info =
      typeof result.data === "object" && result.data !== null && "info" in result.data
        ? result.data.info
        : result.data
    if (!result.response.ok || result.error !== undefined || info === undefined) {
      throw result.error ?? new Error(`advisor shell returned ${result.response.status}`)
    }
    return typeof info === "object" && info !== null && "id" in info && typeof info.id === "string"
      ? info.id
      : undefined
  }

  async #recordDelivered(sessionID: string, note: Note, messageID: string | undefined): Promise<void> {
    const pendingBlockers = this.#transformer.pendingBlockers.get(sessionID)
    const clearedBlocker = pendingBlockers?.some((entry) => entry.note.id === note.id) === true
    this.#transformer.removeDelivered(sessionID, [note.id])
    try {
      await this.#options.store.markDelivered([note.id], new Date(this.#options.clock()).toISOString())
    } catch (error) {
      await this.#options.log.warn({ msg: "advisor card bookkeeping failed", sessionID, noteIDs: [note.id], error })
      return
    }
    await this.#options.log.info({
      msg: "advisor card delivered",
      sessionID,
      noteIDs: [note.id],
      ...(messageID === undefined ? {} : { messageID }),
    })
    if (clearedBlocker) {
      await this.#options.log.info({ msg: "blocker cleared after card", sessionID, noteIDs: [note.id] })
    }
  }

  markCompacting(sessionID: string): void {
    this.#transformer.compacting.add(sessionID)
  }

  clearCompacting(sessionID: string): void {
    this.#transformer.compacting.delete(sessionID)
  }

  async messagesTransform(output: MessagesTransformOutput): Promise<void> {
    this.#transformer.messagesTransform(output)
  }

  async systemTransform(
    input: SystemTransformInput,
    output: SystemTransformOutput,
  ): Promise<void> {
    this.#transformer.systemTransform(input, output)
  }

  async #abort(sessionID: string): Promise<void> {
    try {
      const result = await this.#options.client.session.abort({ path: { id: sessionID } })
      if (!result.response.ok || result.error !== undefined) {
        await this.#options.log.warn({ msg: "advisor blocker abort failed", sessionID })
      }
    } catch (error) {
      await this.#options.log.warn({ msg: "advisor blocker abort failed", sessionID, error })
    }
  }

  async #deliveryFailed(sessionID: string, queued: QueuedCards, error: unknown): Promise<void> {
    queued.attempts += 1
    await this.#options.log.warn({
      msg: "advisor card delivery failed",
      sessionID,
      attempt: queued.attempts,
      error,
    })
    if (queued.attempts < 3) return
    const ids = queued.notes.map((entry) => entry.id)
    await this.#options.store.removePending(this.#options.directory, ids)
    this.#queued.delete(sessionID)
    await showToast(this.#options.client.tui, this.#options.log, {
      title: "Advisor · warning",
      message: "Advisor card delivery failed - see advisor notes",
      variant: "warning",
      duration: 8000,
    })
  }
}

export type { MessagesTransformOutput, SystemTransformInput, SystemTransformOutput }
