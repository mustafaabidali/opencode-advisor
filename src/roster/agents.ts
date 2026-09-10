import type { AgentConfig } from "@opencode-ai/sdk"

import { parseModelRef, type ModelRef } from "../models"
import {
  DEFAULT_ADVISOR_TOOLS,
  DELIVERY_AGENT_ID,
  KNOWN_BUILTINS,
  type AdvisorEntry,
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

export function resolveEntry(
  input: RosterAdvisorInput,
  config: RosterConfig,
): AdvisorEntry {
  const model = parseModelRef(input.model ?? config.default_model, config)
  const candidateFallback = parseModelRef(
    input.fallback ?? config.default_fallback,
    config,
  )
  const fallback = candidateFallback.long === model.long ? undefined : candidateFallback
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
    slug,
    agentId,
    ...(instructions === undefined ? {} : { instructions }),
  }
  return fallback === undefined
    ? base
    : { ...base, fallback, fallbackAgentId: `${agentId}-fb` }
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
