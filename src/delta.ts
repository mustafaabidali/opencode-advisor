import type { Message, Part, ToolPart } from "@opencode-ai/sdk"
import { changedParts, observeCursor, observePrefix, type Cursor } from "./history/cursor"
export type { Cursor } from "./history/cursor"

export type TranscriptMessage = Readonly<{
  info: Message
  parts: readonly Part[]
}>

export type RenderableTranscriptMessage = Readonly<{
  info: Message
  parts: readonly unknown[]
}>

export type RenderDeltaOptions = Readonly<{
  maxChars: number
  redact: (value: string) => string
}>

const SKIPPED_PART_TYPES = new Set([
  "step-start",
  "step-finish",
  "snapshot",
  "compaction",
  "retry",
  "patch",
])

/** A delivered card is appended to a reviewed message; it is not new work to review. */
function reviewableParts(parts: readonly Part[]): Part[] {
  return parts.filter((part) => (part.type !== "tool" || !isAdvisorShell(part)) &&
    !(part.type === "text" && part.synthetic && part.text.includes("<advisor severity=")))
}

export function sliceDelta(
  messages: readonly TranscriptMessage[],
  cursor: Cursor,
): { readonly delta: TranscriptMessage[]; readonly next: Cursor } {
  const sorted = [...messages].sort(
    (left, right) => left.info.time.created - right.info.time.created || left.info.id.localeCompare(right.info.id),
  )
  const latest = sorted.at(-1)
  const observed = observeCursor(sorted, reviewableParts)
  const prefix = observePrefix(sorted, reviewableParts)
  const next: Cursor = latest
    ? { lastMessageID: latest.info.id, lastPartCount: reviewableParts(latest.parts).length, observed,
      ...(prefix === undefined ? {} : { prefix }) }
    : cursor

  if (cursor.lastMessageID === undefined) return { delta: sorted, next }
  const cursorIndex = sorted.findIndex(({ info }) => info.id === cursor.lastMessageID)
  if (cursorIndex < 0) return { delta: sorted, next }
  if (cursor.observed !== undefined) {
    const prefixChanged = prefix !== undefined && (cursor.prefix === undefined ||
      observePrefix(sorted, reviewableParts, cursor.prefix.before)?.digest !== cursor.prefix.digest)
    const delta = sorted.flatMap((message, index) => {
      const before = cursor.observed?.[message.info.id]
      const after = observed[message.info.id]
      if (after === undefined && before === undefined) {
        const parts = reviewableParts(message.parts)
        return (index > cursorIndex || prefixChanged) && parts.length > 0 ? [{ info: message.info, parts }] : []
      }
      const parts = changedParts({ ...message, parts: reviewableParts(message.parts) },
        before, after ?? observeCursor([message], reviewableParts)[message.info.id])
      return parts.length === 0 ? [] : [{ info: message.info, parts }]
    })
    return { delta, next }
  }

  const cursorMessage = sorted[cursorIndex]
  if (cursorMessage === undefined) return { delta: [], next }

  const seen = cursor.lastPartCount ?? 0
  const parts = reviewableParts(cursorMessage.parts)
  const after = sorted.slice(cursorIndex + 1)
  return {
    delta: parts.length > seen
      ? [{ info: cursorMessage.info, parts: parts.slice(seen) }, ...after]
      : after,
    next,
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null
}

function isPart(value: unknown): value is Part {
  if (!isRecord(value) || typeof value["type"] !== "string") return false
  return (
    value["type"] === "text" ||
    value["type"] === "subtask" ||
    value["type"] === "reasoning" ||
    value["type"] === "file" ||
    value["type"] === "tool" ||
    value["type"] === "step-start" ||
    value["type"] === "step-finish" ||
    value["type"] === "snapshot" ||
    value["type"] === "patch" ||
    value["type"] === "agent" ||
    value["type"] === "retry" ||
    value["type"] === "compaction"
  )
}

function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : value.slice(0, maxChars)
}

function toolOutput(part: ToolPart): string {
  switch (part.state.status) {
    case "pending":
      return "pending:"
    case "running":
      return "running:"
    case "completed": {
      const output =
        part.state.output.length <= 1_200
          ? part.state.output
          : `${part.state.output.slice(0, 800)} … ${part.state.output.slice(-400)}`
      return `completed: ${output}`
    }
    case "error":
      return `error: ${part.state.error}`
  }
}

function isAdvisorShell(part: ToolPart): boolean {
  return part.tool === "advisor" || (part.tool === "bash" && part.state.input["command"] === "advisor")
}

function renderPart(value: unknown): string | undefined {
  if (!isPart(value) || SKIPPED_PART_TYPES.has(value.type)) return undefined

  switch (value.type) {
    case "text":
      return value.synthetic && value.text.includes("<advisor severity=")
        ? undefined
        : `[text] ${value.text}`
    case "reasoning":
      return `[reasoning] ${truncate(value.text, 1_200)}`
    case "tool":
      if (isAdvisorShell(value)) return undefined
      return `[tool ${value.tool}] input: ${truncate(JSON.stringify(value.state.input), 600)} -> ${toolOutput(value)}`
    case "file":
      return `[file ${value.filename ?? value.source?.path ?? value.url}]`
    case "subtask":
      return `[subtask ${value.agent}: ${value.description}]`
    case "agent":
      return `[agent @${value.name}]`
    case "step-start":
    case "step-finish":
    case "snapshot":
    case "patch":
    case "retry":
    case "compaction":
      return undefined
  }
}

export function isDeliveryMessage(info: Message): boolean {
  return (
    (info.role === "user" && (info.agent === "advisor-delivery" || info.id.startsWith("adv_"))) ||
    (info.role === "assistant" && info.mode === "advisor-delivery")
  )
}

function renderMessage(message: RenderableTranscriptMessage): string | undefined {
  if (isDeliveryMessage(message.info)) return undefined

  const time = new Date(message.info.time.created).toISOString()
  const heading =
    message.info.role === "user"
      ? `## user ${time}`
      : `## assistant (${message.info.mode} · ${message.info.modelID}) ${time}`
  const renderedParts = message.parts
    .map(renderPart)
    .filter((part): part is string => part !== undefined)
  return [heading, ...renderedParts].join("\n")
}

function capTranscript(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  if (maxChars <= 0) return ""

  let marker = "[… truncated …]"
  if (maxChars <= marker.length) return value.slice(0, maxChars)

  for (;;) {
    const available = maxChars - marker.length
    const headLength = Math.floor(available * 0.7)
    const tailLength = available - headLength
    const omitted = value.length - headLength - tailLength
    const nextMarker = `[… truncated ${omitted} chars …]`
    if (nextMarker === marker) {
      return `${value.slice(0, headLength)}${marker}${value.slice(-tailLength)}`
    }
    marker = nextMarker
  }
}

export function renderDelta(
  delta: readonly RenderableTranscriptMessage[],
  options: RenderDeltaOptions,
): string {
  const rendered = delta
    .map(renderMessage)
    .filter((message): message is string => message !== undefined)
    .join("\n\n")
  return capTranscript(options.redact(rendered), options.maxChars)
}
