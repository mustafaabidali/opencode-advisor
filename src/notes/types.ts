import type { Logger } from "../log"

export type NoteSeverity = "nit" | "concern" | "blocker"

export type NoteInput = Readonly<{
  cwd: string
  root_session: string
  advisor_session: string
  advisor_slug: string
  roster_name: string
  provider: string
  model: string
  model_display: string
  variant: string
  severity: NoteSeverity
  reasoning: string
  note: string
  evidence: readonly string[]
  is_fallback: boolean
  quarantined: boolean
}>

export type Note = NoteInput &
  Readonly<{
    id: string
    time: string
    delivered_at?: string
  }>

export type TranscriptOutcome =
  | "ok"
  | "silent"
  | "fallback"
  | "no_model"
  | "error"
  | "timeout"
  | "quarantined"

export type FailureKind =
  | "throttle"
  | "auth"
  | "api"
  | "content_filter"
  | "empty"
  | "timeout"

export type TranscriptTokens = Readonly<{
  input: number
  output: number
  reasoning: number
  cache: Readonly<{
    read: number
    write: number
  }>
}>

export type TranscriptRecord = Readonly<{
  time: string
  root_session: string
  advisor_session: string
  roster_name: string
  model: string
  variant: string
  tokens: TranscriptTokens
  cost: number
  duration_ms: number
  outcome: TranscriptOutcome
  failure_kind?: FailureKind
}>

export type AdvisorState = Readonly<{
  slug: string
  roster_name: string
  model: string
  model_display: string
  variant: string
  fallback?: string
  tools: readonly string[]
  enabled: boolean
  cooled_until?: string
  passes: number
  notes: number
  cost: number
  last_pass_at: string
  last_outcome: TranscriptOutcome
}>

export type StateSnapshot = Readonly<{
  advisors: readonly AdvisorState[]
  watched_sessions: readonly string[]
  updated_at: string
}>

export type NoteStoreOptions = Readonly<{
  dataDir: string
  log: Logger
  clock?: () => Date
  random?: () => number
}>

export function renderCard(note: Note): string {
  const suffix = note.is_fallback ? " · fallback" : ""
  const lines = [
    `Advisor · ${note.model_display} (${note.variant}) · ${note.severity}${suffix}`,
    `reasoning: ${note.reasoning}`,
    `note: ${note.note}`,
  ]
  if (note.evidence.length > 0) lines.push(`evidence: ${note.evidence.join(", ")}`)
  return lines.join("\n")
}
