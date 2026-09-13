import { EDIT_TOOLS, SHELL_TOOLS, type ReviewTrigger } from "./types"

export type WhenParseContext = Readonly<{
  label: string
  warnings: string[]
}>

export const NEVER_FIRES: ReviewTrigger = { edits: [], commands: [], tools: [] }

const PATH_TOOL_NAMES: ReadonlySet<string> = new Set(EDIT_TOOLS)
const SHELL_TOOL_NAMES: ReadonlySet<string> = new Set(SHELL_TOOLS)

function stringList(value: unknown, key: string, context: WhenParseContext): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    context.warnings.push(`${context.label} when.${key} must be a list of strings; ignored`)
    return []
  }
  return value
}

function usableCommands(patterns: readonly string[], context: WhenParseContext): string[] {
  return patterns.filter((pattern) => {
    try {
      new RegExp(pattern)
      return true
    } catch {
      context.warnings.push(`${context.label} when.commands pattern ${JSON.stringify(pattern)} is not a valid regex; dropped`)
      return false
    }
  })
}

function usableTools(names: readonly string[], context: WhenParseContext): string[] {
  return names.filter((name) => {
    if (PATH_TOOL_NAMES.has(name)) {
      context.warnings.push(`${context.label} when.tools must not name ${name}; use when.edits so the edited path is matched`)
      return false
    }
    if (SHELL_TOOL_NAMES.has(name)) {
      context.warnings.push(`${context.label} when.tools must not name ${name}; use when.commands so the command text is matched`)
      return false
    }
    return true
  })
}

export function whenField(value: unknown, context: WhenParseContext): ReviewTrigger | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    context.warnings.push(`${context.label} when must be an object; this advisor will never run`)
    return NEVER_FIRES
  }
  const record = value as Record<string, unknown>
  const trigger: ReviewTrigger = {
    edits: stringList(record["edits"], "edits", context),
    commands: usableCommands(stringList(record["commands"], "commands", context), context),
    tools: usableTools(stringList(record["tools"], "tools", context), context),
  }
  if (trigger.edits.length + trigger.commands.length + trigger.tools.length === 0) {
    context.warnings.push(`${context.label} when has no usable triggers; this advisor will never run`)
  }
  return trigger
}
