import { describe, expect, test } from "bun:test"
import { join } from "node:path"

import {
  DEFAULTS,
  loadConfig,
  resolveDataDir,
  type AdvisorConfig,
  type ConfigEnvironment,
} from "../src/config"
import { stripJsonComments } from "../src/config/jsonc"

type FakeFiles = Readonly<Record<string, string | Error>>

function fakeReadFile(files: FakeFiles): (path: string) => Promise<string> {
  return async (path) => {
    const value = files[path]
    if (value === undefined) throw new Error(`ENOENT: ${path}`)
    if (value instanceof Error) throw value
    return value
  }
}

const HOME = "/home/tester"
const CWD = "/work/project"
const GLOBAL_PATH = join(HOME, ".config", "opencode", "advisor.jsonc")
const PROJECT_PATH = join(CWD, ".opencode", "advisor.jsonc")

describe("stripJsonComments", () => {
  test("removes comments while preserving comment markers and escaped quotes in strings", () => {
    // Given
    const source = String.raw`{
      // remove this
      "url": "https://example.com/a/*kept*/",
      "quote": "say \"// kept\"", /* remove this too */
      "enabled": true
    }`

    // When
    const parsed: unknown = JSON.parse(stripJsonComments(source))

    // Then
    expect(parsed).toEqual({
      url: "https://example.com/a/*kept*/",
      quote: 'say "// kept"',
      enabled: true,
    })
  })
})

async function load(
  files: FakeFiles = {},
  env: ConfigEnvironment = {},
): Promise<{ readonly config: AdvisorConfig; readonly warnings: readonly string[] }> {
  return loadConfig({ home: HOME, cwd: CWD, env, readFile: fakeReadFile(files) })
}

describe("DEFAULTS", () => {
  test("exports the complete advisor defaults", () => {
    // Given / When / Then
    expect(DEFAULTS).toEqual({
      enabled: true,
      default_model: "amazon-bedrock/openai.gpt-5.6-sol:max",
      default_fallback: "amazon-bedrock/us.anthropic.claude-fable-5-1:xhigh",
      min_severity: "nit",
      toast: true,
      abort_on_blocker: false,
      fallback_on_content_filter: true,
      fallback_cooldown_ms: 300000,
      pass_debounce_ms: 4000,
      cooldown_ms: 15000,
      max_delta_chars: 30000,
      note_ttl_turns: 2,
      pass_timeout_ms: 180000,
      pending_ttl_ms: 600000,
      advise_agents: {},
      provider_aliases: { "bedrock-mantle": "amazon-bedrock" },
      variant_aliases: {},
      content_filter_patterns: [
        "content[\\s_-]?filter",
        "filtering policy",
        "blocked by",
        "guardrail",
        "refusal",
        "output blocked",
      ],
      quarantine_patterns: [
        "rm\\s+-rf",
        "git\\s+push\\s+--force",
        "--no-verify",
        "DROP\\s+TABLE",
        "git\\s+reset\\s+--hard",
        "chmod\\s+777",
        "curl[^\\n]*\\|\\s*sh",
        ":\\(\\)\\s*\\{",
      ],
      log_level: "info",
    })
  })
})

describe("loadConfig", () => {
  test("returns defaults without warnings when both files are missing", async () => {
    // Given / When
    const result = await load()

    // Then
    expect(result.config).toEqual(DEFAULTS)
    expect(result.warnings).toEqual([])
  })

  test("applies the project overlay after the global config", async () => {
    // Given
    const files = {
      [GLOBAL_PATH]: JSON.stringify({ default_model: "global/model:high" }),
      [PROJECT_PATH]: JSON.stringify({ default_model: "project/model:xhigh" }),
    }

    // When
    const result = await load(files)

    // Then
    expect(result.config.default_model).toBe("project/model:xhigh")
  })

  test("deep-merges object keys across global and project overlays", async () => {
    // Given
    const files = {
      [GLOBAL_PATH]: JSON.stringify({ advise_agents: { build: true } }),
      [PROJECT_PATH]: JSON.stringify({ advise_agents: { oracle: "provider/model:high" } }),
    }

    // When
    const result = await load(files)

    // Then
    expect(result.config.advise_agents).toEqual({
      build: true,
      oracle: "provider/model:high",
    })
  })

  test("replaces arrays rather than concatenating them", async () => {
    // Given
    const files = {
      [GLOBAL_PATH]: JSON.stringify({ content_filter_patterns: ["global"] }),
      [PROJECT_PATH]: JSON.stringify({ content_filter_patterns: ["project"] }),
    }

    // When
    const result = await load(files)

    // Then
    expect(result.config.content_filter_patterns).toEqual(["project"])
  })

  test("parses line and block comments without stripping comment-like strings", async () => {
    // Given
    const files = {
      [PROJECT_PATH]: `{
        // project preference
        "default_model": "provider/model//stable", /* retained string */
        "quarantine_patterns": ["https?://example\\\\.com"]
      }`,
    }

    // When
    const result = await load(files)

    // Then
    expect(result.config.default_model).toBe("provider/model//stable")
    expect(result.config.quarantine_patterns).toEqual(["https?://example\\.com"])
    expect(result.warnings).toEqual([])
  })

  test("keeps defaults and names the path when JSON is invalid", async () => {
    // Given
    const files = { [PROJECT_PATH]: "{ invalid" }

    // When
    const result = await load(files)

    // Then
    expect(result.config).toEqual(DEFAULTS)
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain(PROJECT_PATH)
  })

  test("warns and keeps the default for a key with the wrong type", async () => {
    // Given
    const files = { [PROJECT_PATH]: JSON.stringify({ toast: "yes" }) }

    // When
    const result = await load(files)

    // Then
    expect(result.config.toast).toBe(true)
    expect(result.warnings).toEqual([expect.stringContaining("toast")])
  })

  test("validates object values and string-array elements per key", async () => {
    // Given
    const files = {
      [PROJECT_PATH]: JSON.stringify({
        advise_agents: { build: true, broken: 7 },
        provider_aliases: { mantle: false },
        content_filter_patterns: ["valid", 9],
      }),
    }

    // When
    const result = await load(files)

    // Then
    expect(result.config.advise_agents).toEqual(DEFAULTS.advise_agents)
    expect(result.config.provider_aliases).toEqual(DEFAULTS.provider_aliases)
    expect(result.config.content_filter_patterns).toEqual(DEFAULTS.content_filter_patterns)
    expect(result.warnings).toHaveLength(3)
  })

  test("warns about unknown keys without applying them", async () => {
    // Given
    const files = { [PROJECT_PATH]: JSON.stringify({ surprise: true }) }

    // When
    const result = await load(files)

    // Then
    expect(result.config).toEqual(DEFAULTS)
    expect(result.warnings).toEqual([expect.stringContaining("surprise")])
  })

  test("applies supported environment overrides after file overlays", async () => {
    // Given
    const files = { [PROJECT_PATH]: JSON.stringify({ enabled: true, log_level: "warn" }) }
    const env = {
      OPENCODE_ADVISOR_ENABLED: "0",
      OPENCODE_ADVISOR_LOG_LEVEL: "debug",
    }

    // When
    const result = await load(files, env)

    // Then
    expect(result.config.enabled).toBe(false)
    expect(result.config.log_level).toBe("debug")
  })

  test("accepts enabled environment value 1", async () => {
    // Given
    const files = { [PROJECT_PATH]: JSON.stringify({ enabled: false }) }

    // When
    const result = await load(files, { OPENCODE_ADVISOR_ENABLED: "1" })

    // Then
    expect(result.config.enabled).toBe(true)
  })

  test("warns and ignores unsupported environment values", async () => {
    // Given / When
    const result = await load({}, {
      OPENCODE_ADVISOR_ENABLED: "sometimes",
      OPENCODE_ADVISOR_LOG_LEVEL: "verbose",
    })

    // Then
    expect(result.config.enabled).toBe(DEFAULTS.enabled)
    expect(result.config.log_level).toBe(DEFAULTS.log_level)
    expect(result.warnings).toHaveLength(2)
  })

  test("warns and returns defaults when a config file is unreadable", async () => {
    // Given
    const files = { [PROJECT_PATH]: new Error("EACCES") }

    // When
    const result = await load(files)

    // Then
    expect(result.config).toEqual(DEFAULTS)
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain(PROJECT_PATH)
  })
})

describe("resolveDataDir", () => {
  test("uses XDG_DATA_HOME when set", () => {
    // Given / When
    const result = resolveDataDir({ XDG_DATA_HOME: "/xdg/data", HOME })

    // Then
    expect(result).toBe("/xdg/data/opencode-advisor")
  })

  test("falls back to the home local share directory", () => {
    // Given / When
    const result = resolveDataDir({ HOME })

    // Then
    expect(result).toBe("/home/tester/.local/share/opencode-advisor")
  })
})
