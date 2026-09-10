import { describe, expect, test } from "bun:test"
import type { AssistantMessage, Config, Message, Part } from "@opencode-ai/sdk"

import {
  AdvisorRuntime,
  type AdvisorClient,
  type AdvisorStore,
  type AdvisorTimers,
} from "../src/advisor"
import { DEFAULTS, type AdvisorConfig } from "../src/config"
import type { Logger } from "../src/log"
import { CooldownRegistry } from "../src/models"
import type { Note, NoteInput, StateSnapshot, TranscriptRecord } from "../src/notes"
import { resolveEntry, type AdvisorEntry } from "../src/roster"

const DIRECTORY = "/workspace/project"
const PRIMARY = "amazon-bedrock/openai.gpt-5.6-sol"
const FALLBACK = "amazon-bedrock/us.anthropic.claude-fable-5-1"

function config(overrides: Partial<AdvisorConfig> = {}): AdvisorConfig {
  return { ...DEFAULTS, pass_timeout_ms: 100, ...overrides }
}

function entry(name: string): AdvisorEntry {
  return resolveEntry({ name }, config())
}

function entryWithoutFallback(name: string): AdvisorEntry {
  return resolveEntry({ name, fallback: DEFAULTS.default_model }, config())
}

function textPart(messageID: string, text: string): Part {
  return { id: `part-${messageID}`, sessionID: "root", messageID, type: "text", text }
}

function userMessage(id: string, text: string, created = 1): { info: Message; parts: Part[] } {
  return {
    info: {
      id,
      sessionID: "root",
      role: "user",
      time: { created },
      agent: "build",
      model: { providerID: "amazon-bedrock", modelID: "openai.gpt-5.6-sol" },
    },
    parts: [textPart(id, text)],
  }
}

function assistant(text: string, overrides: Partial<AssistantMessage> = {}): {
  info: AssistantMessage
  parts: Part[]
} {
  const id = `assistant-${Math.random()}`
  return {
    info: {
      id,
      sessionID: "advisor",
      role: "assistant",
      time: { created: 2, completed: 3 },
      parentID: "parent",
      providerID: "amazon-bedrock",
      modelID: "openai.gpt-5.6-sol",
      mode: "advisor-reviewer",
      path: { cwd: DIRECTORY, root: DIRECTORY },
      cost: 0.25,
      tokens: { input: 10, output: 20, reasoning: 5, cache: { read: 2, write: 1 } },
      ...overrides,
    },
    parts: text.length === 0 ? [] : [textPart(id, text)],
  }
}

class MemoryStore implements AdvisorStore {
  readonly notes: Note[] = []
  readonly transcripts: TranscriptRecord[] = []
  readonly states: StateSnapshot[] = []

  async writeNote(input: NoteInput): Promise<Note> {
    const note = { ...input, id: `note-${this.notes.length}`, time: "2026-09-10T00:00:00.000Z" }
    this.notes.push(note)
    return note
  }

  async appendTranscript(_root: string, record: TranscriptRecord): Promise<void> {
    this.transcripts.push(record)
  }

  async writeState(_cwd: string, snapshot: StateSnapshot): Promise<void> {
    this.states.push(snapshot)
  }
}

class FakeTimers implements AdvisorTimers {
  readonly pending = new Map<number, () => void>()
  #next = 1

  setTimeout(callback: () => void, _ms: number): number {
    const id = this.#next++
    this.pending.set(id, callback)
    return id
  }

  clearTimeout(id: unknown): void {
    if (typeof id === "number") this.pending.delete(id)
  }

  fireAll(): void {
    for (const [id, callback] of this.pending) {
      this.pending.delete(id)
      callback()
    }
  }
}

type PromptCall = Parameters<AdvisorClient["session"]["prompt"]>[0]

class FakeClient implements AdvisorClient {
  readonly creates: Parameters<AdvisorClient["session"]["create"]>[0][] = []
  readonly prompts: PromptCall[] = []
  readonly aborts: Parameters<AdvisorClient["session"]["abort"]>[0][] = []
  messages = [userMessage("user-1", "Build the feature")]
  promptScripts: Array<(call: PromptCall) => Promise<ReturnTypeData>> = []
  createCount = 0

  readonly session: AdvisorClient["session"] = {
    create: async (call) => {
      this.creates.push(call)
      this.createCount += 1
      return { data: { id: `advisor-session-${this.createCount}` }, response: { status: 200 } }
    },
    messages: async () => ({ data: this.messages, response: { status: 200 } }),
    prompt: async (call) => {
      this.prompts.push(call)
      const script = this.promptScripts.shift()
      return script === undefined
        ? { data: assistant(""), response: { status: 200 } }
        : script(call)
    },
    abort: async (call) => {
      this.aborts.push(call)
      return { data: true, response: { status: 200 } }
    },
  }
}

type ReturnTypeData = Awaited<ReturnType<AdvisorClient["session"]["prompt"]>>

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return
    await Promise.resolve()
  }
  throw new Error("test condition was not reached")
}

const log: Logger = {
  debug: async () => {},
  info: async () => {},
  warn: async () => {},
  error: async () => {},
}

function runtime(options: Readonly<{
  roster?: readonly AdvisorEntry[]
  client?: FakeClient
  store?: MemoryStore
  cooldowns?: CooldownRegistry
  timers?: AdvisorTimers
  clock?: () => number
  warnings?: string[]
}> = {}): { runtime: AdvisorRuntime; client: FakeClient; store: MemoryStore } {
  const client = options.client ?? new FakeClient()
  const store = options.store ?? new MemoryStore()
  return {
    runtime: new AdvisorRuntime({
      config: config(),
      roster: options.roster ?? [entry("Reviewer")],
      catalog: new Map([[PRIMARY, "GPT-5.6 Sol"], [FALLBACK, "Claude Fable"]]),
      cooldowns: options.cooldowns ?? new CooldownRegistry(options.clock),
      store,
      log,
      client,
      directory: DIRECTORY,
      clock: options.clock ?? (() => 1_000),
      timers: options.timers ?? new FakeTimers(),
      readFile: async () => "project guidance",
      onAdvisorSession: () => {},
      onWarning: (slug, message) => {
        options.warnings?.push(`${slug}:${message}`)
      },
    }),
    client,
    store,
  }
}

describe("AdvisorRuntime", () => {
  test("registers enabled primary, fallback, and delivery agents without clobbering user agents", async () => {
    // Given
    const subject = runtime().runtime
    const oracle = { description: "user-owned" }
    const cfg: Config = { agent: { oracle } }

    // When
    await subject.registerAgents(cfg)

    // Then
    expect(cfg.agent?.["oracle"]).toBe(oracle)
    expect(cfg.agent?.["advisor-reviewer"]?.model).toBe(PRIMARY)
    expect(cfg.agent?.["advisor-reviewer"]?.["variant"]).toBe("xhigh")
    expect(cfg.agent?.["advisor-reviewer-fb"]?.model).toBe(FALLBACK)
    expect(cfg.agent?.["advisor-delivery"]?.tools?.["bash"]).toBe(true)
    expect(cfg.agent?.["advisor-delivery"]?.permission?.bash).toEqual({
      "advisor*": "allow",
      "*": "deny",
    })
  })

  test("creates and reuses one child session per watched session and advisor", async () => {
    // Given
    const { runtime: subject, client } = runtime()
    const reviewer = entry("Reviewer")

    // When
    const first = await subject.ensureSession("root", reviewer)
    const second = await subject.ensureSession("root", reviewer)

    // Then
    expect(second).toBe(first)
    expect(client.creates).toEqual([{
      query: { directory: DIRECTORY },
      body: { parentID: "root", title: "advisor:reviewer" },
    }])
  })

  test("starts all advisors in parallel, records notes, and advances independent cursors", async () => {
    // Given
    const client = new FakeClient()
    const started: string[] = []
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    for (const slug of ["advisor-alpha", "advisor-beta"]) {
      client.promptScripts.push(async () => {
        started.push(slug)
        await gate
        return { data: assistant(`<advice severity="concern">note: Fix ${slug}</advice>`), response: { status: 200 } }
      })
    }
    const { runtime: subject, store } = runtime({ roster: [entry("Alpha"), entry("Beta")], client })

    // When
    const pass = subject.runPass("root", "idle", { firstUserText: "Original" })
    await until(() => started.length === 2)

    // Then
    expect(started).toHaveLength(2)
    release()
    const results = await pass
    expect(results.map(({ outcome }) => outcome)).toEqual(["ok", "ok"])
    expect(store.notes).toHaveLength(2)
    expect(store.transcripts).toHaveLength(2)
    expect(store.states).toHaveLength(1)
    await subject.runPass("root", "idle", {})
    expect(client.prompts).toHaveLength(2)
  })

  test("retries throttle and content-filter failures once with the fallback agent", async () => {
    // Given
    const client = new FakeClient()
    client.promptScripts.push(
      async () => ({ data: assistant("", { error: { name: "APIError", data: { message: "ThrottlingException", statusCode: 429, isRetryable: true } } }), response: { status: 200 } }),
      async () => ({ data: assistant("<advice severity=\"nit\">note: fallback fix</advice>", { providerID: "amazon-bedrock", modelID: "us.anthropic.claude-fable-5-1" }), response: { status: 200 } }),
    )
    const cooldowns = new CooldownRegistry(() => 1_000)
    const { runtime: subject, store } = runtime({ client, cooldowns })

    // When
    const [result] = await subject.runPass("root", "step", {})

    // Then
    expect(result?.outcome).toBe("fallback")
    expect(client.prompts.map(({ body }) => body.agent)).toEqual(["advisor-reviewer", "advisor-reviewer-fb"])
    expect(client.prompts[1]?.body.model).toEqual({ providerID: "amazon-bedrock", modelID: "us.anthropic.claude-fable-5-1" })
    expect(store.notes[0]?.is_fallback).toBe(true)
    expect(cooldowns.isCooled(PRIMARY)).toBe(true)
  })

  test("uses the same fallback path for content-filter text", async () => {
    // Given
    const client = new FakeClient()
    client.promptScripts.push(
      async () => ({ data: assistant("Output blocked by content filter"), response: { status: 200 } }),
      async () => ({ data: assistant(""), response: { status: 200 } }),
    )
    const { runtime: subject, store } = runtime({ client })

    // When
    const [result] = await subject.runPass("root", "idle", {})

    // Then
    expect(result?.outcome).toBe("fallback")
    expect(client.prompts[1]?.body.agent).toBe("advisor-reviewer-fb")
    expect(store.transcripts[0]?.failure_kind).toBe("content_filter")
  })

  test("recreates a cached child session when prompting it returns 404", async () => {
    // Given
    const client = new FakeClient()
    client.promptScripts.push(
      async () => ({ error: { message: "missing" }, response: { status: 404 } }),
      async () => ({ data: assistant(""), response: { status: 200 } }),
    )
    const { runtime: subject } = runtime({ client })

    // When
    const [result] = await subject.runPass("root", "idle", {})

    // Then
    expect(result?.outcome).toBe("silent")
    expect(client.creates).toHaveLength(2)
    expect(client.prompts.map(({ path }) => path.id)).toEqual([
      "advisor-session-1",
      "advisor-session-2",
    ])
  })

  test("aborts timed-out prompts, releases the guard, and does not advance the cursor", async () => {
    // Given
    const timers = new FakeTimers()
    const client = new FakeClient()
    client.promptScripts.push(
      async () => new Promise<ReturnTypeData>(() => {}),
      async () => ({ data: assistant(""), response: { status: 200 } }),
    )
    const { runtime: subject } = runtime({ client, timers })

    // When
    const first = subject.runPass("root", "idle", {})
    await until(() => timers.pending.size === 1)
    timers.fireAll()
    const firstResult = await first
    const secondResult = await subject.runPass("root", "idle", {})

    // Then
    expect(firstResult[0]?.outcome).toBe("timeout")
    expect(client.aborts).toHaveLength(1)
    expect(secondResult[0]?.outcome).toBe("silent")
    expect(client.prompts).toHaveLength(2)
  })

  test("records no_model once when primary and fallback are cooled", async () => {
    // Given
    const warnings: string[] = []
    const cooldowns = new CooldownRegistry(() => 1_000)
    cooldowns.markCooled(PRIMARY, 1_000)
    cooldowns.markCooled(FALLBACK, 1_000)
    const { runtime: subject, client, store } = runtime({ cooldowns, warnings })

    // When
    const first = await subject.runPass("root", "idle", {})
    const second = await subject.runPass("root", "idle", {})

    // Then
    expect(first[0]?.outcome).toBe("no_model")
    expect(second[0]?.outcome).toBe("no_model")
    expect(client.prompts).toHaveLength(0)
    expect(store.transcripts.map(({ outcome }) => outcome)).toEqual(["no_model", "no_model"])
    expect(warnings).toHaveLength(1)
  })

  test("stores quarantined notes as non-deliverable and advances on silent success", async () => {
    // Given
    const client = new FakeClient()
    client.promptScripts.push(
      async () => ({ data: assistant("<advice severity=\"blocker\">note: run rm -rf /</advice>"), response: { status: 200 } }),
      async () => ({ data: assistant("review complete"), response: { status: 200 } }),
    )
    const { runtime: subject, store } = runtime({ client })

    // When
    const quarantined = await subject.runPass("root", "idle", {})
    client.messages.push(userMessage("user-2", "Continue", 4))
    const silent = await subject.runPass("root", "idle", {})

    // Then
    expect(quarantined[0]).toMatchObject({ outcome: "quarantined", notes: [] })
    expect(store.notes[0]?.quarantined).toBe(true)
    expect(silent[0]?.outcome).toBe("silent")
  })

  test("isolates a thrown prompt failure from another advisor and retries the failed delta", async () => {
    // Given
    let now = 1_000
    const client = new FakeClient()
    client.promptScripts.push(
      async () => { throw new Error("provider exploded") },
      async () => ({ data: assistant(""), response: { status: 200 } }),
      async () => ({ data: assistant(""), response: { status: 200 } }),
    )
    const clock = (): number => now
    const { runtime: subject } = runtime({
      roster: [entryWithoutFallback("Alpha"), entryWithoutFallback("Beta")],
      client,
      clock,
      cooldowns: new CooldownRegistry(clock),
    })

    // When
    const first = await subject.runPass("root", "idle", {})
    now += DEFAULTS.fallback_cooldown_ms + 1
    const second = await subject.runPass("root", "idle", {})

    // Then
    expect(first.map(({ outcome }) => outcome)).toContain("error")
    expect(first.map(({ outcome }) => outcome)).toContain("silent")
    expect(second).toHaveLength(1)
    expect(client.prompts).toHaveLength(3)
  })
})
