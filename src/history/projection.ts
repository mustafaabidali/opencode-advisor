import type { Part } from "@opencode-ai/sdk"
import type { TranscriptMessage } from "../delta"

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) freeze(child)
  }
  return value
}

/** Preserve revision inputs and user text; retain only the tool output the reviewer can see. */
export function projectPart(part: Part): Part {
  let projected = part
  if (part.type === "tool") {
    const state = part.state
    if (state.status === "completed") {
      const output = state.output.length <= 1200 ? state.output : `${state.output.slice(0, 800)} … ${state.output.slice(-400)}`
      projected = { ...part, state: { ...state, output, metadata: {}, attachments: [] } }
    } else if (state.status === "running") projected = { ...part, state: { ...state, metadata: {} } }
    else if (state.status === "pending") projected = { ...part, state: { ...state, raw: "" } }
  } else if (part.type === "reasoning") projected = { ...part, text: part.text.slice(0, 1200) }
  return freeze(structuredClone(projected))
}

export function projectMessage(message: TranscriptMessage): TranscriptMessage {
  return Object.freeze({ info: freeze(structuredClone(message.info)), parts: Object.freeze(message.parts.map(projectPart)) })
}
