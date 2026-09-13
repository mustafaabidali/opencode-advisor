import type { UserMessage } from "@opencode-ai/sdk"
import { isDeliveryMessage, type TranscriptMessage } from "../delta"
import type { NoteStore, ReviewContext, TaskSnapshot } from "../notes"
import type { AdviceContext } from "../policy"
import { reviewedRevision } from "./revision"

export class TaskContexts {
  readonly #states = new Map<string, TaskSnapshot>()
  readonly #users = new Map<string, string>()

  constructor(
    private readonly store: Pick<NoteStore, "readTask" | "writeTask">,
    private readonly directory: string,
  ) {}

  user(info: UserMessage): void {
    if (info.agent?.startsWith("advisor-") || info.id.startsWith("adv_")) return
    if (this.#users.get(info.sessionID) === info.id) return
    this.#users.set(info.sessionID, info.id)
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

  async #load(sessionID: string, firstUserID = this.#users.get(sessionID) ?? sessionID): Promise<TaskSnapshot> {
    return this.#states.get(sessionID) ?? await this.store.readTask(this.directory, sessionID) ?? {
      task_id: firstUserID, revision: "unversioned", stopped: false,
    }
  }

  async capture(sessionID: string, messages: readonly TranscriptMessage[]): Promise<ReviewContext> {
    const transcript = messages.filter(({ info }) => !isDeliveryMessage(info)).map(({ info, parts }) => ({
      info, parts: parts.filter((part) => part.type !== "tool" || part.tool !== "advisor"),
    }))
    const users = transcript.filter(({ info }) => info.role === "user" && !info.id.startsWith("adv_"))
    const state = await this.#load(sessionID, users[0]?.info.id)
    const latest = users.at(-1)?.info.id
    const review: ReviewContext = {
      task_id: state.task_id,
      revision: reviewedRevision(transcript),
      ...(latest === undefined ? {} : { user_message_id: latest }),
    }
    const userID = this.#users.get(sessionID) ?? latest
    const current = { ...state, ...review, ...(userID === undefined ? {} : { user_message_id: userID }) }
    this.#states.set(sessionID, current)
    await this.store.writeTask(this.directory, sessionID, current)
    return review
  }

  async checkpoint(sessionID: string, task: "continue" | "replace" | "stop" | "resume", nextAction?: string): Promise<TaskSnapshot> {
    const previous = await this.#load(sessionID)
    const userID = this.#users.get(sessionID) ?? previous.user_message_id
    const current: TaskSnapshot = {
      task_id: task === "replace" ? userID ?? sessionID : previous.task_id,
      revision: previous.revision,
      stopped: task === "continue" ? previous.stopped : task === "stop",
      ...(userID === undefined ? {} : { user_message_id: userID }),
      ...(nextAction === undefined ? {} : { next_action: nextAction }),
    }
    this.#states.set(sessionID, current)
    await this.store.writeTask(this.directory, sessionID, current)
    return current
  }
}
