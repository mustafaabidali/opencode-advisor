export type AdvisorSeverity = "nit" | "concern" | "blocker"
export type AdvisorLogLevel = "debug" | "info" | "warn" | "error"
export type ConfigEnvironment = Readonly<Record<string, string | undefined>>
export type AdvisorConfig = Readonly<{
  enabled: boolean
  default_model?: string
  default_fallback?: string
  min_severity: AdvisorSeverity
  chat_min_severity: AdvisorSeverity
  inject_min_severity: AdvisorSeverity
  toast: boolean
  abort_on_blocker: boolean
  fallback_on_content_filter: boolean
  fallback_cooldown_ms: number
  pass_debounce_ms: number
  cooldown_ms: number
  max_delta_chars: number
  note_ttl_turns: number
  pass_timeout_ms: number
  abort_grace_ms: number
  min_fallback_budget_ms: number
  max_concurrent_passes_per_provider: number
  admission_timeout_ms: number
  context_budget_tokens: number
  context_budget_fraction: number
  context_carry_chars: number
  log_max_bytes: number
  log_retention: number
  pending_ttl_ms: number
  advise_agents: Readonly<Record<string, boolean | string>>
  provider_aliases: Readonly<Record<string, string>>
  variant_aliases: Readonly<Record<string, string>>
  content_filter_patterns: readonly string[]
  quarantine_patterns: readonly string[]
  log_level: AdvisorLogLevel
}>
export type LoadConfigOptions = Readonly<{
  home: string
  cwd: string
  env: ConfigEnvironment
  readFile: (path: string) => Promise<string>
}>
