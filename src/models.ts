import type { Part } from "@opencode-ai/sdk"

export type ModelRef = {
  readonly providerID: string
  readonly modelID: string
  readonly variant?: string
  readonly effort?: string
  readonly long: string
}

export type ModelAliases = {
  readonly provider_aliases: Readonly<Record<string, string>>
  readonly variant_aliases: Readonly<Record<string, string>>
}

export type FailureKind = "throttle" | "auth" | "api" | "content_filter" | "empty" | "poisoned_session"

const POISONED_SESSION = /cache point cannot be inserted after reasoning/i

export class ModelRefError extends Error {
  readonly name = "ModelRefError"

  constructor(readonly raw: string) {
    super(`Malformed model ref: ${raw}`)
  }
}

export function parseModelRef(raw: string, aliases: ModelAliases): ModelRef {
  const slash = raw.indexOf("/")
  const colon = raw.lastIndexOf(":")
  const hasVariant = colon > slash
  const provider = raw.slice(0, slash)
  const modelID = raw.slice(slash + 1, hasVariant ? colon : undefined)
  const requestedLevel = hasVariant ? raw.slice(colon + 1) : undefined

  if (slash < 1 || modelID.length === 0 || (hasVariant && requestedLevel?.length === 0)) {
    throw new ModelRefError(raw)
  }

  const providerID = aliases.provider_aliases[provider] ?? provider
  const long = `${providerID}/${modelID}`
  if (requestedLevel === undefined) {
    return { providerID, modelID, long }
  }
  const effort = requestedLevel.toLowerCase()
  return {
    providerID,
    modelID,
    variant: aliases.variant_aliases[effort] ?? effort,
    effort,
    long,
  }
}

export function displayLevel(ref: ModelRef): string | undefined {
  return ref.effort ?? ref.variant
}

export type FailureInput = {
  readonly thrown?: unknown
  readonly info?: {
    readonly error?: {
      readonly name: string
      readonly data?: { readonly message?: string; readonly statusCode?: number; readonly responseBody?: string }
    }
  }
  readonly parts?: readonly Part[]
}

export function classifyFailure(
  input: FailureInput,
  patterns: readonly string[],
): FailureKind | null {
  const details = failureDetails(input)
  const text = details.text.join("\n")
  if (details.statusCodes.includes(400) && POISONED_SESSION.test(text)) {
    return "poisoned_session"
  }
  const contentFilterStep = input.parts?.some(
    (part) =>
      part.type === "step-finish" &&
      (part.reason === "content-filter" || part.reason === "content_filter"),
  )

  if (contentFilterStep || patterns.some((pattern) => new RegExp(pattern, "i").test(text))) {
    return "content_filter"
  }
  if (details.statusCodes.includes(429) || /429|ThrottlingException|TooManyRequests|quota/i.test(text)) {
    return "throttle"
  }
  if (
    details.names.includes("ProviderAuthError") ||
    details.statusCodes.includes(401) ||
    details.statusCodes.includes(403) ||
    /\b(?:401|403)\b/.test(text)
  ) {
    return "auth"
  }
  if (
    details.names.some((name) => /^(?:apierror|unknownerror|messageoutputlengtherror|messageabortederror)$/i.test(name)) ||
    details.statusCodes.some((status) => status >= 500)
  ) {
    return "api"
  }

  const hasOutput = input.parts?.some((part) => part.type === "text" || part.type === "tool") ?? false
  if (input.info?.error !== undefined && !hasOutput) {
    return "empty"
  }
  return details.hasFailure ? "api" : null
}

export class CooldownRegistry {
  private readonly cooldowns = new Map<string, number>()

  constructor(private readonly clock: () => number = Date.now) {}

  markCooled(long: string, ms: number): void {
    this.cooldowns.set(long, this.clock() + ms)
  }

  isCooled(long: string): boolean {
    return this.cooledUntil(long) !== undefined
  }

  cooledUntil(long: string): number | undefined {
    const until = this.cooldowns.get(long)
    return until !== undefined && until > this.clock() ? until : undefined
  }

  restoreExpired(): void {
    const now = this.clock()
    for (const [long, until] of this.cooldowns) {
      if (until <= now) {
        this.cooldowns.delete(long)
      }
    }
  }
}

export function pickModel(
  entry: { readonly model: ModelRef; readonly fallback?: ModelRef },
  registry: CooldownRegistry,
): { readonly ref: ModelRef; readonly isFallback: boolean } | null {
  if (!registry.isCooled(entry.model.long)) {
    return { ref: entry.model, isFallback: false }
  }
  if (entry.fallback !== undefined && !registry.isCooled(entry.fallback.long)) {
    return { ref: entry.fallback, isFallback: true }
  }
  return null
}

export type ModelCatalog = ReadonlyMap<string, string>

export function buildCatalog(response: {
  readonly providers: readonly {
    readonly id: string
    readonly models: Readonly<Record<string, { readonly name?: string }>>
  }[]
}): ModelCatalog {
  const catalog = new Map<string, string>()
  for (const provider of response.providers) {
    for (const [modelID, model] of Object.entries(provider.models)) {
      if (model.name !== undefined && model.name.length > 0) {
        catalog.set(`${provider.id}/${modelID}`, model.name)
      }
    }
  }
  return catalog
}

export function displayName(ref: ModelRef, catalog: ModelCatalog): string {
  return catalog.get(ref.long) ?? ref.modelID
}

type FailureDetails = {
  readonly names: readonly string[]
  readonly text: readonly string[]
  readonly statusCodes: readonly number[]
  readonly hasFailure: boolean
}

type FailureAccumulator = {
  readonly names: string[]
  readonly text: string[]
  readonly statusCodes: number[]
}

function collectFailure(value: unknown, depth: number, result: FailureAccumulator): void {
  if (depth > 3 || value === null || value === undefined) return
  if (typeof value === "string") {
    result.text.push(value)
    return
  }
  if (typeof value !== "object") return

  if ("name" in value && typeof value.name === "string") {
    result.names.push(value.name)
    result.text.push(value.name)
  }
  if ("message" in value && typeof value.message === "string") result.text.push(value.message)
  if ("responseBody" in value && typeof value.responseBody === "string") result.text.push(value.responseBody)
  if ("statusCode" in value && typeof value.statusCode === "number") result.statusCodes.push(value.statusCode)
  if ("status" in value && typeof value.status === "number") result.statusCodes.push(value.status)
  if ("detail" in value) collectFailure(value.detail, depth + 1, result)
  if ("data" in value) collectFailure(value.data, depth + 1, result)
  if ("error" in value) collectFailure(value.error, depth + 1, result)
  if ("cause" in value) collectFailure(value.cause, depth + 1, result)
}

function failureDetails(input: FailureInput): FailureDetails {
  const result: FailureAccumulator = { names: [], text: [], statusCodes: [] }
  collectFailure(input.info?.error, 0, result)
  collectFailure(input.thrown, 0, result)
  return { ...result, hasFailure: input.thrown !== undefined || input.info?.error !== undefined }
}
