import type { AdvisorConfig, AdvisorSeverity } from "../config"
import type { ModelRef } from "../models"

export const KNOWN_BUILTINS = [
  "read",
  "grep",
  "glob",
  "list",
  "edit",
  "write",
  "bash",
  "webfetch",
  "websearch",
  "codesearch",
  "task",
  "skill",
  "lsp",
  "todowrite",
  "question",
  "patch",
  "multiedit",
] as const

export const DEFAULT_ADVISOR_TOOLS = ["read", "grep", "glob"] as const
export const DELIVERY_AGENT_ID = "advisor-delivery"

export type KnownBuiltin = (typeof KNOWN_BUILTINS)[number]

export type RosterAdvisorInput = Readonly<{
  name: string
  enabled?: boolean
  model?: string
  fallback?: string
  tools?: readonly string[]
  instructions?: string
  prompt?: string
  min_severity?: AdvisorSeverity
}>

export type AdvisorEntry = Readonly<{
  name: string
  enabled: boolean
  model: ModelRef
  fallback?: ModelRef
  tools: readonly KnownBuiltin[]
  instructions?: string
  min_severity: AdvisorSeverity
  slug: string
  agentId: string
  fallbackAgentId?: string
}>

export type ParsedRoster = Readonly<{
  instructions?: string
  advisors: readonly AdvisorEntry[]
  warnings: readonly string[]
}>

export type NormalizedTools = Readonly<{
  granted: readonly KnownBuiltin[]
  warnings: readonly string[]
}>

export type DiscoverRosterFilesOptions = Readonly<{
  cwd: string
  home: string
  exists?: (path: string) => boolean
}>

export type DiscoveredRosterFiles = Readonly<{
  yml?: string
  md: readonly string[]
}>

export type RosterConfig = Pick<
  AdvisorConfig,
  | "default_model"
  | "default_fallback"
  | "min_severity"
  | "provider_aliases"
  | "variant_aliases"
>
