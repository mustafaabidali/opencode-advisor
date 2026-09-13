import type { ToolPart } from "@opencode-ai/sdk"
import type { Finding } from "../notes"
import { findingIsActive, type AdviceContext } from "../policy"
import type { MessagesTransformOutput } from "./transform"

function cardNoteID(part: ToolPart): string | undefined {
  if (part.tool === "advisor" && part.id.startsWith("prt_advisor_")) {
    const id = part.state.input["noteID"]
    return typeof id === "string" ? id : undefined
  }
  if (part.tool === "bash" && typeof part.state.input["command"] === "string") {
    return /^advisor --note ([a-zA-Z0-9_-]+)$/.exec(part.state.input["command"])?.[1]
  }
  return undefined
}

export function advisorHistoryIDs(output: MessagesTransformOutput): string[] {
  return output.messages.flatMap((message) => message.parts.flatMap((part) => {
    if (part.type !== "tool" ||
      (part.tool !== "advisor" && (message.info.role !== "assistant" || message.info.mode !== "advisor-delivery"))) return []
    const id = cardNoteID(part)
    return id === undefined ? [] : [id]
  }))
}

/** Keep the visible chat record, but stop replaying closed cards to the model. */
export function pruneAdvisorHistory(output: MessagesTransformOutput, findings: readonly Finding[], context: AdviceContext): void {
  const byNote = new Map(findings.flatMap((finding) => finding.provenance.map((source) => [source.note_id, finding] as const)))
  for (const message of output.messages) {
    message.parts = message.parts.filter((part) => {
      if (part.type !== "tool") return true
      if (part.tool !== "advisor" && (message.info.role !== "assistant" || message.info.mode !== "advisor-delivery")) return true
      const id = cardNoteID(part)
      const finding = id === undefined ? undefined : byNote.get(id)
      return finding === undefined || findingIsActive(finding, context)
    })
  }
}
