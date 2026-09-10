import { homedir } from "node:os"
import { join } from "node:path"

import { stripJsonComments } from "./config/jsonc"

export type AdvisorSeverity = "nit" | "concern" | "blocker"
export type AdvisorLogLevel = "debug" | "info" | "warn" | "error"
export type ConfigEnvironment = Readonly<Record<string, string | undefined>>
export type AdvisorConfig = Readonly<{
  enabled: boolean
  default_model?: string
  default_fallback?: string
  min_severity: AdvisorSeverity
  toast: boolean
  abort_on_blocker: boolean
  fallback_on_content_filter: boolean
  fallback_cooldown_ms: number
  pass_debounce_ms: number
  cooldown_ms: number
  max_delta_chars: number
  note_ttl_turns: number
  pass_timeout_ms: number
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

export const DEFAULTS = {
  enabled: true,
  min_severity: "nit",
  toast: true,
  abort_on_blocker: false,
  fallback_on_content_filter: true,
  fallback_cooldown_ms: 300000,
  pass_debounce_ms: 4000,
  cooldown_ms: 15000,
  max_delta_chars: 30000,
  note_ttl_turns: 2,
  pass_timeout_ms: 180000,
  pending_ttl_ms: 600000,
  advise_agents: {},
  provider_aliases: { "bedrock-mantle": "amazon-bedrock" },
  variant_aliases: {},
  content_filter_patterns: [
    "content[\\s_-]?filter",
    "filtering policy",
    "blocked by",
    "guardrail",
    "refusal",
    "output blocked",
  ],
  quarantine_patterns: [
    "rm\\s+-rf",
    "git\\s+push\\s+--force",
    "--no-verify",
    "DROP\\s+TABLE",
    "git\\s+reset\\s+--hard",
    "chmod\\s+777",
    "curl[^\\n]*\\|\\s*sh",
    ":\\(\\)\\s*\\{",
  ],
  log_level: "info",
} as const satisfies AdvisorConfig

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === "string")
}

function isAdviseAgents(value: unknown): value is Record<string, boolean | string> {
  return (
    isRecord(value) &&
    Object.values(value).every((item) => typeof item === "boolean" || typeof item === "string")
  )
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
}

function isSeverity(value: unknown): value is AdvisorSeverity {
  return value === "nit" || value === "concern" || value === "blocker"
}

function isLogLevel(value: unknown): value is AdvisorLogLevel {
  return value === "debug" || value === "info" || value === "warn" || value === "error"
}

function invalid(warnings: string[], path: string, key: string): void {
  warnings.push(`Invalid value for "${key}" in ${path}; keeping previous value`)
}

function applyValue(
  config: AdvisorConfig,
  key: string,
  value: unknown,
  path: string,
  warnings: string[],
): AdvisorConfig {
  switch (key) {
    case "enabled":
    case "toast":
    case "abort_on_blocker":
    case "fallback_on_content_filter":
      if (typeof value !== "boolean") break
      return { ...config, [key]: value }
    case "default_model":
    case "default_fallback":
      if (typeof value !== "string") break
      return { ...config, [key]: value }
    case "min_severity":
      if (!isSeverity(value)) break
      return { ...config, min_severity: value }
    case "fallback_cooldown_ms":
    case "pass_debounce_ms":
    case "cooldown_ms":
    case "max_delta_chars":
    case "note_ttl_turns":
    case "pass_timeout_ms":
    case "pending_ttl_ms":
      if (typeof value !== "number" || !Number.isFinite(value)) break
      return { ...config, [key]: value }
    case "advise_agents":
      if (!isAdviseAgents(value)) break
      return { ...config, advise_agents: { ...config.advise_agents, ...value } }
    case "provider_aliases":
    case "variant_aliases":
      if (!isStringRecord(value)) break
      return { ...config, [key]: { ...config[key], ...value } }
    case "content_filter_patterns":
    case "quarantine_patterns":
      if (!isStringArray(value)) break
      return { ...config, [key]: [...value] }
    case "log_level":
      if (!isLogLevel(value)) break
      return { ...config, log_level: value }
    default:
      warnings.push(`Unknown config key "${key}" in ${path}`)
      return config
  }
  invalid(warnings, path, key)
  return config
}

function cloneDefaults(): AdvisorConfig {
  return {
    ...DEFAULTS,
    advise_agents: {},
    provider_aliases: { ...DEFAULTS.provider_aliases },
    variant_aliases: { ...DEFAULTS.variant_aliases },
    content_filter_patterns: [...DEFAULTS.content_filter_patterns],
    quarantine_patterns: [...DEFAULTS.quarantine_patterns],
  }
}

async function applyFile(
  config: AdvisorConfig,
  path: string,
  readFile: LoadConfigOptions["readFile"],
  warnings: string[],
): Promise<AdvisorConfig> {
  let source: string
  try {
    source = await readFile(path)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("ENOENT")) return config
    const detail = error instanceof Error ? error.message : "unknown read failure"
    warnings.push(`Unable to read ${path}: ${detail}`)
    return config
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(stripJsonComments(source))
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown parse failure"
    warnings.push(`Invalid JSONC in ${path}: ${detail}`)
    return config
  }
  if (!isRecord(parsed)) {
    warnings.push(`Invalid config root in ${path}; expected an object`)
    return config
  }
  return Object.entries(parsed).reduce(
    (current, [key, value]) => applyValue(current, key, value, path, warnings),
    config,
  )
}

export async function loadConfig(options: LoadConfigOptions): Promise<Readonly<{ config: AdvisorConfig; warnings: readonly string[] }>> {
  const warnings: string[] = []
  const globalPath = join(options.home, ".config", "opencode", "advisor.jsonc")
  const projectPath = join(options.cwd, ".opencode", "advisor.jsonc")
  let config = await applyFile(cloneDefaults(), globalPath, options.readFile, warnings)
  config = await applyFile(config, projectPath, options.readFile, warnings)
  const enabled = options.env["OPENCODE_ADVISOR_ENABLED"]
  if (enabled === "0" || enabled === "1") config = { ...config, enabled: enabled === "1" }
  else if (enabled !== undefined) invalid(warnings, "environment", "OPENCODE_ADVISOR_ENABLED")
  const logLevel = options.env["OPENCODE_ADVISOR_LOG_LEVEL"]
  if (isLogLevel(logLevel)) config = { ...config, log_level: logLevel }
  else if (logLevel !== undefined) invalid(warnings, "environment", "OPENCODE_ADVISOR_LOG_LEVEL")
  return { config, warnings }
}

export function resolveDataDir(env: ConfigEnvironment): string {
  const root = env["XDG_DATA_HOME"] ?? join(env["HOME"] ?? homedir(), ".local", "share")
  return join(root, "opencode-advisor")
}
