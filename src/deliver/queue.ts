import type { Note } from "../notes"
import { findingKey, uniqueFindings } from "../policy"
import { receiptDiagnostic, renderedMessageID } from "./receipt"
import { showToast } from "./toast"
import type { BlockerTransformer } from "./transform"
import type { DeliveryTurns } from "./turns"
import type { DelivererOptions } from "./types"

type QueuedCards = {
  notes: Note[]
  attempts: number
}

export class CardQueue {
  readonly #queued = new Map<string, QueuedCards>()
  readonly #flushing = new Set<string>()
  readonly #enqueuing = new Map<string, Promise<void>>()

  constructor(
    private readonly options: DelivererOptions,
    private readonly turns: DeliveryTurns,
    private readonly transformer: BlockerTransformer,
    private readonly eligible: (note: Note) => Promise<boolean>,
  ) {}

  async enqueue(watchedID: string, notes: readonly Note[]): Promise<void> {
    const previous = this.#enqueuing.get(watchedID) ?? Promise.resolve()
    const appended = previous.catch(() => {}).then(() => this.#append(watchedID, notes))
    this.#enqueuing.set(watchedID, appended)
    try {
      await appended
    } finally {
      if (this.#enqueuing.get(watchedID) === appended) this.#enqueuing.delete(watchedID)
    }
    if (this.turns.canDeliver(watchedID)) await this.flushOnIdle(watchedID)
  }

  async #append(watchedID: string, notes: readonly Note[]): Promise<void> {
    if (!this.options.isWatched(watchedID)) return
    const known = new Set(this.#queued.get(watchedID)?.notes.map(findingKey))
    const selected = uniqueFindings(notes).filter((note) => !known.has(findingKey(note)))
    if (selected.length === 0) return
    const noteIDs = selected.map((note) => note.id)
    try {
      await this.options.store.enqueuePending(this.options.directory, noteIDs)
    } catch (error) {
      await this.options.store.removePending(this.options.directory, noteIDs)
      throw error
    }
    if (!this.options.isWatched(watchedID)) {
      await this.options.store.removePending(this.options.directory, noteIDs)
      return
    }
    const queued = this.#queued.get(watchedID) ?? { notes: [], attempts: 0 }
    queued.notes.push(...selected)
    this.#queued.set(watchedID, queued)
    await this.options.log.info({
      msg: "advisor card queued",
      sessionID: watchedID,
      noteIDs,
      status: this.turns.status(watchedID),
    })
  }

  async flushOnIdle(sessionID: string): Promise<void> {
    const queued = this.#queued.get(sessionID)
    if (queued === undefined || this.#flushing.has(sessionID) ||
      !this.options.isWatched(sessionID) || !this.turns.canDeliver(sessionID)) return
    const epoch = this.turns.epoch(sessionID)
    this.#flushing.add(sessionID)
    try {
      for (let current = queued.notes[0]; current !== undefined; current = queued.notes[0]) {
        if (!this.options.isWatched(sessionID) || !this.turns.canDeliver(sessionID, epoch)) return
        if (!await this.eligible(current)) {
          queued.notes.shift()
          this.transformer.removeDelivered(sessionID, [current.id])
          await this.options.store.removePending(this.options.directory, [current.id])
          await this.options.log.info({ msg: "advisor card withheld after revalidation", sessionID, noteIDs: [current.id] })
          continue
        }
        const prepared = await this.options.store.readForDelivery(
          this.options.directory, current.id, this.options.config.pending_ttl_ms,
        )
        if (prepared.status === "missing") throw new Error(`advisor note unavailable: ${current.id}`)
        if (prepared.status !== "ready") {
          queued.notes.shift()
          this.transformer.removeDelivered(sessionID, [current.id])
          await this.options.store.removePending(this.options.directory, [current.id])
          await this.options.log.info({ msg: "advisor card skipped", sessionID, noteIDs: [current.id], status: prepared.status })
          continue
        }
        if (!this.options.isWatched(sessionID) || !this.turns.canDeliver(sessionID, epoch)) return
        if (this.options.client.renderNote === undefined) this.options.suppress(sessionID, 3000)
        let messageID: string | undefined
        const usesShell = this.options.client.renderNote === undefined
        if (usesShell) this.turns.rendering(sessionID, true)
        try {
          messageID = this.options.client.renderNote === undefined
            ? await this.#shell(sessionID, current)
            : await this.options.client.renderNote({
                note: current,
                directory: this.options.directory,
                canRender: () => this.options.isWatched(sessionID) && this.turns.canDeliver(sessionID, epoch),
              })
        } finally {
          if (usesShell) this.turns.rendering(sessionID, false)
        }
        if (messageID === undefined) return
        queued.notes.shift()
        queued.attempts = 0
        await this.#recordDelivered(sessionID, current, messageID)
      }
      this.#queued.delete(sessionID)
    } catch (error) {
      await this.#deliveryFailed(sessionID, queued, error)
    } finally {
      this.#flushing.delete(sessionID)
      if (epoch !== this.turns.epoch(sessionID) && this.turns.canDeliver(sessionID)) {
        await this.flushOnIdle(sessionID)
      }
    }
  }

  async #shell(sessionID: string, note: Note): Promise<string | undefined> {
    const command = `advisor --note ${note.id}`
    const result = await this.options.client.session.shell({
      path: { id: sessionID },
      query: { directory: this.options.directory },
      body: { agent: "advisor-delivery", command },
    })
    if (!result.response.ok || result.error !== undefined) {
      throw result.error ?? new Error(`advisor shell returned ${result.response.status}`)
    }
    try {
      return renderedMessageID(result.data, note, command)
    } catch (error) {
      await this.options.log.warn({
        msg: "advisor render receipt rejected", sessionID, noteID: note.id,
        command, directory: this.options.directory, diagnostic: receiptDiagnostic(result.data),
      })
      throw error
    }
  }

  async #recordDelivered(sessionID: string, note: Note, messageID: string | undefined): Promise<void> {
    const pendingBlockers = this.transformer.pendingBlockers.get(sessionID)
    const clearedBlocker = pendingBlockers?.some((entry) => entry.note.id === note.id) === true
    this.transformer.removeDelivered(sessionID, [note.id])
    try {
      await this.options.store.markDelivered([note.id], new Date(this.options.clock()).toISOString())
    } catch (error) {
      await this.options.log.warn({ msg: "advisor card bookkeeping failed", sessionID, noteIDs: [note.id], error })
      return
    }
    await this.options.log.info({
      msg: "advisor card delivered",
      sessionID,
      noteIDs: [note.id],
      ...(messageID === undefined ? {} : { messageID }),
    })
    if (clearedBlocker) {
      await this.options.log.info({ msg: "advisor injection cleared after card", sessionID, noteIDs: [note.id], severity: note.severity })
    }
  }

  async #deliveryFailed(sessionID: string, queued: QueuedCards, error: unknown): Promise<void> {
    queued.attempts += 1
    await this.options.log.warn({
      msg: "advisor card delivery failed",
      sessionID,
      attempt: queued.attempts,
      error,
    })
    if (queued.attempts < 3) return
    const ids = queued.notes.map((entry) => entry.id)
    await this.options.store.removePending(this.options.directory, ids)
    this.#queued.delete(sessionID)
    if (!this.options.config.toast) return
    await showToast(this.options.client.tui, this.options.log, {
      title: "Advisor · warning",
      message: "Advisor card delivery failed - see advisor notes",
      variant: "warning",
      duration: 8000,
    })
  }
}
