import { describe, expect, test } from "bun:test"
import type { Part } from "@opencode-ai/sdk"

import { AdvisorCallError } from "../src/advisor/pass"
import {
  buildCatalog,
  classifyFailure,
  CooldownRegistry,
  displayName,
  ModelRefError,
  parseModelRef,
  pickModel,
} from "../src/models"

const ALIASES = {
  provider_aliases: { "bedrock-mantle": "amazon-bedrock" },
  variant_aliases: { max: "xhigh" },
} as const

const CONTENT_FILTER_PATTERNS = [
  "content[\\s_-]?filter",
  "filtering policy",
  "blocked by",
  "guardrail",
  "refusal",
  "output blocked",
] as const

describe("parseModelRef", () => {
  test("maps provider and variant aliases", () => {
    // Given
    const raw = "bedrock-mantle/openai.gpt-5.6-sol:max"

    // When
    const result = parseModelRef(raw, ALIASES)

    // Then
    expect(result).toEqual({
      providerID: "amazon-bedrock",
      modelID: "openai.gpt-5.6-sol",
      variant: "xhigh",
      long: "amazon-bedrock/openai.gpt-5.6-sol",
    })
  })

  test("omits the variant when no level is present", () => {
    // Given
    const raw = "amazon-bedrock/openai.gpt-5.6-sol"

    // When
    const result = parseModelRef(raw, ALIASES)

    // Then
    expect(result).toEqual({
      providerID: "amazon-bedrock",
      modelID: "openai.gpt-5.6-sol",
      long: "amazon-bedrock/openai.gpt-5.6-sol",
    })
  })

  test("passes an unknown variant through unchanged", () => {
    // Given
    const raw = "amazon-bedrock/openai.gpt-5.6-sol:high"

    // When
    const result = parseModelRef(raw, ALIASES)

    // Then
    expect(result.variant).toBe("high")
  })

  test("throws ModelRefError with the malformed ref", () => {
    // Given
    const raw = "sol"

    // When
    const parse = (): void => {
      parseModelRef(raw, ALIASES)
    }

    // Then
    expect(parse).toThrow(ModelRefError)
    expect(parse).toThrow(raw)
  })
})

describe("classifyFailure", () => {
  test("classifies Bedrock throttling text", () => {
    // Given
    const input = { thrown: new Error("ThrottlingException: retry later") }

    // When
    const result = classifyFailure(input, CONTENT_FILTER_PATTERNS)

    // Then
    expect(result).toBe("throttle")
  })

  test("classifies a 429 API error as throttling", () => {
    // Given
    const input = {
      info: {
        error: {
          name: "APIError",
          data: { message: "request failed", statusCode: 429 },
        },
      },
    }

    // When
    const result = classifyFailure(input, CONTENT_FILTER_PATTERNS)

    // Then
    expect(result).toBe("throttle")
  })

  test("classifies a provider authentication error", () => {
    // Given
    const input = {
      info: {
        error: {
          name: "ProviderAuthError",
          data: { message: "credentials rejected" },
        },
      },
    }

    // When
    const result = classifyFailure(input, CONTENT_FILTER_PATTERNS)

    // Then
    expect(result).toBe("auth")
  })

  test("classifies content filtering policy text", () => {
    // Given
    const input = { thrown: new Error("Output blocked by content filtering policy") }

    // When
    const result = classifyFailure(input, CONTENT_FILTER_PATTERNS)

    // Then
    expect(result).toBe("content_filter")
  })

  test("classifies guardrail text as a content filter failure", () => {
    // Given
    const input = { thrown: new Error("Bedrock guardrail intervened") }

    // When
    const result = classifyFailure(input, CONTENT_FILTER_PATTERNS)

    // Then
    expect(result).toBe("content_filter")
  })

  test("classifies a content-filter step finish reason", () => {
    // Given
    const part = {
      id: "part-1",
      sessionID: "session-1",
      messageID: "message-1",
      type: "step-finish",
      reason: "content-filter",
      cost: 0,
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    } satisfies Part

    // When
    const result = classifyFailure({ parts: [part] }, CONTENT_FILTER_PATTERNS)

    // Then
    expect(result).toBe("content_filter")
  })

  test("classifies an errored message without text or tools as empty", () => {
    // Given
    const input = {
      info: {
        error: { name: "UnknownError", data: { message: "generation ended" } },
      },
      parts: [],
    }

    // When
    const result = classifyFailure(input, CONTENT_FILTER_PATTERNS)

    // Then
    expect(result).toBe("empty")
  })

  test("returns null for a healthy message", () => {
    // Given
    const part = {
      id: "part-1",
      sessionID: "session-1",
      messageID: "message-1",
      type: "text",
      text: "Review completed",
    } satisfies Part

    // When
    const result = classifyFailure({ parts: [part] }, CONTENT_FILTER_PATTERNS)

    // Then
    expect(result).toBeNull()
  })

  test("checks content filters before API classification", () => {
    // Given
    const input = {
      info: {
        error: {
          name: "APIError",
          data: { message: "Output blocked by content filtering policy", statusCode: 500 },
        },
      },
    }

    // When
    const result = classifyFailure(input, CONTENT_FILTER_PATTERNS)

    // Then
    expect(result).toBe("content_filter")
  })

  test("classifies content-filter text nested in an SDK error detail", () => {
    // Given
    const error = new AdvisorCallError("advisor prompt failed", undefined, {
      name: "UnknownError",
      data: { message: "requested model does-not-exist" },
    })

    // When
    const result = classifyFailure({ thrown: error }, ["does-not-exist"])

    // Then
    expect(result).toBe("content_filter")
  })

  test("classifies throttling text nested in an SDK error detail", () => {
    // Given
    const error = new AdvisorCallError("advisor prompt failed", undefined, {
      name: "UnknownError",
      data: { message: "ThrottlingException: retry later" },
    })

    // When
    const result = classifyFailure({ thrown: error }, CONTENT_FILTER_PATTERNS)

    // Then
    expect(result).toBe("throttle")
  })

  test("classifies an AdvisorCallError status 429 as throttling", () => {
    // Given
    const error = new AdvisorCallError("advisor prompt failed", 429)

    // When
    const result = classifyFailure({ thrown: error }, CONTENT_FILTER_PATTERNS)

    // Then
    expect(result).toBe("throttle")
  })

  test("classifies a provider auth name nested in an SDK error detail", () => {
    // Given
    const error = new AdvisorCallError("advisor prompt failed", undefined, {
      name: "ProviderAuthError",
    })

    // When
    const result = classifyFailure({ thrown: error }, CONTENT_FILTER_PATTERNS)

    // Then
    expect(result).toBe("auth")
  })

  test("classifies an unrelated SDK error detail as API failure", () => {
    // Given
    const error = new AdvisorCallError("advisor prompt failed", undefined, {
      name: "UnknownError",
      data: { message: "provider returned an unrelated failure" },
    })

    // When
    const result = classifyFailure({ thrown: error }, CONTENT_FILTER_PATTERNS)

    // Then
    expect(result).toBe("api")
  })
})

describe("CooldownRegistry and pickModel", () => {
  const primary = parseModelRef("amazon-bedrock/openai.gpt-5.6-sol:xhigh", ALIASES)
  const fallback = parseModelRef("amazon-bedrock/us.anthropic.claude-fable-5-1:xhigh", ALIASES)

  test("returns the primary model when it is available", () => {
    // Given
    const registry = new CooldownRegistry(() => 1_000)

    // When
    const result = pickModel({ model: primary, fallback }, registry)

    // Then
    expect(result).toEqual({ ref: primary, isFallback: false })
  })

  test("returns the single fallback when the primary is cooled", () => {
    // Given
    const registry = new CooldownRegistry(() => 1_000)
    registry.markCooled(primary.long, 500)

    // When
    const result = pickModel({ model: primary, fallback }, registry)

    // Then
    expect(result).toEqual({ ref: fallback, isFallback: true })
  })

  test("returns null when both models are cooled", () => {
    // Given
    const registry = new CooldownRegistry(() => 1_000)
    registry.markCooled(primary.long, 500)
    registry.markCooled(fallback.long, 500)

    // When
    const result = pickModel({ model: primary, fallback }, registry)

    // Then
    expect(result).toBeNull()
  })

  test("restores the primary after its cooldown expires", () => {
    // Given
    let now = 1_000
    const registry = new CooldownRegistry(() => now)
    registry.markCooled(primary.long, 500)
    now = 1_501
    registry.restoreExpired()

    // When
    const result = pickModel({ model: primary, fallback }, registry)

    // Then
    expect(result).toEqual({ ref: primary, isFallback: false })
  })

  test("returns the active cooldown expiry and omits it after expiry", () => {
    // Given
    let now = 1_000
    const registry = new CooldownRegistry(() => now)
    registry.markCooled(primary.long, 500)

    // When
    const active = registry.cooledUntil(primary.long)
    now = 1_501
    const expired = registry.cooledUntil(primary.long)

    // Then
    expect(active).toBe(1_500)
    expect(expired).toBeUndefined()
  })
})

describe("model display names", () => {
  test("uses a provider catalog model name", () => {
    // Given
    const catalog = buildCatalog({
      providers: [
        {
          id: "amazon-bedrock",
          models: { "openai.gpt-5.6-sol": { name: "GPT-5.6 Sol" } },
        },
      ],
    })
    const ref = parseModelRef("amazon-bedrock/openai.gpt-5.6-sol:xhigh", ALIASES)

    // When
    const result = displayName(ref, catalog)

    // Then
    expect(result).toBe("GPT-5.6 Sol")
  })

  test("strips known vendor prefixes when the catalog has no name", () => {
    // Given
    const catalog = buildCatalog({ providers: [] })
    const openAI = parseModelRef("amazon-bedrock/openai.gpt-5.6-sol", ALIASES)
    const anthropic = parseModelRef("amazon-bedrock/us.anthropic.claude-fable-5-1", ALIASES)

    // When
    const openAIName = displayName(openAI, catalog)
    const anthropicName = displayName(anthropic, catalog)

    // Then
    expect(openAIName).toBe("gpt-5.6-sol")
    expect(anthropicName).toBe("claude-fable-5-1")
  })
})
