import { parse as parseYaml } from "yaml"

import type { AdvisorSeverity } from "../config"
import { ModelRefError, parseModelRef } from "../models"
import { normalizeTools, resolveEntry } from "./agents"
import type {
  AdvisorEntry,
  ParsedRoster,
  RosterAdvisorInput,
  RosterConfig,
} from "./types"
import { whenField } from "./when"

type ParseContext = Readonly<{
  config: RosterConfig
  warnings: string[]
}>

type EntryParseContext = ParseContext & Readonly<{
  label: string
  seenNames: Set<string>
}>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
}

function isSeverity(value: unknown): value is AdvisorSeverity {
  return value === "nit" || value === "concern" || value === "blocker"
}

function parseYamlText(text: string): unknown {
  if (typeof Bun !== "undefined" && typeof Bun.YAML?.parse === "function") {
    return Bun.YAML.parse(text)
  }
  return parseYaml(text)
}

function modelField(
  value: unknown,
  key: "model" | "fallback",
  context: ParseContext & Readonly<{ label: string }>,
): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "string") {
    context.warnings.push(`${context.label} ${key} must be a string; using the default`)
    return undefined
  }
  try {
    parseModelRef(value, context.config)
    return value
  } catch (error) {
    if (error instanceof ModelRefError) {
      context.warnings.push(`${context.label} ${key} is malformed; using the default`)
      return undefined
    }
    throw error
  }
}

function toolsField(
  value: unknown,
  context: ParseContext & Readonly<{ label: string }>,
): readonly string[] | undefined {
  if (value === undefined) return undefined
  if (!isStringArray(value)) {
    context.warnings.push(`${context.label} tools must be a list of strings; using the default set`)
    return undefined
  }
  const normalized = normalizeTools(value)
  context.warnings.push(
    ...normalized.warnings.map((warning) => `${context.label}: ${warning}`),
  )
  return normalized.granted
}

function instructionsField(
  record: Record<string, unknown>,
  context: ParseContext & Readonly<{ label: string }>,
): string | undefined {
  const instructions = record["instructions"]
  if (typeof instructions === "string") return instructions
  if (instructions !== undefined) {
    context.warnings.push(`${context.label} instructions must be a string`)
  }
  const prompt = record["prompt"]
  if (typeof prompt === "string") return prompt
  if (prompt !== undefined) context.warnings.push(`${context.label} prompt must be a string`)
  return undefined
}

function inputEntry(
  value: unknown,
  index: number,
  context: ParseContext & Readonly<{ seenNames: Set<string> }>,
): RosterAdvisorInput | undefined {
  const label = `Advisor #${index + 1}`
  const entryContext: EntryParseContext = { ...context, label }
  if (!isRecord(value)) {
    context.warnings.push(`${label} must be an object and was dropped`)
    return undefined
  }
  const rawName = value["name"]
  if (typeof rawName !== "string" || rawName.trim().length === 0) {
    context.warnings.push(`${label} requires a non-empty name and was dropped`)
    return undefined
  }
  const name = rawName.trim()
  if (context.seenNames.has(name)) {
    context.warnings.push(`Duplicate advisor name "${name}" was dropped`)
    return undefined
  }
  context.seenNames.add(name)

  const rawEnabled = value["enabled"]
  if (rawEnabled !== undefined && typeof rawEnabled !== "boolean") {
    context.warnings.push(`${label} enabled must be boolean; using true`)
  }
  const severities = severityFields(value, entryContext)
  const model = modelField(value["model"], "model", entryContext)
  const fallback = modelField(value["fallback"], "fallback", entryContext)
  const tools = toolsField(value["tools"], entryContext)
  const instructions = instructionsField(value, entryContext)
  const when = whenField(value["when"], entryContext)
  return {
    name,
    enabled: typeof rawEnabled === "boolean" ? rawEnabled : true,
    ...(model === undefined ? {} : { model }),
    ...(fallback === undefined ? {} : { fallback }),
    ...(tools === undefined ? {} : { tools }),
    ...(instructions === undefined ? {} : { instructions }),
    ...(when === undefined ? {} : { when }),
    ...severities,
  }
}

const SEVERITY_KEYS = ["min_severity", "chat_min_severity", "inject_min_severity"] as const

function severityFields(
  record: Record<string, unknown>,
  context: ParseContext & Readonly<{ label: string }>,
): Partial<Record<(typeof SEVERITY_KEYS)[number], AdvisorSeverity>> {
  const result: Partial<Record<(typeof SEVERITY_KEYS)[number], AdvisorSeverity>> = {}
  for (const key of SEVERITY_KEYS) {
    const raw = record[key]
    if (raw === undefined) continue
    if (isSeverity(raw)) result[key] = raw
    else context.warnings.push(`${context.label} ${key} is invalid; using the configured default`)
  }
  return result
}

function parsedRoster(value: unknown, config: RosterConfig): ParsedRoster {
  const warnings: string[] = []
  if (!isRecord(value)) {
    return { advisors: [], warnings: ["Roster root must be an object"] }
  }
  const rawInstructions = value["instructions"]
  const instructions = typeof rawInstructions === "string" ? rawInstructions : undefined
  if (rawInstructions !== undefined && instructions === undefined) {
    warnings.push("Roster instructions must be a string and were ignored")
  }
  const rawAdvisors = value["advisors"]
  if (!Array.isArray(rawAdvisors)) {
    warnings.push("Roster advisors must be a list")
    return instructions === undefined
      ? { advisors: [], warnings }
      : { instructions, advisors: [], warnings }
  }

  const seenNames = new Set<string>()
  const context = { config, warnings, seenNames }
  const advisors: AdvisorEntry[] = []
  for (const [index, valueEntry] of rawAdvisors.entries()) {
    const input = inputEntry(valueEntry, index, context)
    if (input === undefined) continue
    const entry = resolveEntry(input, config)
    if (entry === undefined) {
      warnings.push(`Advisor "${input.name}" has no model and no default_model is configured; skipped`)
      continue
    }
    if (entry.fallback === undefined && (input.fallback ?? config.default_fallback) !== undefined) {
      warnings.push(`Advisor "${entry.name}" fallback matches its model and was dropped`)
    }
    advisors.push(entry)
  }
  return instructions === undefined
    ? { advisors, warnings }
    : { instructions, advisors, warnings }
}

export function parseRoster(text: string, config: RosterConfig): ParsedRoster {
  let parsed: unknown
  try {
    parsed = parseYamlText(text)
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown YAML parse failure"
    return { advisors: [], warnings: [`Invalid WATCHDOG YAML: ${detail}`] }
  }
  try {
    return parsedRoster(parsed, config)
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown roster validation failure"
    return { advisors: [], warnings: [`Invalid WATCHDOG roster: ${detail}`] }
  }
}

export function defaultRoster(config: RosterConfig): ParsedRoster {
  const entry = resolveEntry({ name: "Advisor", enabled: true }, config)
  if (entry === undefined) {
    return {
      advisors: [],
      warnings: ["No usable roster entries and no default_model configured; no advisors will run"],
    }
  }
  const warnings = entry.fallback === undefined && config.default_fallback !== undefined
    ? [`Advisor "${entry.name}" fallback matches its model and was dropped`]
    : []
  return { advisors: [entry], warnings }
}
