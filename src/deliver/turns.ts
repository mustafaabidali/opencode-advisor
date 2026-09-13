import type { Event, Message, UserMessage } from "@opencode-ai/sdk"

type Turn = {
  epoch: number
  userID?: string
  seen: Set<string>
  awaitingResponse: boolean
  status?: "idle" | "busy" | "retry"
  rendering: boolean
}

/** Shell delivery generates its own status events; only real messages advance a turn. */
export class DeliveryTurns {
  readonly #turns = new Map<string, Turn>()

  #turn(sessionID: string): Turn {
    let turn = this.#turns.get(sessionID)
    if (turn === undefined) {
      turn = { epoch: 0, seen: new Set(), awaitingResponse: false, rendering: false }
      this.#turns.set(sessionID, turn)
    }
    return turn
  }

  user(info: UserMessage): void {
    if (info.agent?.startsWith("advisor-") || info.id.startsWith("adv_")) return
    const turn = this.#turn(info.sessionID)
    if (turn.seen.has(info.id)) return
    turn.seen.add(info.id)
    turn.userID = info.id
    turn.epoch += 1
    turn.awaitingResponse = true
    turn.status = "busy"
  }

  message(info: Message): void {
    if (info.role === "user") return this.user(info)
    if (info.mode.startsWith("advisor-")) return
    const turn = this.#turn(info.sessionID)
    if (info.parentID === turn.userID && info.time.completed !== undefined) {
      turn.awaitingResponse = false
    }
  }

  event(event: Event): void {
    if (event.type === "message.updated") this.message(event.properties.info)
    if (event.type === "session.deleted") this.#turns.delete(event.properties.info.id)
    if (event.type !== "session.status") return
    const turn = this.#turn(event.properties.sessionID)
    if (!turn.rendering) turn.status = event.properties.status.type
  }

  status(sessionID: string): Turn["status"] {
    return this.#turn(sessionID).status
  }

  epoch(sessionID: string): number {
    return this.#turn(sessionID).epoch
  }

  canDeliver(sessionID: string, epoch = this.epoch(sessionID)): boolean {
    const turn = this.#turn(sessionID)
    return turn.epoch === epoch && turn.status === "idle" && !turn.awaitingResponse
  }

  rendering(sessionID: string, value: boolean): void {
    this.#turn(sessionID).rendering = value
  }
}
