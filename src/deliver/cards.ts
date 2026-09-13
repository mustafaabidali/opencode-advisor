import type { Event, UserMessage } from "@opencode-ai/sdk"

import { partitionBySeverity, type SeverityFloors } from "../advice"
import type { Finding, Note } from "../notes"
import { decideAdvice, uniqueFindings } from "../policy"
import { showNoteToast } from "./toast"
import { CardQueue } from "./queue"
import type { DelivererOptions } from "./types"
export type { DelivererOptions, DeliveryClient, DeliveryStore } from "./types"
import { DeliveryTurns } from "./turns"
import { advisorHistoryIDs, pruneAdvisorHistory } from "./history"
import {
  BlockerTransformer,
  type MessagesTransformOutput,
  type PendingBlocker,
  type SystemTransformInput,
  type SystemTransformOutput,
} from "./transform"

export class Deliverer {
  readonly #options: DelivererOptions
  readonly #transformer: BlockerTransformer
  readonly #turns = new DeliveryTurns()
  readonly #queue: CardQueue

  constructor(options: DelivererOptions) {
    this.#options = options
    this.#transformer = new BlockerTransformer({
      noteTtlTurns: options.config.note_ttl_turns,
      clock: options.clock,
      isWatched: options.isWatched,
    })
    this.#queue = new CardQueue(options, this.#turns, this.#transformer, async (note) => {
      const findings = await this.#findings(note.root_session, [note])
      return this.#decisions(note.root_session, [note], findings)[0]?.eligible === true
    })
  }

  get pendingBlockers(): Map<string, PendingBlocker[]> {
    return this.#transformer.pendingBlockers
  }

  get compacting(): Set<string> {
    return this.#transformer.compacting
  }

  #floorsFor(advisorSlug: string): SeverityFloors {
    return this.#options.floors?.(advisorSlug) ?? this.#options.config
  }

  async deliver(watchedID: string, notes: readonly Note[]): Promise<void> {
    if (!this.#options.isWatched(watchedID)) return
    notes = uniqueFindings(notes)
    const findings = await this.#findings(watchedID, notes)
    const delivered = await this.#options.store.deliveredFindingIDs(findings)
    if (!this.#options.isWatched(watchedID)) return
    const assessed = this.#decisions(watchedID, notes, findings, delivered)
    const inactive = assessed.filter((entry) => !entry.eligible)
    if (inactive.length > 0) {
      await this.#options.log.info({
        msg: "advisor note withheld",
        sessionID: watchedID,
        notes: inactive.map((entry) => ({ noteID: entry.note.id, reason: entry.reason })),
      })
    }
    if (!this.#options.isWatched(watchedID)) return
    notes = assessed.filter((entry) => entry.eligible).map((entry) => entry.note)
    if (notes.length === 0) return
    const { chat: chatNotes, withheld, injected } = partitionBySeverity(notes, (slug) => this.#floorsFor(slug))
    this.#transformer.add(watchedID, injected)
    if (this.#options.config.toast) {
      await Promise.all(
        notes.map((entry) => showNoteToast(this.#options.client.tui, this.#options.log, entry)),
      )
    }
    if (withheld.length > 0) {
      await this.#options.log.info({
        msg: "advisor card withheld",
        sessionID: watchedID,
        noteIDs: withheld.map((entry) => entry.id),
      })
    }
    if (chatNotes.length === 0) return

    await this.#queue.enqueue(watchedID, chatNotes)
  }

  onUserMessage(info: UserMessage): void {
    this.#turns.user(info)
  }

  async onEvent(event: Event): Promise<void> {
    this.#turns.event(event)
    switch (event.type) {
      case "session.status":
        if (event.properties.status.type === "idle") {
          await this.flushOnIdle(event.properties.sessionID)
        }
        return
      case "message.updated":
        if (event.properties.info.role === "assistant" && event.properties.info.time.completed !== undefined) {
          await this.flushOnIdle(event.properties.info.sessionID)
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
    await this.#queue.flushOnIdle(sessionID)
  }

  markCompacting(sessionID: string): void {
    this.#transformer.compacting.add(sessionID)
  }

  clearCompacting(sessionID: string): void {
    this.#transformer.compacting.delete(sessionID)
  }

  async messagesTransform(output: MessagesTransformOutput): Promise<void> {
    const sessionID = output.messages[0]?.info.sessionID
    if (sessionID !== undefined && this.#options.isWatched(sessionID)) {
      const pending = this.pendingBlockers.get(sessionID) ?? []
      const findings = await this.#options.store.listFindings(this.#options.directory, sessionID, {
        ids: [...advisorHistoryIDs(output), ...pending.map((entry) => entry.note.id)],
      })
      const pendingIDs = new Set(pending.map((entry) => entry.note.finding_id))
      const delivered = await this.#options.store.deliveredFindingIDs(findings.filter((finding) => pendingIDs.has(finding.id)))
      pruneAdvisorHistory(output, findings, this.#options.context?.(sessionID) ?? {})
      const assessed = this.#decisions(sessionID, pending.map((entry) => entry.note), findings, delivered)
      this.#transformer.removeDelivered(sessionID, assessed.filter((entry) => !entry.eligible).map((entry) => entry.note.id))
      this.#transformer.messagesTransform(output, new Set(assessed.map((entry) => entry.note.id)))
      return
    }
    this.#transformer.messagesTransform(output)
  }

  async #findings(sessionID: string, notes: readonly Note[]) {
    if (notes.length === 0) return []
    return this.#options.store.listFindings(this.#options.directory, sessionID, {
      ids: notes.map((note) => note.id),
    })
  }

  #decisions(sessionID: string, notes: readonly Note[], findings: readonly Finding[], delivered: ReadonlySet<string> = new Set()) {
    const byID = new Map(findings.map((entry) => [entry.id, entry]))
    const context = this.#options.context?.(sessionID)
    return notes.map((note) => {
      const decision = decideAdvice(note, byID.get(note.finding_id ?? ""), context)
      const shown = note.delivered_at !== undefined || delivered.has(note.finding_id ?? "")
      return { note, eligible: decision.attention !== "none" && !shown, reason: shown ? "already_delivered" : decision.reason }
    })
  }

  async systemTransform(
    input: SystemTransformInput,
    output: SystemTransformOutput,
  ): Promise<void> {
    this.#transformer.systemTransform(input, output)
  }

}

export type { MessagesTransformOutput, SystemTransformInput, SystemTransformOutput }
