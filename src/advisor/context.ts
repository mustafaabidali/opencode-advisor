import type { UserMessage } from "@opencode-ai/sdk"
import { isDeliveryMessage, type TranscriptMessage } from "../delta"
import type { NoteStore, ReviewContext, TaskSnapshot } from "../notes"
import type { AdviceContext } from "../policy"
import { reviewedRevision } from "./revision"

export class TaskContexts {
  readonly #states = new Map<string, TaskSnapshot>()
  readonly #users = new Map<string, string>()
  readonly #userTimes = new Map<string, number>()
  readonly #saved = new Map<string, string>()
  readonly #work = new Map<string, { active: boolean; tail: Promise<void> }>()

  constructor(
    private readonly store: Pick<NoteStore, "readTask" | "writeTask">,
    private readonly directory: string,
  ) {}

  user(info: UserMessage): void {
    if (info.agent?.startsWith("advisor-") || info.id.startsWith("adv_")) return
    if (this.#users.get(info.sessionID) === info.id) return
    if (info.time.created < (this.#userTimes.get(info.sessionID) ?? -Infinity)) return
    this.#users.set(info.sessionID, info.id)
    this.#userTimes.set(info.sessionID, info.time.created)
    const state = this.#states.get(info.sessionID)
    if (state !== undefined) {
      this.#states.set(info.sessionID, {
        task_id: state.task_id, revision: state.revision, stopped: state.stopped, user_message_id: info.id,
      })
    }
  }

  current(sessionID: string): AdviceContext {
    return this.#states.get(sessionID) ?? {}
  }
  forget(sessionID: string): void {
    const work = this.#work.get(sessionID)
    if (work !== undefined) work.active = false
    this.#work.delete(sessionID)
    this.#states.delete(sessionID)
    this.#users.delete(sessionID)
    this.#userTimes.delete(sessionID)
    this.#saved.delete(sessionID)
  }
  clear(): void { for (const id of new Set([...this.#states.keys(), ...this.#users.keys(), ...this.#work.keys()])) this.forget(id) }
  #serial<T>(id: string, operation: (active: () => boolean) => Promise<T>): Promise<T> {
    const scope = this.#work.get(id) ?? { active: true, tail: Promise.resolve() }
    this.#work.set(id, scope)
    const work = scope.tail.then(() => {
      if (!scope.active) throw new Error("Advisor task context released")
      return operation(() => scope.active)
    })
    scope.tail = work.then(() => {}, () => {})
    return work
  }

  async #load(sessionID: string, firstUserID = this.#users.get(sessionID) ?? sessionID, active = () => true): Promise<TaskSnapshot> {
    const local = this.#states.get(sessionID)
    if (local !== undefined) return local
    const stored = await this.store.readTask(this.directory, sessionID)
    if (stored !== undefined && active()) this.#saved.set(sessionID, JSON.stringify(stored))
    return stored ?? {
      task_id: firstUserID, revision: "unversioned", stopped: false,
    }
  }

  capture(sessionID: string, messages: readonly TranscriptMessage[]): Promise<ReviewContext> {
    return this.#serial(sessionID, (active) => this.#capture(sessionID, messages, active))
  }
  async #capture(sessionID: string, messages: readonly TranscriptMessage[], active: () => boolean): Promise<ReviewContext> {
    const transcript = messages.filter(({ info }) => !isDeliveryMessage(info)).map(({ info, parts }) => ({
      info, parts: parts.filter((part) => part.type !== "tool" || part.tool !== "advisor"),
    }))
    const users = transcript.filter(({ info }) => info.role === "user" && !info.id.startsWith("adv_"))
    const state = await this.#load(sessionID, users[0]?.info.id, active)
    const latest = users.at(-1)?.info.id
    const review: ReviewContext = {
      task_id: state.task_id,
      revision: reviewedRevision(transcript),
      ...(latest === undefined ? {} : { user_message_id: latest }),
    }
    const userID = this.#users.get(sessionID) ?? latest
    const { next_action, ...previous } = state
    const current = { ...previous, ...review, ...(userID === undefined ? {} : { user_message_id: userID }),
      ...(userID === state.user_message_id && next_action !== undefined ? { next_action } : {}) }
    await this.#save(sessionID, current, active)
    return review
  }

  checkpoint(sessionID: string, task: "continue" | "replace" | "stop" | "resume", nextAction?: string): Promise<TaskSnapshot> {
    return this.#serial(sessionID, (active) => this.#checkpoint(sessionID, task, nextAction, active))
  }
  async #checkpoint(sessionID: string, task: "continue" | "replace" | "stop" | "resume", nextAction: string | undefined,
    active: () => boolean): Promise<TaskSnapshot> {
    const previous = await this.#load(sessionID, undefined, active)
    const userID = this.#users.get(sessionID) ?? previous.user_message_id
    const current: TaskSnapshot = {
      task_id: task === "replace" ? userID ?? sessionID : previous.task_id,
      revision: previous.revision,
      stopped: task === "continue" ? previous.stopped : task === "stop",
      ...(userID === undefined ? {} : { user_message_id: userID }),
      ...(nextAction === undefined ? {} : { next_action: nextAction }),
    }
    await this.#save(sessionID, current, active)
    return current
  }
  async #save(sessionID: string, current: TaskSnapshot, active: () => boolean): Promise<void> {
    if (!active()) throw new Error("Advisor task context released")
    this.#states.set(sessionID, current)
    const key = JSON.stringify(current)
    if (key === this.#saved.get(sessionID)) return
    await this.store.writeTask(this.directory, sessionID, current)
    if (active()) this.#saved.set(sessionID, key)
  }
}
