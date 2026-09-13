import type { Logger } from "../log"

export type NoteSeverity = "nit" | "concern" | "blocker"

export type ReviewContext = Readonly<{
  task_id: string
  revision: string
  user_message_id?: string
}>
export type TaskSnapshot = ReviewContext & Readonly<{ stopped: boolean; next_action?: string }>

export type FindingState = "open" | "resolved" | "dismissed" | "deferred"
export type FindingQuery =
  | Readonly<{ ids: readonly string[] }>
  | Readonly<{ checkpoint: Readonly<{ task_id?: string; stopped?: boolean }>; updated_ids: readonly string[] }>
export type FindingVerification = Readonly<{
  revision: string
  evidence: readonly string[]
  in_scope: boolean
  affected_action?: string
  cost_if_delayed?: string
}>
export type FindingDisposition = Readonly<{
  state: FindingState
  reason: string
  reviewed_revision: string
  evidence: readonly string[]
  time: string
}>
export type DispositionInput = Readonly<{
  id: string
  state: FindingState
  reviewed_revision: string
  version: number
  reason: string
  evidence?: readonly string[]
  verification?: Omit<FindingVerification, "evidence">
}>
export type FindingSource = Readonly<{
  note_id: string
  advisor_slug: string
  model: string
  time: string
  reviewed_revision: string
}>
export type Finding = Readonly<{
  id: string
  issue_id: string
  cwd: string
  root_session: string
  task_id: string
  reviewed_revision: string
  version: number
  state: FindingState
  updated_at: string
  provenance: readonly FindingSource[]
  disposition?: FindingDisposition
  verification?: FindingVerification
  reopened_at?: string
}>

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
  review?: ReviewContext
  failure?: string
  location?: string
}>

export type Note = NoteInput &
  Readonly<{
    id: string
    time: string
    delivered_at?: string
    expired_at?: string
    finding_id?: string
    issue_id?: string
  }>

export type DeliveryNote =
  | Readonly<{ status: "ready"; note: Note }>
  | Readonly<{ status: "missing" | "expired" | "delivered" | "inactive" | "duplicate" }>

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
  | "poisoned_session"

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

const SEVERITY_GLYPH: Readonly<Record<NoteSeverity, string>> = { blocker: "◉", concern: "◎", nit: "○" }

export function renderCard(note: Note): string {
  const suffix = note.is_fallback ? " · fallback" : ""
  const lines = [
    `${SEVERITY_GLYPH[note.severity]} Advisor · ${note.model_display} (${note.variant}) · ${note.severity}${suffix}`,
    `reasoning: ${note.reasoning}`,
    `note: ${note.note}`,
  ]
  if (note.evidence.length > 0) lines.push(`evidence: ${note.evidence.join(", ")}`)
  lines.push(`finding: ${note.id}`)
  return lines.join("\n")
}
