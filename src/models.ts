import type { Part } from "@opencode-ai/sdk"

export type ModelRef = {
  readonly providerID: string
  readonly modelID: string
  readonly variant?: string
  readonly long: string
}

export type ModelAliases = {
  readonly provider_aliases: Readonly<Record<string, string>>
  readonly variant_aliases: Readonly<Record<string, string>>
}

export type FailureKind = "throttle" | "auth" | "api" | "content_filter" | "empty"

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
  const variant = hasVariant ? raw.slice(colon + 1) : undefined

  if (slash < 1 || modelID.length === 0 || (hasVariant && variant?.length === 0)) {
    throw new ModelRefError(raw)
  }

  const providerID = aliases.provider_aliases[provider] ?? provider
  const long = `${providerID}/${modelID}`
  if (variant === undefined) {
    return { providerID, modelID, long }
  }
  return {
    providerID,
    modelID,
    variant: aliases.variant_aliases[variant] ?? variant,
    long,
  }
}

export type FailureInput = {
  readonly thrown?: unknown
  readonly info?: {
    readonly error?: {
      readonly name: string
      readonly data?: { readonly message?: string; readonly statusCode?: number }
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
  const contentFilterStep = input.parts?.some(
    (part) =>
      part.type === "step-finish" &&
      (part.reason === "content-filter" || part.reason === "content_filter"),
  )

  if (contentFilterStep || patterns.some((pattern) => new RegExp(pattern, "i").test(text))) {
    return "content_filter"
  }
  if (details.statusCode === 429 || /429|ThrottlingException|TooManyRequests|quota/i.test(text)) {
    return "throttle"
  }
  if (
    details.names.includes("ProviderAuthError") ||
    details.statusCode === 401 ||
    details.statusCode === 403 ||
    /\b(?:401|403)\b/.test(text)
  ) {
    return "auth"
  }
  if (
    details.names.some((name) => /^apierror$/i.test(name)) ||
    (details.statusCode !== undefined && details.statusCode >= 500)
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
  private readonly cooledUntil = new Map<string, number>()

  constructor(private readonly clock: () => number = Date.now) {}

  markCooled(long: string, ms: number): void {
    this.cooledUntil.set(long, this.clock() + ms)
  }

  isCooled(long: string): boolean {
    const until = this.cooledUntil.get(long)
    return until !== undefined && until > this.clock()
  }

  restoreExpired(): void {
    const now = this.clock()
    for (const [long, until] of this.cooledUntil) {
      if (until <= now) {
        this.cooledUntil.delete(long)
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
  const catalogName = catalog.get(ref.long)
  if (catalogName !== undefined) {
    return catalogName
  }
  const modelID = ref.modelID.startsWith(`${ref.providerID}/`)
    ? ref.modelID.slice(ref.providerID.length + 1)
    : ref.modelID
  return modelID.replace(/^(?:us\.anthropic\.|anthropic\.|openai\.)/, "")
}

type FailureDetails = {
  readonly names: readonly string[]
  readonly text: readonly string[]
  readonly statusCode?: number
  readonly hasFailure: boolean
}

function failureDetails(input: FailureInput): FailureDetails {
  const names: string[] = []
  const text: string[] = []
  let statusCode: number | undefined

  if (input.info?.error !== undefined) {
    names.push(input.info.error.name)
    text.push(input.info.error.name)
    if (input.info.error.data?.message !== undefined) {
      text.push(input.info.error.data.message)
    }
    statusCode = input.info.error.data?.statusCode
  }

  if (typeof input.thrown === "string") {
    text.push(input.thrown)
  } else if (input.thrown instanceof Error) {
    names.push(input.thrown.name)
    text.push(input.thrown.name, input.thrown.message)
  } else if (typeof input.thrown === "object" && input.thrown !== null) {
    if ("name" in input.thrown && typeof input.thrown.name === "string") {
      names.push(input.thrown.name)
      text.push(input.thrown.name)
    }
    if ("message" in input.thrown && typeof input.thrown.message === "string") {
      text.push(input.thrown.message)
    }
    if ("statusCode" in input.thrown && typeof input.thrown.statusCode === "number") {
      statusCode = input.thrown.statusCode
    }
  }

  const base = { names, text, hasFailure: input.thrown !== undefined || input.info?.error !== undefined }
  return statusCode === undefined ? base : { ...base, statusCode }
}
