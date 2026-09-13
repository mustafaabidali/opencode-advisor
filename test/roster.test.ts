import { describe, expect, test } from "bun:test"
import { join } from "node:path"

import { DEFAULTS } from "../src/config"

const CONFIG = {
  ...DEFAULTS,
  default_model: "amazon-bedrock/openai.gpt-5.6-sol:max",
  default_fallback: "amazon-bedrock/us.anthropic.claude-fable-5-1:xhigh",
}

function resolved(input: Parameters<typeof resolveEntry>[0], config = CONFIG) {
  const entry = resolveEntry(input, config)
  if (entry === undefined) throw new Error("fixture entry must resolve")
  return entry
}
import {
  DELIVERY_AGENT_ID,
  KNOWN_BUILTINS,
  defaultRoster,
  deliveryAgentConfig,
  discoverRosterFiles,
  normalizeTools,
  parseRoster,
  resolveEntry,
  rosterFloors,
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
    const result = parseRoster(REAL_WATCHDOG, CONFIG)

    // Then
    expect(result.instructions).toContain("Review the primary agent independently")
    expect(result.advisors).toHaveLength(2)
    expect(result.advisors.every((entry) => entry.enabled)).toBeTrue()
    expect(result.advisors.map((entry) => entry.model.long)).toEqual([
      "amazon-bedrock/openai.gpt-5.6-sol",
      "amazon-bedrock/us.anthropic.claude-fable-5-1",
    ])
    expect(result.advisors.map((entry) => entry.model.variant)).toEqual(["max", "xhigh"])
    expect(result.advisors.map((entry) => entry.model.effort)).toEqual(["max", "xhigh"])
    expect(result.advisors.map((entry) => entry.tools)).toEqual([
      ["read", "grep", "glob"],
      ["read", "grep", "glob"],
    ])
    expect(result.advisors[0]?.fallback?.long).toBe(
      "amazon-bedrock/us.anthropic.claude-fable-5-1",
    )
    expect(result.advisors[1]?.fallback?.long).toBe("amazon-bedrock/openai.gpt-5.6-sol")
    expect(result.advisors[1]?.fallback?.variant).toBe("max")
    expect(result.warnings).toEqual([])
  })

  test("drops a later duplicate name with a warning", () => {
    // Given
    const text = `advisors:
  - name: Duplicate
  - name: Duplicate`

    // When
    const result = parseRoster(text, CONFIG)

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
    const result = parseRoster(text, CONFIG)

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
    const result = parseRoster(text, CONFIG)

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
    const result = parseRoster("advisors:\n  - name: [", CONFIG)

    // Then
    expect(result.advisors).toEqual([])
    expect(result.warnings).toHaveLength(1)
  })

  test("returns zero advisors when advisors is not a list", () => {
    // Given / When
    const result = parseRoster("advisors: invalid", CONFIG)

    // Then
    expect(result.advisors).toEqual([])
    expect(result.warnings).toEqual([expect.stringContaining("advisors")])
  })
})

describe("parseRoster when triggers and per-entry floors", () => {
  test("parses when.edits, when.commands, when.tools and leaves when undefined when absent", () => {
    // Given
    const text = `advisors:
  - name: Gated
    when:
      edits: ["**/*.ts", "src/**"]
      commands: ["\\\\bsed\\\\s+-i\\\\b"]
      tools: [task, todowrite]
  - name: Always`

    // When
    const result = parseRoster(text, CONFIG)

    // Then
    expect(result.advisors[0]?.when).toEqual({
      edits: ["**/*.ts", "src/**"],
      commands: ["\\bsed\\s+-i\\b"],
      tools: ["task", "todowrite"],
    })
    expect(result.advisors[1]?.when).toBeUndefined()
    expect(result.warnings).toEqual([])
  })

  test("rejects path-bearing and shell tool names in when.tools with a warning naming the right list", () => {
    // Given
    const text = `advisors:
  - name: Gated
    when:
      tools: [edit, write, apply_patch, bash, task]`

    // When
    const result = parseRoster(text, CONFIG)

    // Then
    expect(result.advisors[0]?.when?.tools).toEqual(["task"])
    expect(result.warnings).toEqual([
      expect.stringContaining("edit"),
      expect.stringContaining("write"),
      expect.stringContaining("apply_patch"),
      expect.stringContaining("bash"),
    ])
    expect(result.warnings[0]).toContain("when.edits")
    expect(result.warnings[3]).toContain("when.commands")
  })

  test("drops an invalid regex from when.commands and keeps the rest", () => {
    // Given
    const text = `advisors:
  - name: Gated
    when:
      commands: ["(", "\\\\btee\\\\b"]`

    // When
    const result = parseRoster(text, CONFIG)

    // Then
    expect(result.advisors[0]?.when?.commands).toEqual(["\\btee\\b"])
    expect(result.warnings).toEqual([expect.stringContaining("commands")])
  })

  test("fails closed: a when with no usable triggers keeps the entry as never-firing and warns", () => {
    // Given
    const empty = `advisors:
  - name: Empty
    when: {}`
    const allInvalid = `advisors:
  - name: Broken
    when:
      commands: ["("]`
    const notObject = `advisors:
  - name: Wrong
    when: always`

    // When
    const results = [empty, allInvalid, notObject].map((text) => parseRoster(text, CONFIG))

    // Then
    for (const result of results) {
      expect(result.advisors).toHaveLength(1)
      expect(result.advisors[0]?.when).toEqual({ edits: [], commands: [], tools: [] })
      expect(result.warnings.at(-1)).toContain("will never run")
    }
  })

  test("parses per-entry chat and inject floors and falls back to config for invalid values", () => {
    // Given
    const text = `advisors:
  - name: Quiet
    chat_min_severity: blocker
    inject_min_severity: concern
  - name: Loud
    chat_min_severity: shout`

    // When
    const result = parseRoster(text, { ...CONFIG, chat_min_severity: "nit", inject_min_severity: "blocker" })

    // Then
    expect(result.advisors[0]?.chat_min_severity).toBe("blocker")
    expect(result.advisors[0]?.inject_min_severity).toBe("concern")
    expect(result.advisors[1]?.chat_min_severity).toBe("nit")
    expect(result.advisors[1]?.inject_min_severity).toBe("blocker")
    expect(result.warnings).toEqual([expect.stringContaining("chat_min_severity")])
  })

  test("rosterFloors resolves an entry's floors by slug and undefined for unknown slugs", () => {
    // Given
    const roster = [
      resolved({ name: "Quiet", chat_min_severity: "blocker", inject_min_severity: "concern" }),
      resolved({ name: "Loud", chat_min_severity: "nit", inject_min_severity: "blocker" }),
    ]

    // When
    const floors = rosterFloors(roster)

    // Then
    expect(floors("quiet")).toEqual({ chat_min_severity: "blocker", inject_min_severity: "concern" })
    expect(floors("loud")).toEqual({ chat_min_severity: "nit", inject_min_severity: "blocker" })
    expect(floors("nobody")).toBeUndefined()
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
    const result = defaultRoster(CONFIG)

    // Then
    expect(result.advisors).toHaveLength(1)
    expect(result.advisors[0]?.name).toBe("Advisor")
    expect(result.advisors[0]?.enabled).toBeTrue()
  })

  test("ships no model of its own: without default_model there is no default advisor", () => {
    // Given / When
    const result = defaultRoster(DEFAULTS)

    // Then
    expect(result.advisors).toEqual([])
    expect(result.warnings).toEqual([
      "No usable roster entries and no default_model configured; no advisors will run",
    ])
    expect(resolveEntry({ name: "Unset", enabled: true }, DEFAULTS)).toBeUndefined()
  })

  test("skips a roster entry that names no model when default_model is unset", () => {
    // Given
    const text = `advisors:
  - name: Explicit
    model: provider/model:high
  - name: Implicit`

    // When
    const result = parseRoster(text, DEFAULTS)

    // Then
    expect(result.advisors.map((entry) => entry.name)).toEqual(["Explicit"])
    expect(result.advisors[0]?.fallback).toBeUndefined()
    expect(result.warnings).toEqual([
      'Advisor "Implicit" has no model and no default_model is configured; skipped',
    ])
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
    expect(entry?.fallback).toBeUndefined()
    expect(entry?.fallbackAgentId).toBeUndefined()
  })

  test("falls back to default_model when the implicit default_fallback is the entry's own model", () => {
    // Given
    const config = {
      ...DEFAULTS,
      default_model: "amazon-bedrock/openai.gpt-5.6-sol:max",
      default_fallback: "amazon-bedrock/us.anthropic.claude-fable-5-1:xhigh",
    }

    // When
    const implicit = resolveEntry(
      { name: "Fable", enabled: true, model: "amazon-bedrock/us.anthropic.claude-fable-5-1:xhigh" },
      config,
    )
    const explicit = resolveEntry(
      {
        name: "Fable explicit",
        enabled: true,
        model: "amazon-bedrock/us.anthropic.claude-fable-5-1:xhigh",
        fallback: "amazon-bedrock/us.anthropic.claude-fable-5-1:xhigh",
      },
      config,
    )

    // Then
    expect(implicit?.fallback?.long).toBe("amazon-bedrock/openai.gpt-5.6-sol")
    expect(implicit?.fallback?.variant).toBe("max")
    expect(implicit?.fallbackAgentId).toBe("advisor-fable-fb")
    expect(explicit?.fallback).toBeUndefined()
  })

  test("gives no implicit fallback when default_fallback is unset, even with a default_model", () => {
    // Given
    const config = { ...DEFAULTS, default_model: "amazon-bedrock/openai.gpt-5.6-sol:max" }

    // When
    const entry = resolveEntry(
      { name: "Fable", enabled: true, model: "amazon-bedrock/us.anthropic.claude-fable-5-1:xhigh" },
      config,
    )
    const roster = parseRoster("advisors:\n  - name: Fable\n    model: provider/other:high\n", config)

    // Then
    expect(entry?.fallback).toBeUndefined()
    expect(entry?.fallbackAgentId).toBeUndefined()
    expect(roster.warnings).toEqual([])
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
    const entry = resolved({ name: "Editor", enabled: true, tools: ["edit", "bash"] })

    // When
    const config = toAgentConfig(entry, "system prompt")

    // Then
    expect(entry.agentId).toBe("advisor-editor")
    expect(config).toMatchObject({
      description: "Advisor watchdog: Editor",
      mode: "subagent",
      hidden: true,
      model: "amazon-bedrock/openai.gpt-5.6-sol",
      variant: "max",
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
    const entry = resolved({ name: "Reader", enabled: true, tools: ["read", "grep", "glob"] })

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
    const entry = resolved({ name: "No tools", enabled: true, tools: [] })

    // When
    const config = toAgentConfig(entry, "system prompt")

    // Then
    expect(Object.values(config.tools ?? {}).filter(Boolean)).toEqual([])
  })

  test("uses the fallback model and variant for the fallback agent config", () => {
    // Given
    const entry = resolved({ name: "Reviewer", enabled: true })

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
