import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { Hooks, ProviderContext } from "@opencode-ai/plugin"
import type {
  AssistantMessage,
  EventSessionCreated,
  EventSessionStatus,
  Message,
  Model,
  Part,
  Session,
  UserMessage,
} from "@opencode-ai/sdk"

import type { ConfigEnvironment } from "../src/config"
import type { LogFields, Logger, LoggerOptions } from "../src/log"

const NOW = 1_789_000_000_000
const ROOT_ID = "root-session"
const ROOT_SENTINEL = "ROOT_REQUEST_SENTINEL"
const ADVISOR_SENTINEL = "ADVISOR_MESSAGE_SENTINEL"
const SOL_AGENT = "advisor-reviewer-gpt-5-6-sol-max"
const FABLE_AGENT = "advisor-reviewer-claude-fable-5-1-xhigh"
const EFFORT_ROSTER = `advisors:
  - name: Reviewer (GPT-5.6 Sol:max)
    model: bedrock-mantle/openai.gpt-5.6-sol:max
  - name: Reviewer (Claude Fable 5.1:xhigh)
    model: amazon-bedrock/us.anthropic.claude-fable-5-1:xhigh`

type ChatParamsInput = Parameters<NonNullable<Hooks["chat.params"]>>[0]
type ChatParamsOutput = Readonly<{
  temperature: number
  topP: number
  topK: number
  maxOutputTokens: number | undefined
  options: Record<string, unknown>
}>

type PromptProbe = Readonly<{
  body: Readonly<{
    parts: readonly [Readonly<{ type: "text"; text: string }>]
  }>
}>

type CapturedLog = Readonly<{
  level: "debug" | "info" | "warn" | "error"
  fields: LogFields
}>

type DependencyOverrides = Readonly<{
  environment?: ConfigEnvironment
  readFile?: (path: string) => Promise<string>
  exists?: (path: string) => boolean
}>

class FakeTimers {
  readonly pending = new Map<number, () => void>()
  #next = 1

  readonly setTimeout = (callback: () => void, _ms: number): unknown => {
    const id = this.#next
    this.#next += 1
    this.pending.set(id, callback)
    return id
  }

  readonly clearTimeout = (timer: unknown): void => {
    if (typeof timer === "number") this.pending.delete(timer)
  }
}

class FakeClient {
  readonly promptCalls: PromptProbe[] = []
  providerCalls = 0

  constructor(
    private readonly rootText = ROOT_SENTINEL,
    private readonly providerRejects = false,
  ) {}

  readonly providers = async () => {
    this.providerCalls += 1
    if (this.providerRejects) throw new TypeError("provider transport failed")
    return {
      data: {
        providers: [
          {
            id: "amazon-bedrock",
            models: {
              "openai.gpt-5.6-sol": { name: "GPT-5.6 Sol" },
            },
          },
        ],
      },
      error: undefined,
      response: new Response(null, { status: 200 }),
    }
  }

  readonly session = {
    create: async () => ({
      data: { id: "advisor-session" },
      error: undefined,
      response: new Response(null, { status: 200 }),
    }),
    messages: async () => ({
      data: [userTranscriptMessage(this.rootText)],
      error: undefined,
      response: new Response(null, { status: 200 }),
    }),
    prompt: async (call: PromptProbe) => {
      this.promptCalls.push(call)
      return {
        data: advisorResponse(),
        error: undefined,
        response: new Response(null, { status: 200 }),
      }
    },
    abort: async () => ({
      data: true,
      error: undefined,
      response: new Response(null, { status: 200 }),
    }),
    shell: async () => ({
      data: advisorResponse().info,
      error: undefined,
      response: new Response(null, { status: 200 }),
    }),
    get: async () => ({
      data: rootSession("/workspace/project"),
      error: undefined,
      response: new Response(null, { status: 200 }),
    }),
  }

  readonly tui = {
    showToast: async () => ({
      data: true,
      error: undefined,
      response: new Response(null, { status: 200 }),
    }),
  }
}

async function loadPlugin() {
  try {
    return await import("../src/plugin")
  } catch (error) {
    if (!(error instanceof Error)) throw error
    return undefined
  }
}

function captureLogger(): Readonly<{
  logs: CapturedLog[]
  createLogger: (options: LoggerOptions) => Logger
}> {
  const logs: CapturedLog[] = []
  const createLogger = (_options: LoggerOptions): Logger => ({
    debug: async (fields) => {
      logs.push({ level: "debug", fields })
    },
    info: async (fields) => {
      logs.push({ level: "info", fields })
    },
    warn: async (fields) => {
      logs.push({ level: "warn", fields })
    },
    error: async (fields) => {
      logs.push({ level: "error", fields })
    },
  })
  return { logs, createLogger }
}

function rootSession(directory: string): Session {
  return {
    id: ROOT_ID,
    projectID: "project",
    directory,
    title: "root",
    version: "1",
    time: { created: NOW, updated: NOW },
  }
}

function sessionCreated(directory: string): EventSessionCreated {
  return { type: "session.created", properties: { info: rootSession(directory) } }
}

function sessionIdle(): EventSessionStatus {
  return {
    type: "session.status",
    properties: { sessionID: ROOT_ID, status: { type: "idle" } },
  }
}

function userTranscriptMessage(text: string): Readonly<{ info: Message; parts: readonly Part[] }> {
  const info: UserMessage = {
    id: "root-user-message",
    sessionID: ROOT_ID,
    role: "user",
    time: { created: NOW },
    agent: "build",
    model: { providerID: "amazon-bedrock", modelID: "openai.gpt-5.6-sol" },
  }
  return {
    info,
    parts: [
      {
        id: "root-user-part",
        sessionID: ROOT_ID,
        messageID: info.id,
        type: "text",
        text,
      },
    ],
  }
}

function advisorResponse(): Readonly<{ info: AssistantMessage; parts: readonly Part[] }> {
  return {
    info: {
      id: "advisor-response",
      sessionID: "advisor-session",
      role: "assistant",
      time: { created: NOW, completed: NOW + 1 },
      parentID: "advisor-user-message",
      providerID: "amazon-bedrock",
      modelID: "openai.gpt-5.6-sol",
      mode: "advisor-advisor",
      path: { cwd: "/workspace/project", root: "/workspace/project" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [],
  }
}

function chatOutput(text: string): Readonly<{ message: UserMessage; parts: Part[] }> {
  const transcript = userTranscriptMessage(text)
  if (transcript.info.role !== "user") throw new TypeError("expected a user message fixture")
  return { message: transcript.info, parts: [...transcript.parts] }
}

function modelFixture(): Model {
  return {
    id: "openai.gpt-5.6-sol",
    providerID: "amazon-bedrock",
    api: { id: "bedrock", url: "https://example.invalid", npm: "@ai-sdk/amazon-bedrock" },
    name: "GPT-5.6 Sol",
    capabilities: {
      temperature: true,
      reasoning: true,
      attachment: false,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 1, output: 1 },
    status: "active",
    options: {},
    headers: {},
  }
}

function providerFixture(): ProviderContext {
  return {
    source: "config",
    info: {
      id: "amazon-bedrock",
      name: "Amazon Bedrock",
      source: "config",
      env: [],
      options: {},
      models: {},
    },
    options: {},
  }
}

function chatParamsInput(agent: string): ChatParamsInput {
  return {
    sessionID: ROOT_ID,
    agent,
    model: modelFixture(),
    provider: providerFixture(),
    message: chatOutput("review this").message,
  }
}

function chatParamsOutput(): ChatParamsOutput {
  return {
    temperature: 0.7,
    topP: 0.9,
    topK: 40,
    maxOutputTokens: 4096,
    options: { existing: "preserved" },
  }
}

async function makeHarness(overrides: DependencyOverrides = {}) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "opencode-advisor-plugin-"))
  const home = join(temporaryRoot, "home")
  const directory = join(temporaryRoot, "project")
  const logger = captureLogger()
  const environment = overrides.environment ?? {
    HOME: home,
    XDG_DATA_HOME: join(temporaryRoot, "data"),
  }
  return {
    temporaryRoot,
    home,
    directory,
    environment,
    logs: logger.logs,
    dependencies: {
      home,
      environment,
      readFile: overrides.readFile ?? ((path: string) => readFile(path, "utf8")),
      exists: overrides.exists ?? existsSync,
      clock: () => NOW,
      timers: new FakeTimers(),
      createLogger: logger.createLogger,
    },
  }
}

async function removeHarness(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true })
}

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  throw new Error("test condition was not reached")
}

describe("advisor plugin entry", () => {
  test("returns exactly the seven coexistence-safe hooks", async () => {
    // Given
    const plugin = await loadPlugin()
    expect(plugin).toBeDefined()
    if (plugin === undefined) return
    const harness = await makeHarness()

    try {
      // When
      const hooks = await plugin.createAdvisorHooks(
        { client: new FakeClient(), directory: harness.directory },
        harness.dependencies,
      )

      // Then
      expect(Object.keys(hooks).sort()).toEqual([
        "chat.message",
        "chat.params",
        "config",
        "event",
        "experimental.chat.messages.transform",
        "experimental.chat.system.transform",
        "experimental.session.compacting",
      ])
      expect(plugin.default).toEqual({ id: "advisor", server: plugin.server })
    } finally {
      await removeHarness(harness.temporaryRoot)
    }
  })

  test("returns no hooks when the advisor is disabled", async () => {
    // Given
    const plugin = await loadPlugin()
    expect(plugin).toBeDefined()
    if (plugin === undefined) return
    const harness = await makeHarness({
      environment: {
        HOME: "/tmp/advisor-disabled-home",
        XDG_DATA_HOME: "/tmp/advisor-disabled-data",
        OPENCODE_ADVISOR_ENABLED: "0",
      },
    })

    try {
      // When
      const hooks = await plugin.createAdvisorHooks(
        { client: new FakeClient(), directory: harness.directory },
        harness.dependencies,
      )

      // Then
      expect(hooks).toEqual({})
    } finally {
      await removeHarness(harness.temporaryRoot)
    }
  })

  test("falls back to the default roster when the roster file cannot be read", async () => {
    // Given
    const plugin = await loadPlugin()
    expect(plugin).toBeDefined()
    if (plugin === undefined) return
    const harness = await makeHarness({
      exists: (path) => path.endsWith("WATCHDOG.yml"),
      readFile: async (path) => {
        if (path.endsWith("WATCHDOG.yml")) throw new Error("EACCES roster")
        return readFile(path, "utf8")
      },
    })

    try {
      // When
      const hooks = await plugin.createAdvisorHooks(
        { client: new FakeClient(), directory: harness.directory },
        harness.dependencies,
      )

      // Then
      expect(Object.keys(hooks)).toHaveLength(7)
      expect(
        harness.logs.some(
          ({ level, fields }) => level === "warn" && fields["source"] === "roster",
        ),
      ).toBe(true)
    } finally {
      await removeHarness(harness.temporaryRoot)
    }
  })

  test("returns empty hooks instead of rejecting when startup fails", async () => {
    // Given
    const plugin = await loadPlugin()
    expect(plugin).toBeDefined()
    if (plugin === undefined) return
    const harness = await makeHarness({
      exists: () => {
        throw new TypeError("filesystem probe failed")
      },
    })

    try {
      // When
      const hooks = await plugin.createAdvisorHooks(
        { client: new FakeClient(), directory: harness.directory },
        harness.dependencies,
      )

      // Then
      expect(hooks).toEqual({})
      expect(harness.logs.some(({ level }) => level === "error")).toBe(true)
    } finally {
      await removeHarness(harness.temporaryRoot)
    }
  })

  test("ignores chat messages sent by advisor agents", async () => {
    // Given
    const plugin = await loadPlugin()
    expect(plugin).toBeDefined()
    if (plugin === undefined) return
    const harness = await makeHarness()
    const client = new FakeClient(ROOT_SENTINEL)

    try {
      const hooks = await plugin.createAdvisorHooks(
        { client, directory: harness.directory },
        harness.dependencies,
      )
      const event = hooks.event
      const chatMessage = hooks["chat.message"]
      expect(event).toBeDefined()
      expect(chatMessage).toBeDefined()
      if (event === undefined || chatMessage === undefined) return
      await event({ event: sessionCreated(harness.directory) })

      // When
      await chatMessage(
        { sessionID: ROOT_ID, agent: "advisor-x" },
        chatOutput(ADVISOR_SENTINEL),
      )
      await event({ event: sessionIdle() })
      await until(() => client.promptCalls.length === 1)

      // Then
      const prompt = client.promptCalls[0]?.body.parts[0].text ?? ""
      expect(prompt).toContain(ROOT_SENTINEL)
      expect(prompt).not.toContain(ADVISOR_SENTINEL)
    } finally {
      await removeHarness(harness.temporaryRoot)
    }
  })

  test("leaves chat parameters untouched for a non-advisor agent", async () => {
    // Given
    const plugin = await loadPlugin()
    expect(plugin).toBeDefined()
    if (plugin === undefined) return
    const harness = await makeHarness()

    try {
      const hooks = await plugin.createAdvisorHooks(
        { client: new FakeClient(), directory: harness.directory },
        harness.dependencies,
      )
      const chatParams = hooks["chat.params"]
      expect(chatParams).toBeDefined()
      if (chatParams === undefined) return
      const output = chatParamsOutput()

      // When
      await chatParams(chatParamsInput("build"), output)

      // Then
      expect(output).toEqual(chatParamsOutput())
    } finally {
      await removeHarness(harness.temporaryRoot)
    }
  })

  test("applies max reasoning effort only to the matching gpt-5 advisor agent", async () => {
    // Given
    const plugin = await loadPlugin()
    expect(plugin).toBeDefined()
    if (plugin === undefined) return
    const harness = await makeHarness({
      exists: (path) => path.endsWith("WATCHDOG.yml"),
      readFile: async (path) => path.endsWith("WATCHDOG.yml") ? EFFORT_ROSTER : readFile(path, "utf8"),
    })

    try {
      const hooks = await plugin.createAdvisorHooks(
        { client: new FakeClient(), directory: harness.directory },
        harness.dependencies,
      )
      const chatParams = hooks["chat.params"]
      expect(chatParams).toBeDefined()
      if (chatParams === undefined) return
      const output = chatParamsOutput()

      // When
      await chatParams(chatParamsInput(SOL_AGENT), output)

      // Then
      expect(output).toEqual({
        ...chatParamsOutput(),
        options: { existing: "preserved", reasoningEffort: "max" },
      })
      expect(harness.logs).toContainEqual({
        level: "info",
        fields: {
          msg: "advisor reasoning effort applied",
          agent: SOL_AGENT,
          model: "amazon-bedrock/openai.gpt-5.6-sol",
          effort: "max",
        },
      })
    } finally {
      await removeHarness(harness.temporaryRoot)
    }
  })

  test("does not apply reasoning effort to the matching anthropic advisor agent", async () => {
    // Given
    const plugin = await loadPlugin()
    expect(plugin).toBeDefined()
    if (plugin === undefined) return
    const harness = await makeHarness({
      exists: (path) => path.endsWith("WATCHDOG.yml"),
      readFile: async (path) => path.endsWith("WATCHDOG.yml") ? EFFORT_ROSTER : readFile(path, "utf8"),
    })

    try {
      const hooks = await plugin.createAdvisorHooks(
        { client: new FakeClient(), directory: harness.directory },
        harness.dependencies,
      )
      const chatParams = hooks["chat.params"]
      expect(chatParams).toBeDefined()
      if (chatParams === undefined) return
      const output = chatParamsOutput()

      // When
      await chatParams(chatParamsInput(FABLE_AGENT), output)

      // Then
      expect(output).toEqual(chatParamsOutput())
      expect(harness.logs.some(({ fields }) => fields["msg"] === "advisor reasoning effort applied")).toBe(false)
    } finally {
      await removeHarness(harness.temporaryRoot)
    }
  })

  test("continues the first advisor pass with an empty catalog when providers rejects", async () => {
    // Given
    const plugin = await loadPlugin()
    expect(plugin).toBeDefined()
    if (plugin === undefined) return
    const harness = await makeHarness()
    const client = new FakeClient(ROOT_SENTINEL, true)

    try {
      const hooks = await plugin.createAdvisorHooks(
        { client, directory: harness.directory },
        harness.dependencies,
      )
      const event = hooks.event
      expect(event).toBeDefined()
      if (event === undefined) return
      expect(client.providerCalls).toBe(0)
      await event({ event: sessionCreated(harness.directory) })

      // When
      await event({ event: sessionIdle() })
      await until(() => client.promptCalls.length === 1)

      // Then
      expect(client.providerCalls).toBe(1)
      expect(client.promptCalls).toHaveLength(1)
      expect(
        harness.logs.some(
          ({ level, fields }) => level === "warn" && fields["source"] === "catalog",
        ),
      ).toBe(true)
    } finally {
      await removeHarness(harness.temporaryRoot)
    }
  })
})
