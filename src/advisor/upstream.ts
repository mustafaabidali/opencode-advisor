import type { Event } from "@opencode-ai/sdk"
import { classifyFailure, type FailureInput } from "../models"

/** OpenCode may retry upstream errors internally instead of settling session.prompt. */
export class UpstreamFailures {
  readonly #waiting = new Map<string, { started: number; fail: (error: Error) => void }>()
  constructor(private readonly patterns: readonly string[]) {}
  listen(sessionID: string, started: number) {
    const waiting = Promise.withResolvers<never>()
    void waiting.promise.catch(() => {})
    const slot = { started, fail: waiting.reject }
    this.#waiting.set(sessionID, slot)
    return { promise: waiting.promise, close: () => {
      if (this.#waiting.get(sessionID) === slot) this.#waiting.delete(sessionID)
    } }
  }
  observe(event: Event): void {
    let id: string | undefined
    let input: FailureInput | undefined
    let created: number | undefined
    if (event.type === "session.status" && event.properties.status.type === "retry") {
      id = event.properties.sessionID
      input = { thrown: event.properties.status.message }
    } else if (event.type === "message.updated" && event.properties.info.role === "assistant") {
      id = event.properties.info.sessionID
      created = event.properties.info.time.created
      input = { info: event.properties.info }
    } else if (event.type === "message.part.updated" && event.properties.part.type === "step-finish") {
      id = event.properties.part.sessionID
      input = { parts: [event.properties.part] }
    } else if (event.type === "session.error") {
      id = event.properties.sessionID
      input = { thrown: event.properties.error }
    }
    if (id === undefined || input === undefined) return
    const slot = this.#waiting.get(id)
    if (slot === undefined || (created !== undefined && created < slot.started)) return
    const kind = classifyFailure(input, this.patterns)
    if (kind !== "throttle" && kind !== "content_filter" && kind !== "auth") return
    slot.fail(new Error(kind === "content_filter" ? "upstream content filter blocked the response" :
      kind === "throttle" ? "upstream 429 throttled the request" : "upstream 401 authentication failed"))
  }
}
