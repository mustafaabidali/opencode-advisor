import type { Message, Part, TextPart, UserMessage } from "@opencode-ai/sdk"

import type { Note } from "../notes"
import { findingKey, uniqueFindings } from "../policy"
import { renderNoteInjection, ROOT_STANDING_RULE } from "../prompts"

export type PendingBlocker = {
  readonly note: Note
  anchorUserMessageID?: string
  turnsSeen: number
  lastAnchorSeen?: string
}

export type MessagesTransformOutput = {
  messages: Array<{ info: Message; parts: Part[] }>
}

export type SystemTransformInput = Readonly<{
  sessionID?: string
}>

export type SystemTransformOutput = {
  system: string[]
}

export type BlockerTransformerOptions = Readonly<{
  noteTtlTurns: number
  clock: () => number
  isWatched: (sessionID: string) => boolean
}>

function isRealUser(message: MessagesTransformOutput["messages"][number]): message is {
  info: UserMessage
  parts: Part[]
} {
  return (
    message.info.role === "user" &&
    message.info.agent !== "advisor-delivery" &&
    !message.info.id.startsWith("adv_")
  )
}

function lastRealUser(messages: MessagesTransformOutput["messages"]): UserMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message !== undefined && isRealUser(message)) return message.info
  }
  return undefined
}

export class BlockerTransformer {
  readonly pendingBlockers = new Map<string, PendingBlocker[]>()
  readonly compacting = new Set<string>()
  readonly #noteTtlTurns: number
  readonly #clock: () => number
  readonly #isWatched: (sessionID: string) => boolean

  constructor(options: BlockerTransformerOptions) {
    this.#noteTtlTurns = options.noteTtlTurns
    this.#clock = options.clock
    this.#isWatched = options.isWatched
  }

  add(sessionID: string, notes: readonly Note[]): void {
    if (notes.length === 0) return
    const current = this.pendingBlockers.get(sessionID) ?? []
    const prior = new Map(current.map((entry) => [findingKey(entry.note), entry]))
    const unique = uniqueFindings([...current.map((entry) => entry.note), ...notes])
    this.pendingBlockers.set(sessionID, unique.map((note) => ({
      ...(prior.get(findingKey(note)) ?? { turnsSeen: 0 }), note,
    })))
  }

  removeDelivered(sessionID: string, noteIDs: readonly string[]): void {
    const current = this.pendingBlockers.get(sessionID)
    if (current === undefined) return
    const delivered = new Set(noteIDs)
    const remaining = current.filter((entry) => !delivered.has(entry.note.id))
    if (remaining.length === 0) this.pendingBlockers.delete(sessionID)
    else this.pendingBlockers.set(sessionID, remaining)
  }

  clearSession(sessionID: string): void {
    this.pendingBlockers.delete(sessionID)
    this.compacting.delete(sessionID)
  }

  messagesTransform(output: MessagesTransformOutput, assessedIDs?: ReadonlySet<string>): void {
    // OpenCode keeps its own reference to this array and converts it for the
    // model after the hook returns, so every change must happen in place.
    for (let index = output.messages.length - 1; index >= 0; index -= 1) {
      if (output.messages[index]?.info.id.startsWith("adv_") === true) output.messages.splice(index, 1)
    }
    const sessionID = output.messages[0]?.info.sessionID
    if (
      sessionID === undefined ||
      !this.#isWatched(sessionID) ||
      this.compacting.has(sessionID)
    ) {
      return
    }
    const blockers = this.pendingBlockers.get(sessionID)
    const latestUser = lastRealUser(output.messages)
    if (blockers === undefined || latestUser === undefined) return

    const active: PendingBlocker[] = []
    for (const blocker of blockers) {
      // Arrivals outside this read's snapshot stay queued for the next assessment.
      if (assessedIDs !== undefined && !assessedIDs.has(blocker.note.id)) {
        active.push(blocker)
        continue
      }
      if (blocker.lastAnchorSeen === undefined) blocker.lastAnchorSeen = latestUser.id
      else if (blocker.lastAnchorSeen !== latestUser.id) {
        blocker.turnsSeen += 1
        blocker.lastAnchorSeen = latestUser.id
      }
      if (blocker.turnsSeen >= this.#noteTtlTurns) continue

      const messageID = `adv_${blocker.note.id}`
      const existingIndex = output.messages.findIndex((message) => message.info.id === messageID)
      if (existingIndex >= 0) output.messages.splice(existingIndex, 1)

      if (blocker.anchorUserMessageID === undefined) blocker.anchorUserMessageID = latestUser.id
      let anchorIndex = output.messages.findIndex(
        (message) => isRealUser(message) && message.info.id === blocker.anchorUserMessageID,
      )
      if (anchorIndex < 0) {
        blocker.anchorUserMessageID = latestUser.id
        anchorIndex = output.messages.findIndex(
          (message) => isRealUser(message) && message.info.id === latestUser.id,
        )
      }
      if (anchorIndex < 0) continue

      const info = {
        id: messageID,
        sessionID,
        role: "user",
        time: { created: this.#clock() },
        agent: latestUser.agent,
        model: latestUser.model,
      } satisfies UserMessage
      const part = {
        id: `advp_${blocker.note.id}`,
        sessionID,
        messageID,
        type: "text",
        text: renderNoteInjection(
          blocker.note,
          blocker.note.model_display,
          blocker.note.variant,
        ),
        synthetic: true,
      } satisfies TextPart
      output.messages.splice(anchorIndex, 0, { info, parts: [part] })
      active.push(blocker)
    }
    if (active.length === 0) this.pendingBlockers.delete(sessionID)
    else this.pendingBlockers.set(sessionID, active)
  }

  systemTransform(input: SystemTransformInput, output: SystemTransformOutput): void {
    if (
      input.sessionID !== undefined &&
      this.#isWatched(input.sessionID) &&
      !output.system.includes(ROOT_STANDING_RULE)
    ) {
      output.system.push(ROOT_STANDING_RULE)
    }
  }
}
