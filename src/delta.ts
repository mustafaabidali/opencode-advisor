import type { Message, Part, ToolPart } from "@opencode-ai/sdk"

export type Cursor = Readonly<{
  lastMessageID?: string
  lastPartCount?: number
}>

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

export function sliceDelta(
  messages: readonly TranscriptMessage[],
  cursor: Cursor,
): { readonly delta: TranscriptMessage[]; readonly next: Cursor } {
  const sorted = [...messages].sort(
    (left, right) => left.info.time.created - right.info.time.created,
  )
  const latest = sorted.at(-1)
  const next: Cursor = latest
    ? { lastMessageID: latest.info.id, lastPartCount: latest.parts.length }
    : cursor

  if (cursor.lastMessageID === undefined) return { delta: sorted, next }

  const cursorIndex = sorted.findIndex(
    ({ info }) => info.id === cursor.lastMessageID,
  )
  if (cursorIndex < 0) return { delta: sorted, next }

  const cursorMessage = sorted[cursorIndex]
  if (cursorMessage === undefined) return { delta: [], next }

  const grew = cursorMessage.parts.length > (cursor.lastPartCount ?? 0)
  return {
    delta: sorted.slice(cursorIndex + (grew ? 0 : 1)),
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
  return part.tool === "bash" && part.state.input["command"] === "advisor"
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

function renderMessage(message: RenderableTranscriptMessage): string | undefined {
  if (
    (message.info.role === "user" && message.info.agent === "advisor-delivery") ||
    (message.info.role === "assistant" && message.info.mode === "advisor-delivery")
  ) {
    return undefined
  }

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
