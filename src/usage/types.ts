export type UsageState = "running" | "completed" | "not_sent" | "cancelled_confirmed" | "cancellation_uncertain"
export type UsageCoverage = "unknown" | "partial" | "complete"

export type UsageAttempt = Readonly<{
  id: string
  pass_id: string
  cwd: string
  root_session: string
  advisor_session: string
  advisor_slug: string
  model: string
  variant: string
  started_at: number
  settled_at: number | null
  prompt_id: string | null
  state: UsageState
  coverage: UsageCoverage
}>

export type UsageRecord = Readonly<{
  message_id: string
  advisor_session: string
  cwd: string
  root_session: string
  advisor_slug: string
  attempt_id: string | null
  parent_id: string
  created_at: number
  completed_at: number | null
  model: string
  cost: number
  input: number
  output: number
  reasoning: number
  cache_read: number
  cache_write: number
  summary: number
  unknown_usage: number
}>

export type UsageTotals = Readonly<{
  cost: number
  messages: number
  unattributed: number
  unknown_usage: number
  summary_cost: number
  summary_messages: number
  input: number
  output: number
  reasoning: number
  cache_read: number
  cache_write: number
}>
export type UsageSummary = UsageTotals & Readonly<{
  attempts: number
  coverage: UsageCoverage
  by_advisor: readonly (UsageTotals & { advisor_slug: string })[]
}>
