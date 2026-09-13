import { describe, expect, test } from "bun:test"
import type { AssistantMessage, Config, Part, UserMessage } from "@opencode-ai/sdk"

import {
  AdvisorRuntime,
  type AdvisorClient,
  type AdvisorStore,
  type AdvisorTimers,
} from "../src/advisor"
import { DEFAULTS, type AdvisorConfig } from "../src/config"
import type { Logger } from "../src/log"
import { CooldownRegistry } from "../src/models"
import { renderCard, type Note, type NoteInput, type StateSnapshot, type TranscriptRecord } from "../src/notes"
import { resolveEntry, type AdvisorEntry } from "../src/roster"

const DIRECTORY = "/workspace/project"
const PRIMARY = "amazon-bedrock/openai.gpt-5.6-sol"
const FALLBACK = "amazon-bedrock/us.anthropic.claude-fable-5-1"

const DEFAULT_MODEL = "amazon-bedrock/openai.gpt-5.6-sol:max"

function config(overrides: Partial<AdvisorConfig> = {}): AdvisorConfig {
  return {
    ...DEFAULTS,
    default_model: DEFAULT_MODEL,
    default_fallback: `${FALLBACK}:xhigh`,
    pass_timeout_ms: 100,
    ...overrides,
  }
}

function resolved(input: Parameters<typeof resolveEntry>[0]): AdvisorEntry {
  const entry = resolveEntry(input, config())
  if (entry === undefined) throw new Error("fixture entry must resolve")
  return entry
}

function entry(name: string): AdvisorEntry {
  return resolved({ name })
}

function entryWithoutFallback(name: string): AdvisorEntry {
  return resolved({ name, fallback: DEFAULT_MODEL })
}

function maxEffortEntry(name: string): AdvisorEntry {
  return resolved({ name, model: "bedrock-mantle/openai.gpt-5.6-sol:max" })
}

function textPart(messageID: string, text: string): Part {
  return { id: `part-${messageID}`, sessionID: "root", messageID, type: "text", text }
}

function userMessage(id: string, text: string, created = 1): { info: UserMessage; parts: Part[] } {
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

function watchedAssistant(id: string, parts: Part[], created: number): { info: AssistantMessage; parts: Part[] } {
  return {
    info: {
      id,
      sessionID: "root",
      role: "assistant",
      time: { created, completed: created + 1 },
      parentID: "user-1",
      providerID: "amazon-bedrock",
      modelID: "openai.gpt-5.6-sol",
      mode: "build",
      path: { cwd: DIRECTORY, root: DIRECTORY },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts,
  }
}

function editPart(messageID: string, filePath: string): Part {
  return {
    id: `edit-${messageID}`, sessionID: "root", messageID, type: "tool", callID: "c", tool: "edit",
    state: { status: "completed", input: { filePath }, output: "", title: "edit", metadata: {}, time: { start: 1, end: 2 } },
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
  messages: Array<{ info: UserMessage | AssistantMessage; parts: Part[] }> = [userMessage("user-1", "Build the feature")]
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
  logger?: Logger
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
      log: options.logger ?? log,
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
  test("emits a completed reviewer immediately and still delivers the slower reviewer's alternative", async () => {
    const fast = Promise.withResolvers<ReturnTypeData>()
    const slow = Promise.withResolvers<ReturnTypeData>()
    const client = new FakeClient()
    client.promptScripts.push(() => fast.promise, () => slow.promise)
    const { runtime: subject } = runtime({ roster: [entry("Fast"), entry("Slow")], client })
    const emitted: Note[] = []
    let finished = false
    const pass = subject.runPass("root", "idle", { onResult: (result) => { emitted.push(...result.notes) } })
      .then((results) => { finished = true; return results })
    const response = (note: string): ReturnTypeData => ({
      data: assistant(`<advice severity="concern">reasoning: Reproduced a failure\nnote: ${note}\nevidence: failing regression</advice>`),
      response: { status: 200 },
    })
    try {
      await until(() => client.prompts.length === 2)
      fast.resolve(response("Retry the failing command"))
      await until(() => emitted.length === 1)
      expect(finished).toBeFalse()
      expect(emitted[0]?.advisor_slug).toBe("fast")
      expect(client.aborts).toHaveLength(0)
      slow.resolve(response("Use an idempotent receipt instead"))
      expect(await pass).toHaveLength(2)
      expect(emitted.map((note) => note.advisor_slug)).toEqual(["fast", "slow"])
      expect(emitted[1]?.note).toContain("idempotent receipt")
      expect(client.aborts).toHaveLength(0)
    } finally {
      fast.resolve(response("Retry the failing command"))
      slow.resolve(response("Use an idempotent receipt instead"))
      await pass
    }
  })

  test("one result callback failure preserves both reviews and does not cancel a sibling", async () => {
    const client = new FakeClient()
    for (const name of ["Alpha", "Beta"]) client.promptScripts.push(async () => ({
      data: assistant(`<advice severity="concern">note: Fix ${name}</advice>`), response: { status: 200 },
    }))
    const warnings: string[] = []
    const { runtime: subject, store } = runtime({
      roster: [entry("Alpha"), entry("Beta")], client,
      logger: { ...log, warn: async ({ msg }) => { warnings.push(msg) } },
    })
    const delivered: string[] = []
    const results = await subject.runPass("root", "idle", { onResult: (result) => {
      const slug = result.notes[0]?.advisor_slug
      if (slug === "alpha") throw new Error("delivery unavailable")
      if (slug !== undefined) delivered.push(slug)
    } })

    expect(results).toHaveLength(2)
    expect(store.notes).toHaveLength(2)
    expect(delivered).toEqual(["beta"])
    expect(warnings).toContain("advisor result delivery failed")
    expect(client.aborts).toHaveLength(0)
  })

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
    expect(cfg.agent?.["advisor-reviewer"]?.["variant"]).toBe("max")
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

  test("reviews against the latest real user request while retaining the original request", async () => {
    // Given
    const client = new FakeClient()
    const delivery = userMessage("delivery-3", "advisor card", 3)
    delivery.info.agent = "advisor-delivery"
    client.messages = [
      userMessage("user-1", "reply pong", 1),
      userMessage("user-2", "list the files", 2),
      delivery,
      userMessage("adv_synthetic", "ignore synthetic request", 4),
    ]
    const { runtime: subject } = runtime({ client })

    // When
    await subject.runPass("root", "idle", {})

    // Then
    const prompt = client.prompts[0]?.body.parts.find((part) => part.type === "text")
    expect(prompt?.text).toContain("## Original request\nreply pong")
    expect(prompt?.text).toContain("## Latest user request\nlist the files")
    expect(prompt?.text).not.toContain("## Latest user request\nadvisor card")
    expect(prompt?.text).not.toContain("## Latest user request\nignore synthetic request")
  })

  test("sends static context once per child session, keyed by child not by advisor", async () => {
    // Given
    const client = new FakeClient()
    const promptText = (index: number): string =>
      client.prompts[index]?.body.parts.find((part) => part.type === "text")?.text ?? ""
    const { runtime: subject } = runtime({ client })

    // When
    await subject.runPass("root", "idle", {})
    client.messages = [...client.messages, userMessage("user-2", "second turn", 2)]
    await subject.runPass("root", "idle", {})
    await subject.runPass("other-root", "idle", {})

    // Then
    expect(client.prompts.map(({ path }) => path.id)).toEqual([
      "advisor-session-1", "advisor-session-1", "advisor-session-2",
    ])
    expect(promptText(0)).toContain("## AGENTS.md\nproject guidance")
    expect(promptText(1)).not.toContain("## AGENTS.md")
    expect(promptText(1)).toContain("## Delta")
    expect(promptText(2)).toContain("## AGENTS.md\nproject guidance")
  })

  test("re-sends static context to a replacement child session after a poisoned-session refresh", async () => {
    // Given
    const client = new FakeClient()
    const poisoned = {
      name: "APIError" as const,
      data: { message: "Cache point cannot be inserted after reasoning block.", statusCode: 400, isRetryable: false },
    }
    client.promptScripts.push(
      async () => ({ data: assistant("<silent/>"), response: { status: 200 } }),
      async () => ({ data: assistant("", { error: poisoned }), response: { status: 200 } }),
      async () => ({ data: assistant("<silent/>"), response: { status: 200 } }),
    )
    const promptText = (index: number): string =>
      client.prompts[index]?.body.parts.find((part) => part.type === "text")?.text ?? ""
    const { runtime: subject } = runtime({ client })

    // When
    await subject.runPass("root", "idle", {})
    client.messages = [...client.messages, userMessage("user-2", "second turn", 2)]
    await subject.runPass("root", "idle", {})

    // Then
    expect(client.prompts.map(({ path }) => path.id)).toEqual([
      "advisor-session-1", "advisor-session-1", "advisor-session-2",
    ])
    expect(promptText(1)).not.toContain("## AGENTS.md")
    expect(promptText(2)).toContain("## AGENTS.md\nproject guidance")
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

  test("persists and displays the requested model level across advisor records", async () => {
    // Given
    const client = new FakeClient()
    client.promptScripts.push(async () => ({
      data: assistant('<advice severity="concern">note: Fix the boundary</advice>'),
      response: { status: 200 },
    }))
    const { runtime: subject, store } = runtime({ roster: [maxEffortEntry("Reviewer")], client })

    // When
    await subject.runPass("root", "idle", {})

    // Then
    const note = store.notes[0]
    if (note === undefined) throw new TypeError("expected the advisor note fixture")
    expect({
      noteLevel: note.variant,
      transcriptLevel: store.transcripts[0]?.variant,
      snapshotLevel: store.states[0]?.advisors[0]?.variant,
      cardHeader: renderCard(note).split("\n")[0],
    }).toEqual({
      noteLevel: "max",
      transcriptLevel: "max",
      snapshotLevel: "max",
      cardHeader: "◎ Advisor · GPT-5.6 Sol (max) · concern",
    })
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

  test("surfaces the primary model cooldown deadline after fallback succeeds", async () => {
    // Given
    const now = 1_000
    const client = new FakeClient()
    client.promptScripts.push(
      async () => ({ error: { message: "provider unavailable" }, response: { status: 500 } }),
      async () => ({ data: assistant(""), response: { status: 200 } }),
    )
    const clock = (): number => now
    const cooldowns = new CooldownRegistry(clock)
    const { runtime: subject, store } = runtime({ client, cooldowns, clock })

    // When
    await subject.runPass("root", "idle", {})

    // Then
    expect(store.states[0]?.advisors[0]?.cooled_until).toBe(
      new Date(now + DEFAULTS.fallback_cooldown_ms).toISOString(),
    )
  })

  test("uses the same fallback path for content-filter text", async () => {
    // Given
    const client = new FakeClient()
    client.promptScripts.push(
      async () => ({
        data: assistant("", {
          error: { name: "UnknownError", data: { message: "Output blocked by content filter" } },
        }),
        response: { status: 200 },
      }),
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

  test("keeps healthy advice containing content-filter wording", async () => {
    // Given
    const client = new FakeClient()
    client.promptScripts.push(async () => ({
      data: assistant('<advice severity="concern">note: This is blocked by a missing import</advice>'),
      response: { status: 200 },
    }))
    const cooldowns = new CooldownRegistry(() => 1_000)
    const { runtime: subject, store } = runtime({ client, cooldowns })

    // When
    const [result] = await subject.runPass("root", "idle", {})

    // Then
    expect(result?.outcome).toBe("ok")
    expect(store.notes).toHaveLength(1)
    expect(client.prompts).toHaveLength(1)
    expect(cooldowns.isCooled(PRIMARY)).toBe(false)
  })

  test("replaces a poisoned child session on the Bedrock reasoning cache-point 400 without cooling the model", async () => {
    // Given
    const client = new FakeClient()
    const poisoned = {
      name: "APIError" as const,
      data: {
        message: "Cache point cannot be inserted after reasoning block. Please remove the invalid cache point and try again.",
        statusCode: 400,
        isRetryable: false,
      },
    }
    client.promptScripts.push(
      async () => ({ data: assistant("", { error: poisoned }), response: { status: 200 } }),
      async () => ({ data: assistant("<silent/>"), response: { status: 200 } }),
    )
    const cooldowns = new CooldownRegistry(() => 1_000)
    const { runtime: subject, store } = runtime({ client, cooldowns })

    // When
    const [result] = await subject.runPass("root", "idle", {})

    // Then
    expect(result?.outcome).toBe("silent")
    expect(client.creates).toHaveLength(2)
    expect(client.prompts.map(({ path, body }) => [path.id, body.agent])).toEqual([
      ["advisor-session-1", "advisor-reviewer"],
      ["advisor-session-2", "advisor-reviewer"],
    ])
    expect(cooldowns.isCooled(PRIMARY)).toBe(false)
    expect(store.transcripts.map((record) => record.outcome)).toEqual(["error", "silent"])
    expect(store.transcripts[0]?.failure_kind).toBe("poisoned_session")
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

  test("logs a redacted failed-attempt detail when the prompt rejects", async () => {
    // Given
    const client = new FakeClient()
    const secret = `sk-${"a".repeat(24)}`
    const scriptedMessage = `scripted provider failure ${secret} ${"x".repeat(700)}`
    client.promptScripts.push(async () => { throw new Error(scriptedMessage) })
    const warnCalls: Parameters<Logger["warn"]>[0][] = []
    const fakeLogger: Logger = {
      ...log,
      warn: async (fields) => { warnCalls.push(fields) },
    }
    const { runtime: subject } = runtime({
      roster: [entryWithoutFallback("Reviewer")],
      client,
      logger: fakeLogger,
    })

    // When
    await subject.runPass("root", "idle", {})

    // Then
    expect(warnCalls).toHaveLength(1)
    expect(warnCalls[0]).toMatchObject({
      msg: "advisor attempt failed",
      advisor: "reviewer",
      model: PRIMARY,
      agent: "advisor-reviewer",
      failure_kind: "api",
    })
    const detail = warnCalls[0]?.["detail"]
    if (typeof detail !== "string") throw new TypeError("expected failed-attempt detail to be a string")
    expect(detail).toContain("scripted provider failure")
    expect(detail).toContain("[REDACTED]")
    expect(detail).not.toContain(secret)
    expect(detail).toHaveLength(600)
  })
})

describe("AdvisorRuntime when triggers", () => {
  function gated(name: string): AdvisorEntry {
    return resolved({ name, when: { edits: ["**/*.ts"], commands: [], tools: [] } })
  }
  function promptText(client: FakeClient, index: number): string {
    return client.prompts[index]?.body.parts.find((part) => part.type === "text")?.text ?? ""
  }

  test("skips a delta with no trigger: no child session, no prompt, no transcript, no pass counted, cursor kept", async () => {
    // Given
    const client = new FakeClient()
    client.messages = [userMessage("user-1", "Build the feature", 1), watchedAssistant("a-1", [textPart("a-1", "thinking aloud")], 2)]
    const infos: Parameters<Logger["info"]>[0][] = []
    const { runtime: subject, store } = runtime({ roster: [gated("Oracle")], client, logger: { ...log, info: async (fields) => { infos.push(fields) } } })

    // When
    const results = await subject.runPass("root", "idle", {})

    // Then
    expect(results).toEqual([])
    expect(client.creates).toHaveLength(0)
    expect(client.prompts).toHaveLength(0)
    expect(store.transcripts).toHaveLength(0)
    expect(store.states.at(-1)?.advisors[0]?.passes).toBe(0)
    expect(infos).toContainEqual({ msg: "advisor pass skipped", watchedID: "root", advisor: "oracle", reason: "no_trigger" })

    // When
    client.messages = [...client.messages, watchedAssistant("a-2", [editPart("a-2", `${DIRECTORY}/src/x.ts`)], 3)]
    client.promptScripts.push(async () => ({ data: assistant("<silent/>"), response: { status: 200 } }))
    const fired = await subject.runPass("root", "idle", {})

    // Then
    expect(fired.map(({ outcome }) => outcome)).toEqual(["silent"])
    expect(client.prompts).toHaveLength(1)
    expect(promptText(client, 0)).toContain("thinking aloud")
    expect(promptText(client, 0)).toContain("src/x.ts")
    expect(promptText(client, 0)).toContain("## AGENTS.md")
    expect(store.states.at(-1)?.advisors[0]?.passes).toBe(1)
  })

  test("an empty delta is skipped silently, without a no_trigger log line", async () => {
    // Given
    const client = new FakeClient()
    client.messages = [userMessage("user-1", "Build", 1), watchedAssistant("a-1", [editPart("a-1", `${DIRECTORY}/a.ts`)], 2)]
    client.promptScripts.push(async () => ({ data: assistant("<silent/>"), response: { status: 200 } }))
    const infos: Parameters<Logger["info"]>[0][] = []
    const { runtime: subject } = runtime({ roster: [gated("Oracle")], client, logger: { ...log, info: async (fields) => { infos.push(fields) } } })
    await subject.runPass("root", "step", {})

    // When
    await subject.runPass("root", "idle", {})

    // Then
    expect(client.prompts).toHaveLength(1)
    expect(infos.filter((fields) => fields["msg"] === "advisor pass skipped")).toHaveLength(0)
  })

  test("a gated and an ungated entry on one step: only the ungated one runs on prose, and the gated one later sees the carried prose", async () => {
    // Given
    const client = new FakeClient()
    client.messages = [userMessage("user-1", "Build", 1), watchedAssistant("a-1", [textPart("a-1", "prose step")], 2)]
    client.promptScripts.push(async () => ({ data: assistant("<silent/>"), response: { status: 200 } }))
    const { runtime: subject } = runtime({ roster: [gated("Oracle"), entry("Docs")], client })

    // When
    const first = await subject.runPass("root", "idle", {})

    // Then
    expect(first.map(({ slug, outcome }) => [slug, outcome])).toEqual([["docs", "silent"]])
    expect(client.prompts.map(({ body }) => body.agent)).toEqual(["advisor-docs"])

    // When
    client.messages = [...client.messages, watchedAssistant("a-2", [editPart("a-2", `${DIRECTORY}/b.ts`)], 3)]
    client.promptScripts.push(
      async () => ({ data: assistant("<silent/>"), response: { status: 200 } }),
      async () => ({ data: assistant("<silent/>"), response: { status: 200 } }),
    )
    await subject.runPass("root", "idle", {})

    // Then
    const oracleIndex = client.prompts.findIndex(({ body }) => body.agent === "advisor-oracle")
    const docsIndex = client.prompts.findIndex(({ body }, index) => body.agent === "advisor-docs" && index > 0)
    expect(promptText(client, oracleIndex)).toContain("prose step")
    expect(promptText(client, oracleIndex)).toContain("b.ts")
    expect(promptText(client, docsIndex)).not.toContain("prose step")
    expect(promptText(client, docsIndex)).toContain("b.ts")
  })
})
