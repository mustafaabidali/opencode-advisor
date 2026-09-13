import { isAbsolute, matchesGlob, relative, resolve } from "node:path"
import type { Part, ToolPart } from "@opencode-ai/sdk"

import { isDeliveryMessage, type TranscriptMessage } from "../delta"
import { EDIT_TOOLS, type ReviewTrigger } from "../roster"

const PATH_TOOLS: ReadonlySet<string> = new Set(EDIT_TOOLS)
const PATCH_HEADER = /^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm

function isCompletedTool(part: Part): part is ToolPart & { state: { status: "completed" } } {
  return part.type === "tool" && part.state.status === "completed"
}

function editedPaths(part: ToolPart): string[] {
  const input = part.state.input
  const direct = input["filePath"] ?? input["path"]
  if (typeof direct === "string") return [direct]
  const patchText = input["patchText"]
  if (part.tool !== "apply_patch" || typeof patchText !== "string") return []
  return [...patchText.matchAll(PATCH_HEADER)].flatMap((match) => {
    const path = match[1] ?? match[2]
    return path === undefined ? [] : [path.trim()]
  })
}

function pathMatches(path: string, globs: readonly string[], directory: string): boolean {
  const absolute = resolve(directory, path)
  const rel = relative(directory, absolute)
  return globs.some((glob) => matchesGlob(isAbsolute(glob) ? absolute : rel, glob))
}

function partMatches(part: ToolPart & { state: { status: "completed" } }, when: ReviewTrigger, directory: string): boolean {
  if (when.tools.includes(part.tool)) return true
  if (PATH_TOOLS.has(part.tool) && when.edits.length > 0) {
    return editedPaths(part).some((path) => pathMatches(path, when.edits, directory))
  }
  if (part.tool === "bash" && when.commands.length > 0) {
    const command = part.state.input["command"]
    return typeof command === "string" && when.commands.some((pattern) => new RegExp(pattern).test(command))
  }
  return false
}

export function shouldReview(
  when: ReviewTrigger | undefined,
  delta: readonly TranscriptMessage[],
  directory: string,
): boolean {
  if (when === undefined) return true
  return delta.some((message) =>
    !isDeliveryMessage(message.info) &&
    message.parts.some((part) => isCompletedTool(part) && partMatches(part, when, directory)))
}
