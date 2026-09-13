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

export const EDIT_TOOLS = ["edit", "write", "apply_patch", "patch", "multiedit"] as const
export const SHELL_TOOLS = ["bash"] as const

export type ReviewTrigger = Readonly<{
  edits: readonly string[]
  commands: readonly string[]
  tools: readonly string[]
}>

export type RosterAdvisorInput = Readonly<{
  name: string
  enabled?: boolean
  model?: string
  fallback?: string
  tools?: readonly string[]
  instructions?: string
  prompt?: string
  min_severity?: AdvisorSeverity
  chat_min_severity?: AdvisorSeverity
  inject_min_severity?: AdvisorSeverity
  when?: ReviewTrigger
}>

export type AdvisorEntry = Readonly<{
  name: string
  enabled: boolean
  model: ModelRef
  fallback?: ModelRef
  tools: readonly KnownBuiltin[]
  instructions?: string
  min_severity: AdvisorSeverity
  chat_min_severity: AdvisorSeverity
  inject_min_severity: AdvisorSeverity
  when?: ReviewTrigger
  slug: string
  agentId: string
  fallbackAgentId?: string
}>

export type AdvisorFloors = Pick<AdvisorEntry, "chat_min_severity" | "inject_min_severity">

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
  | "chat_min_severity"
  | "inject_min_severity"
  | "provider_aliases"
  | "variant_aliases"
>
