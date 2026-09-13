import type { AgentConfig } from "@opencode-ai/sdk"

import { parseModelRef, type ModelRef } from "../models"
import {
  DEFAULT_ADVISOR_TOOLS,
  DELIVERY_AGENT_ID,
  KNOWN_BUILTINS,
  type AdvisorEntry,
  type AdvisorFloors,
  type KnownBuiltin,
  type NormalizedTools,
  type RosterAdvisorInput,
  type RosterConfig,
} from "./types"

const EDIT_TOOLS = ["edit", "write", "patch", "multiedit"] as const
const INVESTIGATIVE_TOOLS = ["read", "grep", "glob", "list"] as const
type PermissionAction = "ask" | "allow" | "deny"
type PermissionRule = PermissionAction | Record<string, PermissionAction>
type AdvisorPermission = NonNullable<AgentConfig["permission"]> &
  Record<string, PermissionRule>

function isKnownBuiltin(value: string): value is KnownBuiltin {
  return KNOWN_BUILTINS.some((tool) => tool === value)
}

export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
}

export function normalizeTools(tools?: readonly string[]): NormalizedTools {
  if (tools === undefined) {
    return { granted: [...DEFAULT_ADVISOR_TOOLS], warnings: [] }
  }

  const granted: KnownBuiltin[] = []
  const warnings: string[] = []
  for (const raw of tools) {
    const aliased = raw === "search" ? "grep" : raw === "find" ? "glob" : raw
    if (!isKnownBuiltin(aliased)) {
      warnings.push(`Unknown advisor tool "${raw}" was dropped`)
      continue
    }
    if (!granted.includes(aliased)) granted.push(aliased)
  }

  if (tools.length > 0 && granted.length === 0) {
    warnings.push("All requested advisor tools were unknown; using read, grep, glob")
    return { granted: [...DEFAULT_ADVISOR_TOOLS], warnings }
  }
  return { granted, warnings }
}

function resolveFallback(
  input: RosterAdvisorInput,
  model: ModelRef,
  config: RosterConfig,
): ModelRef | undefined {
  const candidates =
    input.fallback !== undefined
      ? [input.fallback]
      : config.default_fallback === undefined
        ? []
        : [config.default_fallback, config.default_model]
  for (const candidate of candidates) {
    if (candidate === undefined) continue
    const ref = parseModelRef(candidate, config)
    if (ref.long !== model.long) return ref
  }
  return undefined
}

export function resolveEntry(
  input: RosterAdvisorInput,
  config: RosterConfig,
): AdvisorEntry | undefined {
  const rawModel = input.model ?? config.default_model
  if (rawModel === undefined) return undefined
  const model = parseModelRef(rawModel, config)
  const fallback = resolveFallback(input, model, config)
  const tools = normalizeTools(input.tools).granted
  const instructions = input.instructions ?? input.prompt
  const slug = slugify(input.name)
  const agentId = `advisor-${slug}`
  const base = {
    name: input.name,
    enabled: input.enabled ?? true,
    model,
    tools,
    min_severity: input.min_severity ?? config.min_severity,
    chat_min_severity: input.chat_min_severity ?? config.chat_min_severity,
    inject_min_severity: input.inject_min_severity ?? config.inject_min_severity,
    slug,
    agentId,
    ...(instructions === undefined ? {} : { instructions }),
    ...(input.when === undefined ? {} : { when: input.when }),
  }
  return fallback === undefined
    ? base
    : { ...base, fallback, fallbackAgentId: `${agentId}-fb` }
}

export function rosterFloors(roster: readonly AdvisorEntry[]): (slug: string) => AdvisorFloors | undefined {
  const bySlug = new Map(roster.map((entry) => [
    entry.slug,
    { chat_min_severity: entry.chat_min_severity, inject_min_severity: entry.inject_min_severity },
  ]))
  return (slug) => bySlug.get(slug)
}

function toolsMap(granted: readonly KnownBuiltin[]): Record<string, boolean> {
  const tools: Record<string, boolean> = { "*": false }
  for (const tool of granted) tools[tool] = true
  return tools
}

function permissionMap(entry: AdvisorEntry): AdvisorPermission {
  const permission: AdvisorPermission = { "*": "deny" }
  for (const tool of INVESTIGATIVE_TOOLS) {
    if (entry.tools.includes(tool)) permission[tool] = "allow"
  }
  const editGranted = EDIT_TOOLS.some((tool) => entry.tools.includes(tool))
  permission.edit = editGranted ? "ask" : "deny"
  permission.bash = entry.tools.includes("bash") ? "ask" : "deny"
  permission.webfetch = entry.tools.includes("webfetch") ? "ask" : "deny"
  permission.external_directory = "deny"
  return permission
}

function agentConfig(
  entry: AdvisorEntry,
  model: ModelRef,
  systemPrompt: string,
): AgentConfig {
  const base = {
    description: `Advisor watchdog: ${entry.name}`,
    mode: "subagent",
    hidden: true,
    model: model.long,
    prompt: systemPrompt,
    maxSteps: 12,
    tools: toolsMap(entry.tools),
    permission: permissionMap(entry),
  } as const satisfies AgentConfig
  return model.variant === undefined ? base : { ...base, variant: model.variant }
}

export function toAgentConfig(
  entry: AdvisorEntry,
  systemPrompt: string,
): AgentConfig {
  return agentConfig(entry, entry.model, systemPrompt)
}

export function toFallbackAgentConfig(
  entry: AdvisorEntry,
  systemPrompt: string,
): AgentConfig | undefined {
  return entry.fallback === undefined
    ? undefined
    : agentConfig(entry, entry.fallback, systemPrompt)
}

export function deliveryAgentConfig(): AgentConfig {
  const permission: AdvisorPermission = {
    "*": "deny",
    bash: { "advisor*": "allow", "*": "deny" },
    edit: "deny",
    webfetch: "deny",
  }
  return {
    description: "Advisor card delivery",
    mode: "subagent",
    hidden: true,
    tools: { "*": false, bash: true },
    permission,
  } satisfies AgentConfig
}

export { DELIVERY_AGENT_ID }
