import { describe, expect, test } from "bun:test"
import { join } from "node:path"

import { DEFAULTS } from "../src/config"
import {
  DELIVERY_AGENT_ID,
  KNOWN_BUILTINS,
  defaultRoster,
  deliveryAgentConfig,
  discoverRosterFiles,
  normalizeTools,
  parseRoster,
  resolveEntry,
  slugify,
  toAgentConfig,
  toFallbackAgentConfig,
} from "../src/roster"

const REAL_WATCHDOG = [
  "instructions: |",
  "  Review the primary agent independently. Surface only concrete mistakes, missing constraints, security risks, or materially better approaches.",
  "  One note per update. Use `nit` for cleanup, `concern` for a likely wrong direction or missed constraint, `blocker` only when continuing clearly wastes work or ships broken output.",
  "  You cannot see other advisors' notes. If the primary has already acknowledged or fixed a point, stay silent rather than repeating it.",
  '  Staying silent means ending your update WITHOUT calling the advise tool. Never call advise to say "silence", "all clear", "on track", "waiting", "mid-turn" or that you have nothing to add. Every advise call must carry one concrete problem and one concrete fix.',
  "",
  "advisors:",
  "  # Two reviewers on both profiles (owner rulings 2026-09-09: GLM 5.3 removed, Fable 5.1 added).",
  "  # OpenAI family, Bedrock Mantle (per-token).",
  "  - name: Reviewer (GPT-5.6 Sol:max)",
  "    enabled: true",
  "    model: bedrock-mantle/openai.gpt-5.6-sol:max",
  "    tools: [read, grep, glob]",
  "    instructions: |",
  "      Act as the primary rigorous reviewer. Check correctness, completeness, architecture, and whether verification proves the requested behavior.",
  "      Prefer reading the changed files over trusting the primary's summary.",
  "",
  "  # Same family as the primary (Claude on Bedrock); the owner accepted that trade-off for a second view.",
  "  - name: Reviewer (Claude Fable 5.1:xhigh)",
  "    enabled: true",
  "    model: amazon-bedrock/us.anthropic.claude-fable-5-1:xhigh",
  "    tools: [read, grep, glob]",
  "    instructions: |",
  "      Act as the primary rigorous reviewer. Check correctness, completeness, architecture, and whether verification proves the requested behavior.",
  "      Prefer reading the changed files over trusting the primary's summary.",
].join("\n")

function propertyValue(object: object | undefined, key: string): unknown {
  return Object.entries(object ?? {}).find(([entryKey]) => entryKey === key)?.[1]
}

describe("parseRoster", () => {
  test("accepts the user's omp roster verbatim", () => {
    // Given / When
    const result = parseRoster(REAL_WATCHDOG, DEFAULTS)

    // Then
    expect(result.instructions).toContain("Review the primary agent independently")
    expect(result.advisors).toHaveLength(2)
    expect(result.advisors.every((entry) => entry.enabled)).toBeTrue()
    expect(result.advisors.map((entry) => entry.model.long)).toEqual([
      "amazon-bedrock/openai.gpt-5.6-sol",
      "amazon-bedrock/us.anthropic.claude-fable-5-1",
    ])
    expect(result.advisors.map((entry) => entry.model.variant)).toEqual(["xhigh", "xhigh"])
    expect(result.advisors.map((entry) => entry.model.effort)).toEqual(["max", "xhigh"])
    expect(result.advisors.map((entry) => entry.tools)).toEqual([
      ["read", "grep", "glob"],
      ["read", "grep", "glob"],
    ])
    expect(result.advisors[0]?.fallback?.long).toBe(
      "amazon-bedrock/us.anthropic.claude-fable-5-1",
    )
    expect(result.advisors[1]?.fallback).toBeUndefined()
  })

  test("drops a later duplicate name with a warning", () => {
    // Given
    const text = `advisors:
  - name: Duplicate
  - name: Duplicate`

    // When
    const result = parseRoster(text, DEFAULTS)

    // Then
    expect(result.advisors).toHaveLength(1)
    expect(result.warnings).toEqual([expect.stringContaining("Duplicate")])
  })

  test("defaults enabled and accepts prompt as an instructions alias", () => {
    // Given
    const text = `advisors:
  - name: Prompt reviewer
    prompt: Review public behavior.
    min_severity: blocker`

    // When
    const result = parseRoster(text, DEFAULTS)

    // Then
    expect(result.advisors[0]?.enabled).toBeTrue()
    expect(result.advisors[0]?.instructions).toBe("Review public behavior.")
    expect(result.advisors[0]?.min_severity).toBe("blocker")
  })

  test("uses defaults and warns when model fields are lists", () => {
    // Given
    const text = `advisors:
  - name: List models
    model: [provider/a, provider/b]
    fallback: [provider/c, provider/d]`

    // When
    const result = parseRoster(text, DEFAULTS)

    // Then
    expect(result.advisors[0]?.model.long).toBe("amazon-bedrock/openai.gpt-5.6-sol")
    expect(result.advisors[0]?.fallback?.long).toBe(
      "amazon-bedrock/us.anthropic.claude-fable-5-1",
    )
    expect(result.warnings).toEqual([
      expect.stringContaining("model"),
      expect.stringContaining("fallback"),
    ])
  })

  test("returns zero advisors and a warning for invalid YAML", () => {
    // Given / When
    const result = parseRoster("advisors:\n  - name: [", DEFAULTS)

    // Then
    expect(result.advisors).toEqual([])
    expect(result.warnings).toHaveLength(1)
  })

  test("returns zero advisors when advisors is not a list", () => {
    // Given / When
    const result = parseRoster("advisors: invalid", DEFAULTS)

    // Then
    expect(result.advisors).toEqual([])
    expect(result.warnings).toEqual([expect.stringContaining("advisors")])
  })
})

describe("roster defaults and identity", () => {
  test("slugifies display names into stable agent suffixes", () => {
    // Given / When / Then
    expect(slugify("Reviewer (GPT-5.6 Sol:max)")).toBe("reviewer-gpt-5-6-sol-max")
    expect(slugify("  Security___Review  ")).toBe("security-review")
  })

  test("builds one enabled default advisor", () => {
    // Given / When
    const result = defaultRoster(DEFAULTS)

    // Then
    expect(result.advisors).toHaveLength(1)
    expect(result.advisors[0]?.name).toBe("Advisor")
    expect(result.advisors[0]?.enabled).toBeTrue()
  })

  test("drops a fallback that resolves to the primary model", () => {
    // Given
    const config = {
      ...DEFAULTS,
      default_model: "amazon-bedrock/us.anthropic.claude-fable-5-1:xhigh",
      default_fallback: "amazon-bedrock/us.anthropic.claude-fable-5-1:xhigh",
    }

    // When
    const entry = resolveEntry({ name: "Same model", enabled: true }, config)

    // Then
    expect(entry.fallback).toBeUndefined()
    expect(entry.fallbackAgentId).toBeUndefined()
  })
})

describe("discoverRosterFiles", () => {
  const cwd = "/work/project"
  const home = "/home/tester"

  test("selects the first existing YAML and all markdown in documented order", () => {
    // Given
    const existing = new Set([
      join(cwd, "WATCHDOG.yaml"),
      join(cwd, ".opencode", "WATCHDOG.yml"),
      join(home, ".config", "opencode", "WATCHDOG.yml"),
      join(home, ".omp", "agent", "WATCHDOG.yml"),
      join(cwd, "WATCHDOG.md"),
      join(home, ".config", "opencode", "WATCHDOG.md"),
    ])

    // When
    const result = discoverRosterFiles({ cwd, home, exists: (path) => existing.has(path) })

    // Then
    expect(result).toEqual({
      yml: join(cwd, "WATCHDOG.yaml"),
      md: [
        join(cwd, "WATCHDOG.md"),
        join(home, ".config", "opencode", "WATCHDOG.md"),
      ],
    })
  })

  test("falls through both extensions to the omp compatibility path", () => {
    // Given
    const ompYaml = join(home, ".omp", "agent", "WATCHDOG.yaml")

    // When
    const result = discoverRosterFiles({ cwd, home, exists: (path) => path === ompYaml })

    // Then
    expect(result).toEqual({ yml: ompYaml, md: [] })
  })
})

describe("normalizeTools", () => {
  test("uses the read-only defaults only when tools are omitted", () => {
    // Given / When / Then
    expect(normalizeTools(undefined)).toEqual({
      granted: ["read", "grep", "glob"],
      warnings: [],
    })
    expect(normalizeTools([])).toEqual({ granted: [], warnings: [] })
  })

  test("maps legacy search and find aliases", () => {
    // Given / When
    const result = normalizeTools(["search", "find"])

    // Then
    expect(result).toEqual({ granted: ["grep", "glob"], warnings: [] })
  })

  test("falls back to the default set when every explicit tool is unknown", () => {
    // Given / When
    const result = normalizeTools(["foo"])

    // Then
    expect(result.granted).toEqual(["read", "grep", "glob"])
    expect(result.warnings.length).toBeGreaterThanOrEqual(1)
    expect(result.warnings.join("\n")).toContain("foo")
  })
})

describe("advisor AgentConfig builders", () => {
  test("keeps the complete offline built-in list stable", () => {
    // Given / When / Then
    expect(KNOWN_BUILTINS).toEqual([
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
    ])
  })

  test("grants requested mutation tools and asks for edit and bash permission", () => {
    // Given
    const entry = resolveEntry(
      { name: "Editor", enabled: true, tools: ["edit", "bash"] },
      DEFAULTS,
    )

    // When
    const config = toAgentConfig(entry, "system prompt")

    // Then
    expect(entry.agentId).toBe("advisor-editor")
    expect(config).toMatchObject({
      description: "Advisor watchdog: Editor",
      mode: "subagent",
      hidden: true,
      model: "amazon-bedrock/openai.gpt-5.6-sol",
      variant: "xhigh",
      prompt: "system prompt",
      maxSteps: 12,
      permission: {
        edit: "ask",
        bash: "ask",
        webfetch: "deny",
        external_directory: "deny",
      },
    })
    expect(config.tools?.["edit"]).toBeTrue()
    expect(config.tools?.["bash"]).toBeTrue()
    expect(config.tools?.["read"]).toBeUndefined()
    expect(Object.keys(config.tools ?? {})[0]).toBe("*")
    expect(config.tools?.["*"]).toBeFalse()
    expect(Object.keys(config.permission ?? {})[0]).toBe("*")
    expect(propertyValue(config.permission, "*")).toBe("deny")
  })

  test("allows only granted investigative permissions after the catch-all deny", () => {
    // Given
    const entry = resolveEntry(
      { name: "Reader", enabled: true, tools: ["read", "grep", "glob"] },
      DEFAULTS,
    )

    // When
    const config = toAgentConfig(entry, "system prompt")

    // Then
    expect(propertyValue(config.permission, "read")).toBe("allow")
    expect(propertyValue(config.permission, "grep")).toBe("allow")
    expect(propertyValue(config.permission, "glob")).toBe("allow")
    expect(config.permission?.bash).toBe("deny")
  })

  test("turns every built-in off for an explicit empty grant", () => {
    // Given
    const entry = resolveEntry({ name: "No tools", enabled: true, tools: [] }, DEFAULTS)

    // When
    const config = toAgentConfig(entry, "system prompt")

    // Then
    expect(Object.values(config.tools ?? {}).filter(Boolean)).toEqual([])
  })

  test("uses the fallback model and variant for the fallback agent config", () => {
    // Given
    const entry = resolveEntry({ name: "Reviewer", enabled: true }, DEFAULTS)

    // When
    const config = toFallbackAgentConfig(entry, "system prompt")

    // Then
    expect(entry.fallbackAgentId).toBe("advisor-reviewer-fb")
    expect(config?.model).toBe("amazon-bedrock/us.anthropic.claude-fable-5-1")
    expect(config?.["variant"]).toBe("xhigh")
  })

  test("builds the restricted delivery agent config", () => {
    // Given / When
    const config = deliveryAgentConfig()

    // Then
    expect(DELIVERY_AGENT_ID).toBe("advisor-delivery")
    expect(config.description).toBe("Advisor card delivery")
    expect(config.mode).toBe("subagent")
    expect(config["hidden"]).toBeTrue()
    expect(Object.keys(config.tools ?? {})[0]).toBe("*")
    expect(config.tools?.["*"]).toBeFalse()
    expect(config.tools?.["bash"]).toBeTrue()
    expect(Object.keys(config.permission ?? {})[0]).toBe("*")
    expect(Object.entries(config.permission ?? {})).toEqual([
      ["*", "deny"],
      ["bash", { "advisor*": "allow", "*": "deny" }],
      ["edit", "deny"],
      ["webfetch", "deny"],
    ])
  })
})
