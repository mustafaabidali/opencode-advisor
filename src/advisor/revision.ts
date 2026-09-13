import { createHash } from "node:crypto"
import { isDeliveryMessage, type TranscriptMessage } from "../delta"

const READ_ONLY_TOOLS = new Set(["read", "grep", "glob", "webfetch", "websearch", "question", "todowrite", "advisor", "advisor_checkpoint"])

/** Prefer OpenCode's worktree snapshot; otherwise track observed tool changes. */
export function reviewedRevision(messages: readonly TranscriptMessage[]): string {
  let snapshot = ""
  let changes: unknown[] = []
  for (const { info, parts } of messages) {
    if (isDeliveryMessage(info)) continue
    for (const part of parts) {
      if ((part.type === "snapshot" || part.type === "step-start" || part.type === "step-finish") &&
        part.snapshot !== undefined) {
        snapshot = part.snapshot
        changes = []
      } else if (part.type === "patch") {
        changes.push({ hash: part.hash, files: part.files })
      } else if (part.type === "tool" && !READ_ONLY_TOOLS.has(part.tool) &&
        (part.state.status === "completed" || part.state.status === "error")) {
        changes.push({ id: part.id, tool: part.tool, input: part.state.input, status: part.state.status })
      }
    }
  }
  return `observed:${createHash("sha256").update(JSON.stringify({ snapshot, changes })).digest("hex").slice(0, 24)}`
}
