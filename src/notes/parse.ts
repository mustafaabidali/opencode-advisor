import type { AdvisorState, Note, StateSnapshot, TranscriptOutcome } from "./types"

export type PendingPointer = Readonly<{
  noteID: string
  time: string
}>

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stringAt(
  record: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const value = record[key]
  return typeof value === "string" ? value : undefined
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
}

function isOutcome(value: unknown): value is TranscriptOutcome {
  return (
    value === "ok" ||
    value === "silent" ||
    value === "fallback" ||
    value === "no_model" ||
    value === "error" ||
    value === "timeout" ||
    value === "quarantined"
  )
}

export function parsePendingPointer(text: string): PendingPointer | undefined {
  const value: unknown = JSON.parse(text)
  if (!isRecord(value)) return undefined
  const noteID = stringAt(value, "noteID")
  const time = stringAt(value, "time")
  return noteID === undefined || time === undefined ? undefined : { noteID, time }
}

export function parseNote(text: string): Note | undefined {
  const value: unknown = JSON.parse(text)
  if (!isRecord(value)) return undefined
  const id = stringAt(value, "id")
  const time = stringAt(value, "time")
  const cwd = stringAt(value, "cwd")
  const rootSession = stringAt(value, "root_session")
  const advisorSession = stringAt(value, "advisor_session")
  const advisorSlug = stringAt(value, "advisor_slug")
  const rosterName = stringAt(value, "roster_name")
  const provider = stringAt(value, "provider")
  const model = stringAt(value, "model")
  const modelDisplay = stringAt(value, "model_display")
  const variant = stringAt(value, "variant")
  const reasoning = stringAt(value, "reasoning")
  const note = stringAt(value, "note")
  const severity = value["severity"]
  const evidence = value["evidence"]
  const isFallback = value["is_fallback"]
  const quarantined = value["quarantined"]
  const deliveredAt = value["delivered_at"]
  if (
    id === undefined ||
    time === undefined ||
    cwd === undefined ||
    rootSession === undefined ||
    advisorSession === undefined ||
    advisorSlug === undefined ||
    rosterName === undefined ||
    provider === undefined ||
    model === undefined ||
    modelDisplay === undefined ||
    variant === undefined ||
    reasoning === undefined ||
    note === undefined ||
    !isStringArray(evidence) ||
    typeof isFallback !== "boolean" ||
    typeof quarantined !== "boolean" ||
    (severity !== "nit" && severity !== "concern" && severity !== "blocker") ||
    (deliveredAt !== undefined && typeof deliveredAt !== "string")
  ) {
    return undefined
  }
  return {
    id,
    time,
    cwd,
    root_session: rootSession,
    advisor_session: advisorSession,
    advisor_slug: advisorSlug,
    roster_name: rosterName,
    provider,
    model,
    model_display: modelDisplay,
    variant,
    severity,
    reasoning,
    note,
    evidence,
    is_fallback: isFallback,
    quarantined,
    ...(deliveredAt === undefined ? {} : { delivered_at: deliveredAt }),
  }
}

function parseAdvisorState(value: unknown): AdvisorState | undefined {
  if (!isRecord(value)) return undefined
  const slug = stringAt(value, "slug")
  const rosterName = stringAt(value, "roster_name")
  const model = stringAt(value, "model")
  const modelDisplay = stringAt(value, "model_display")
  const variant = stringAt(value, "variant")
  const fallback = value["fallback"]
  const tools = value["tools"]
  const enabled = value["enabled"]
  const cooledUntil = value["cooled_until"]
  const passes = value["passes"]
  const notes = value["notes"]
  const cost = value["cost"]
  const lastPassAt = stringAt(value, "last_pass_at")
  const lastOutcome = value["last_outcome"]
  if (
    slug === undefined ||
    rosterName === undefined ||
    model === undefined ||
    modelDisplay === undefined ||
    variant === undefined ||
    !isStringArray(tools) ||
    typeof enabled !== "boolean" ||
    typeof passes !== "number" ||
    typeof notes !== "number" ||
    typeof cost !== "number" ||
    lastPassAt === undefined ||
    !isOutcome(lastOutcome) ||
    (fallback !== undefined && typeof fallback !== "string") ||
    (cooledUntil !== undefined && typeof cooledUntil !== "string")
  ) {
    return undefined
  }
  return {
    slug,
    roster_name: rosterName,
    model,
    model_display: modelDisplay,
    variant,
    tools,
    enabled,
    passes,
    notes,
    cost,
    last_pass_at: lastPassAt,
    last_outcome: lastOutcome,
    ...(fallback === undefined ? {} : { fallback }),
    ...(cooledUntil === undefined ? {} : { cooled_until: cooledUntil }),
  }
}

export function parseStateSnapshot(text: string): StateSnapshot | undefined {
  const value: unknown = JSON.parse(text)
  if (!isRecord(value)) return undefined
  const advisorValues = value["advisors"]
  const watchedSessions = value["watched_sessions"]
  const updatedAt = stringAt(value, "updated_at")
  if (
    !Array.isArray(advisorValues) ||
    !isStringArray(watchedSessions) ||
    updatedAt === undefined
  ) {
    return undefined
  }
  const advisors = advisorValues.map(parseAdvisorState)
  if (advisors.some((advisor) => advisor === undefined)) return undefined
  return {
    advisors: advisors.filter((advisor): advisor is AdvisorState => advisor !== undefined),
    watched_sessions: watchedSessions,
    updated_at: updatedAt,
  }
}

export function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}
