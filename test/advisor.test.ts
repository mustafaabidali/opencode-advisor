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
import { renderCard, type Finding, type Note, type NoteInput, type StateSnapshot, type TranscriptRecord } from "../src/notes"
import { resolveEntry, type AdvisorEntry } from "../src/roster"
import { ReviewJournal } from "../src/advisor/journal"
import { FindingStore } from "../src/notes/findings"
import { UsageLedger } from "../src/usage/ledger"
import { executeAdvisorPass, type PassResult } from "../src/advisor/pass"
import { carryFindings } from "../src/advisor/carry"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Watcher } from "../src/watcher"
import { sliceDelta } from "../src/delta"

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
    min_fallback_budget_ms: 1,
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
  async recoverNote(input: NoteInput): Promise<Note | undefined> {
    return this.notes.find((note) => input.idempotency_key !== undefined && note.idempotency_key === input.idempotency_key)
  }

  async appendTranscript(_root: string, record: TranscriptRecord): Promise<void> {
    this.transcripts.push(record)
  }

  async writeState(_cwd: string, snapshot: StateSnapshot): Promise<void> {
    this.states.push(snapshot)
  }
  async listFindings(cwd: string, root_session?: string): Promise<Finding[]> {
    return this.notes.filter((note) => note.cwd === cwd && note.root_session === root_session).map((note) => ({
      id: note.finding_id ?? `finding-${note.id}`, issue_id: note.issue_id ?? `issue-${note.id}`,
      cwd, root_session: note.root_session, task_id: note.review?.task_id ?? note.root_session,
      reviewed_revision: note.review?.revision ?? "unversioned", state: "open", version: 0, updated_at: note.time,
      provenance: [{ note_id: note.id, advisor_slug: note.advisor_slug, model: note.model, time: note.time,
        reviewed_revision: note.review?.revision ?? "unversioned" }],
    }))
  }
  async readNotes(cwd: string, root: string, ids: readonly string[]): Promise<Note[]> {
    return this.notes.filter((note) => note.cwd === cwd && note.root_session === root && ids.includes(note.id))
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
  abortScript?: () => Promise<Awaited<ReturnType<AdvisorClient["session"]["abort"]>>>
  messagesScript?: (call: Parameters<AdvisorClient["session"]["messages"]>[0]) => Promise<Awaited<ReturnType<AdvisorClient["session"]["messages"]>>>
  createScript?: () => Promise<Awaited<ReturnType<AdvisorClient["session"]["create"]>>>
  createCount = 0

  readonly session: AdvisorClient["session"] = {
    create: async (call) => {
      this.creates.push(call)
      this.createCount += 1
      if (this.createScript !== undefined) return this.createScript()
      return { data: { id: `advisor-session-${this.createCount}` }, response: { status: 200 } }
    },
    messages: async (call) => this.messagesScript?.(call) ?? ({ data: this.messages, response: { status: 200 } }),
    prompt: async (call) => {
      this.prompts.push(call)
      const script = this.promptScripts.shift()
      return script === undefined
        ? { data: assistant(""), response: { status: 200 } }
        : script(call)
    },
    abort: async (call) => {
      this.aborts.push(call)
      if (this.abortScript !== undefined) return this.abortScript()
      return { data: true, response: { status: 200 } }
    },
  }
}

type ReturnTypeData = Awaited<ReturnType<AdvisorClient["session"]["prompt"]>>

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
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
  onWarning?: (slug: string, message: string) => Promise<void>
  onResult?: (root: string, result: PassResult) => void | Promise<void>
  logger?: Logger
  config?: Partial<AdvisorConfig>
  journal?: ReviewJournal
  captureContent?: () => Promise<string | undefined>
}> = {}): { runtime: AdvisorRuntime; client: FakeClient; store: MemoryStore } {
  const client = options.client ?? new FakeClient()
  const store = options.store ?? new MemoryStore()
  return {
    runtime: new AdvisorRuntime({
      config: config(options.config),
      roster: options.roster ?? [entry("Reviewer")],
      catalog: new Map([[PRIMARY, "GPT-5.6 Sol"], [FALLBACK, "Claude Fable"]]),
      cooldowns: options.cooldowns ?? new CooldownRegistry(options.clock),
      store,
      log: options.logger ?? log,
      client,
      directory: DIRECTORY,
      clock: options.clock ?? (() => 1_000),
      timers: options.timers ?? new FakeTimers(),
      ...(options.journal === undefined ? {} : { journal: options.journal }),
      ...(options.captureContent === undefined ? {} : { captureContent: options.captureContent }),
      ...(options.onResult === undefined ? {} : { onResult: options.onResult }),
      readFile: async () => "project guidance",
      onAdvisorSession: () => {},
      onWarning: (slug, message) => {
        if (options.onWarning !== undefined) return options.onWarning(slug, message)
        options.warnings?.push(`${slug}:${message}`)
        return undefined
      },
    }),
    client,
    store,
  }
}

describe("AdvisorRuntime", () => {
  test("a file reviewer skips already reviewed contents and reviews the next change", async () => {
    let contents = "contents-a"
    const client = new FakeClient()
    const { runtime: subject } = runtime({
      client, captureContent: async () => contents,
      roster: [resolved({ name: "Reviewer", when: { edits: ["**/*.ts"], commands: [], tools: [] } })],
    })
    client.messages.push(watchedAssistant("edit-1", [editPart("edit-1", "src/a.ts")], 2))
    await subject.runPass("root", "idle")
    expect(client.prompts).toHaveLength(1)

    client.messages.push(watchedAssistant("noop-2", [editPart("noop-2", "src/a.ts")], 4))
    expect(await subject.runPass("root", "idle")).toEqual([])
    expect(client.prompts).toHaveLength(1)

    contents = "contents-b"
    client.messages.push(watchedAssistant("edit-3", [editPart("edit-3", "src/a.ts")], 6))
    await subject.runPass("root", "idle")
    expect(client.prompts).toHaveLength(2)
    await subject.dispose()
  })

  test("a successful content baseline survives release and restart of its reviewer", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "advisor-content-journal-"))
    const journal = new ReviewJournal(dataDir, DIRECTORY)
    const client = new FakeClient()
    const options = {
      journal, client, captureContent: async () => "contents-a",
      roster: [resolved({ name: "Reviewer", when: { edits: ["**/*.ts"], commands: [], tools: [] } })],
    }
    const first = runtime(options).runtime
    let second: AdvisorRuntime | undefined
    try {
      client.messages.push(watchedAssistant("edit-1", [editPart("edit-1", "src/a.ts")], 2))
      await first.runPass("root", "idle")
      await first.dispose()

      second = runtime(options).runtime
      client.messages.push(watchedAssistant("noop-2", [editPart("noop-2", "src/a.ts")], 4))
      expect(await second.runPass("root", "idle")).toEqual([])
      expect(client.prompts).toHaveLength(1)
    } finally {
      await first.dispose()
      await second?.dispose()
      await journal.close()
      await rm(dataDir, { recursive: true, force: true })
    }
  })

  test("restart recovery accepts the pending pass's captured contents without another provider request", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "advisor-content-recovery-"))
    const journal = new ReviewJournal(dataDir, DIRECTORY)
    const reviewer = resolved({ name: "Reviewer", when: { edits: ["**/*.ts"], commands: [], tools: [] } })
    const client = new FakeClient()
    client.messages.push(watchedAssistant("edit-1", [editPart("edit-1", "src/a.ts")], 2))
    const pending = journal.lane("root", reviewer.slug, { entry: reviewer, config: config() })
    let contents = "contents-a"
    const subject = runtime({ journal, client, roster: [reviewer], captureContent: async () => contents }).runtime
    try {
      await pending.load()
      await pending.begin({
        id: "interrupted-pass", child: "recovered-child", model: DEFAULT_MODEL, agent: reviewer.agentId,
        started_at: 1_000, next: sliceDelta(client.messages, {}).next,
        content: JSON.stringify([undefined, "user-1", "contents-a"]),
      }, 0)
      await pending.close()
      client.messagesScript = async (call) => ({
        data: call.path.id === "recovered-child" ? [assistant("<silent/>", {
          sessionID: "recovered-child", mode: reviewer.agentId, finish: "stop",
          time: { created: 1_001, completed: 1_002 },
        })] : client.messages,
        response: { status: 200 },
      })
      await subject.runPass("root", "idle")
      await subject.recover("root")
      client.messages.push(watchedAssistant("noop-2", [editPart("noop-2", "src/a.ts")], 4))
      await subject.runPass("root", "idle")
      expect(client.prompts).toHaveLength(0)

      contents = "contents-b"
      client.messages.push(watchedAssistant("edit-3", [editPart("edit-3", "src/a.ts")], 6))
      await subject.runPass("root", "idle")
      expect(client.prompts).toHaveLength(1)
    } finally {
      await subject.dispose()
      await journal.close()
      await rm(dataDir, { recursive: true, force: true })
    }
  })

  test("an unrestricted transcript reviewer does not scan or deduplicate file contents", async () => {
    let scans = 0
    const { runtime: subject, client } = runtime({
      captureContent: async () => { scans++; return "contents-a" },
    })
    await subject.runPass("root", "idle")
    client.messages.push(watchedAssistant("analysis-2", [textPart("analysis-2", "New evidence")], 2))
    await subject.runPass("root", "idle")
    expect(client.prompts).toHaveLength(2)
    expect(scans).toBe(0)
    await subject.dispose()
  })

  test("an explicit tool trigger still reviews new evidence when file contents are unchanged", async () => {
    const { runtime: subject, client } = runtime({
      captureContent: async () => "contents-a",
      roster: [resolved({ name: "Reviewer", when: { edits: ["**/*.ts"], commands: [], tools: ["task"] } })],
    })
    client.messages.push(watchedAssistant("edit-1", [editPart("edit-1", "src/a.ts")], 2))
    await subject.runPass("root", "idle")
    client.messages.push(watchedAssistant("task-2", [{
      id: "task-2", sessionID: "root", messageID: "task-2", type: "tool", callID: "task", tool: "task",
      state: { status: "completed", input: { description: "Review the design" }, output: "New design evidence",
        title: "Design review", metadata: {}, time: { start: 3, end: 4 } },
    }], 4))
    await subject.runPass("root", "idle")
    expect(client.prompts).toHaveLength(2)
    await subject.dispose()
  })

  test("content baselines belong to each reviewer and do not suppress new user requirements", async () => {
    const roster = ["Fast", "Slow"].map((name) =>
      resolved({ name, when: { edits: ["**/*.ts"], commands: [], tools: [] } }))
    const { runtime: subject, client } = runtime({ roster, captureContent: async () => "contents-a" })
    client.messages.push(watchedAssistant("edit-1", [editPart("edit-1", "src/a.ts")], 2))
    await subject.runPass("root", "idle", { advisorSlug: "fast" })
    await subject.runPass("root", "idle")
    expect(client.prompts).toHaveLength(2)

    client.messages.push(userMessage("user-2", "Preserve the existing public interface", 5))
    client.messages.push(watchedAssistant("noop-2", [editPart("noop-2", "src/a.ts")], 6))
    await subject.runPass("root", "idle")
    expect(client.prompts).toHaveLength(4)
    await subject.dispose()
  })

  test.each(["unavailable", "error"])("an %s content check permits review and clears stale deduplication state", async (mode) => {
    let known = true
    const { runtime: subject, client } = runtime({
      captureContent: async () => {
        if (known) return "contents-a"
        if (mode === "error") throw new Error("Unable to inspect worktree")
        return undefined
      },
      roster: [resolved({ name: "Reviewer", when: { edits: ["**/*.ts"], commands: [], tools: [] } })],
    })
    client.messages.push(watchedAssistant("edit-1", [editPart("edit-1", "src/a.ts")], 2))
    await subject.runPass("root", "idle")
    known = false
    client.messages.push(watchedAssistant("edit-2", [editPart("edit-2", "src/a.ts")], 4))
    await subject.runPass("root", "idle")
    known = true
    client.messages.push(watchedAssistant("edit-3", [editPart("edit-3", "src/a.ts")], 6))
    await subject.runPass("root", "idle")
    expect(client.prompts).toHaveLength(3)
    await subject.dispose()
  })

  test("a failed provider request does not mark its contents reviewed", async () => {
    const { runtime: subject, client } = runtime({
      config: { fallback_cooldown_ms: 0 }, captureContent: async () => "contents-a",
      roster: [resolved({ name: "Reviewer", fallback: DEFAULT_MODEL,
        when: { edits: ["**/*.ts"], commands: [], tools: [] } })],
    })
    client.promptScripts.push(async () => ({ error: "Provider unavailable", response: { status: 500 } }))
    client.messages.push(watchedAssistant("edit-1", [editPart("edit-1", "src/a.ts")], 2))
    expect((await subject.runPass("root", "idle"))[0]?.outcome).toBe("error")
    await subject.runPass("root", "idle")
    expect(client.prompts).toHaveLength(2)
    await subject.dispose()
  })

  test("an edit during review gets a background follow-up against its own content snapshot", async () => {
    let contents = "contents-a"
    let finish: (result: ReturnTypeData) => void = () => { throw new Error("Review not started") }
    const { runtime: subject, client } = runtime({
      config: { pass_debounce_ms: 0, cooldown_ms: 0 }, captureContent: async () => contents,
      roster: [resolved({ name: "Reviewer", when: { edits: ["**/*.ts"], commands: [], tools: [] } })],
    })
    client.promptScripts.push(() => new Promise((resolve) => { finish = resolve }))
    client.messages.push(watchedAssistant("edit-1", [editPart("edit-1", "src/a.ts")], 2))
    expect(subject.notify("root", "idle")).toBeUndefined()
    await until(() => client.prompts.length === 1)

    contents = "contents-b"
    client.messages.push(watchedAssistant("edit-2", [editPart("edit-2", "src/a.ts")], 4))
    expect(subject.notify("root", "idle")).toBeUndefined()
    expect(client.prompts).toHaveLength(1)
    finish({ data: assistant("<silent/>"), response: { status: 200 } })
    await until(() => client.prompts.length === 2)
    expect(client.prompts).toHaveLength(2)
    await subject.dispose()
  })

  test("a local journal failure is not sent, does not cool models, and does not consume fallback", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "advisor-local-failure-"))
    const usage = new UsageLedger({ dataDir, directory: DIRECTORY, clock: () => 1000 })
    const database = new FindingStore(dataDir)
    const client = new FakeClient()
    const cooldowns = new CooldownRegistry(() => 1000)
    try {
      const result = await executeAdvisorPass({
        config: config(), entry: entry("Reviewer"), catalog: new Map(), cooldowns,
        store: new MemoryStore(), log, client: client.session, directory: DIRECTORY,
        watchedID: "root", advisorSession: "child", prompt: () => "review",
        clock: () => 1000, timers: new FakeTimers(), refreshSession: async () => "replacement",
        onWarning: () => {}, usage, passID: "local-failure",
        beforeDispatch: async () => { throw new Error("Advisor journal ownership changed") },
      })
      expect(result).toMatchObject({ outcome: "error", cancellation: "not_sent" })
      expect(client.prompts).toHaveLength(0)
      expect(cooldowns.isCooled(PRIMARY)).toBe(false)
      expect(cooldowns.isCooled(FALLBACK)).toBe(false)
      expect(await database.usageForPass("local-failure")).toMatchObject([{ state: "not_sent", coverage: "complete" }])
    } finally {
      await usage.close()
      await database.close()
      await rm(dataDir, { recursive: true, force: true })
    }
  })

  test("reconciling our own aborted request does not treat the primary model as faulty", async () => {
    const timers = new FakeTimers()
    const client = new FakeClient()
    const cooldowns = new CooldownRegistry(() => 1000)
    client.abortScript = async () => ({ error: "unconfirmed" })
    client.promptScripts.push(() => new Promise(() => {}))
    const subject = runtime({ timers, client, cooldowns })
    try {
      const pass = subject.runtime.runPass("root", "idle")
      await until(() => client.prompts.length === 1)
      timers.fireAll()
      const pending = (await pass)[0]
      client.messagesScript = async () => ({ data: [assistant("", {
        sessionID: "advisor-session-1", time: { created: 1001, completed: 1002 },
        error: { name: "MessageAbortedError", data: { message: "Aborted" } },
      })] })
      expect(await pending?.reconcile?.()).toMatchObject({ outcome: "timeout", cancellation: "cancelled_confirmed" })
      expect(cooldowns.isCooled(PRIMARY)).toBe(false)
      expect(client.prompts).toHaveLength(1)
    } finally { await subject.runtime.dispose() }
  })

  test("confirmed timeouts back off per reviewer instead of immediately repeating paid work", async () => {
    let now = 1000
    const timers = new FakeTimers()
    const client = new FakeClient()
    client.promptScripts.push(() => new Promise(() => {}), () => new Promise(() => {}))
    const subject = runtime({ client, timers, clock: () => now, config: { cooldown_ms: 1000 } })
    try {
      const first = subject.runtime.runPass("root", "idle")
      await until(() => client.prompts.length === 1)
      timers.fireAll()
      expect((await first)[0]?.cancellation).toBe("cancelled_confirmed")
      const immediate = subject.runtime.runPass("root", "idle")
      for (let i = 0; i < 200; i++) await Promise.resolve()
      expect(client.prompts).toHaveLength(1)
      expect(await immediate).toEqual([])
      now += 1001
      const second = subject.runtime.runPass("root", "idle")
      await until(() => client.prompts.length === 2)
      timers.fireAll()
      await second
      now += 1001
      expect(await subject.runtime.runPass("root", "idle")).toEqual([])
      expect(client.prompts).toHaveLength(2)
      now += 1000
      await subject.runtime.runPass("root", "idle")
      expect(client.prompts).toHaveLength(3)
    } finally { await subject.runtime.dispose() }
  })

  test("a stalled recovery warning cannot keep an explicit recovery request waiting forever", async () => {
    const timers = new FakeTimers()
    const client = new FakeClient()
    client.abortScript = async () => ({ error: "unconfirmed" })
    client.promptScripts.push(() => new Promise(() => {}))
    let warning = false
    const subject = runtime({ timers, client, onWarning: async () => {
      warning = true
      await new Promise(() => {})
    } })
    try {
      const pass = subject.runtime.runPass("root", "idle")
      await until(() => client.prompts.length === 1)
      timers.fireAll()
      await pass
      await subject.runtime.recover("root")
      await subject.runtime.recover("root")
      let settled = false
      const recovery = subject.runtime.recover("root").then(() => { settled = true })
      await until(() => warning)
      timers.fireAll()
      for (let i = 0; i < 200; i++) await Promise.resolve()
      expect(settled).toBe(true)
      await recovery
      expect(subject.client.prompts).toHaveLength(1)
    } finally { await subject.runtime.dispose() }
  })

  test("a failed report write can recover after absence is verified without replaying the provider", async () => {
    const store = new MemoryStore()
    const write = store.writeNote.bind(store)
    let failing = true
    store.writeNote = async (input) => {
      if (failing) throw new Error("temporary disk failure")
      return write(input)
    }
    const client = new FakeClient()
    client.promptScripts.push(async () => ({ data: assistant(
      '<advice severity="concern">reasoning: checked\nnote: Preserve this returned fix\nevidence: recovery.ts:1</advice>') }))
    const subject = runtime({ store, client })
    const delivered: Note[] = []
    const result = await subject.runtime.runPass("root", "idle", { onResult: (result) => { delivered.push(...result.notes) } })
    expect(result[0]?.persistence).toBe("recovery_required")
    failing = false
    await subject.runtime.recover("root")
    expect(store.notes).toHaveLength(1)
    expect(delivered).toHaveLength(1)
    expect(client.prompts).toHaveLength(1)
    await subject.runtime.dispose()
  })

  test("a late content-filtered completion clears uncertainty without advancing the cursor and selects fallback next", async () => {
    const late = Promise.withResolvers<ReturnTypeData>()
    const timers = new FakeTimers()
    const client = new FakeClient()
    client.abortScript = async () => ({ error: "unconfirmed" })
    client.promptScripts.push(() => late.promise)
    const subject = runtime({ client, timers })
    const work = subject.runtime.runPass("root", "idle")
    await until(() => client.prompts.length === 1)
    timers.fireAll()
    const timedOut = (await work)[0]
    expect(timedOut?.cancellation).toBe("cancellation_uncertain")
    late.resolve({ data: assistant("", { finish: "content-filter" }) })
    expect((await timedOut?.pending)?.outcome).toBe("error")
    await subject.runtime.runPass("root", "idle")
    expect(client.prompts[1]?.body.agent).toBe("advisor-reviewer-fb")
    await subject.runtime.dispose()
  })

  test("a stalled no-model transcript cannot bypass the execution deadline", async () => {
    const timers = new FakeTimers()
    const cooldowns = new CooldownRegistry(() => 1000)
    cooldowns.markCooled(PRIMARY, 5000)
    cooldowns.markCooled(FALLBACK, 5000)
    const store = new MemoryStore()
    let writing = false
    store.appendTranscript = async () => { writing = true; await new Promise(() => {}) }
    const subject = runtime({ store, cooldowns, timers })
    let settled = false
    const work = subject.runtime.runPass("root", "idle").then((result) => { settled = true; return result })
    await until(() => writing)
    timers.fireAll()
    for (let i = 0; i < 200; i++) await Promise.resolve()
    expect(settled).toBe(true)
    expect((await work)[0]?.outcome).toBe("timeout")
    await subject.runtime.dispose()
  })

  test("evicting and disposing watched roots releases their runtime lanes and contexts", async () => {
    const subject = runtime({ roster: [resolved({ name: "Gated", when: { edits: ["**/*.md"], commands: [], tools: [] } })] })
    const watcher = new Watcher({
      config: config(), clock: () => 1000, timers: new FakeTimers(), log,
      client: { session: { get: async () => ({}) } }, onPass: async () => {},
      isPinned: (root) => subject.runtime.isPinned(root), onForget: (root) => subject.runtime.forget(root),
    })
    for (let i = 0; i < 230; i++) {
      const id = `root-${i}`
      await watcher.handleEvent({ type: "session.created", properties: { info: {
        id, title: id, projectID: "fixture", directory: DIRECTORY, version: "1", time: { created: i, updated: i },
      } } })
      await subject.runtime.runPass(id, "idle")
    }
    expect(subject.runtime.metrics).toMatchObject({ roots: 200, lanes: 200, active: 0, deliveries: 0 })
    watcher.dispose()
    await subject.runtime.dispose()
    expect(subject.runtime.metrics).toMatchObject({ roots: 0, lanes: 0, active: 0, deliveries: 0 })
    expect(subject.client.prompts).toHaveLength(0)
  })

  test("an interrupted request is recovered from its child after restart without dispatching it again", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "advisor-interrupted-"))
    const journal = new ReviewJournal(dataDir, DIRECTORY)
    const sent = Promise.withResolvers<void>()
    const first = runtime({ journal })
    first.client.promptScripts.push(() => { sent.resolve(); return new Promise(() => {}) })
    const work = first.runtime.runPass("root", "idle")
    await sent.promise
    await first.runtime.dispose()
    await work
    const report = assistant('<advice severity="concern">reasoning: recovered evidence\nnote: Keep the later remedy\nevidence: changed.ts:2</advice>',
      { sessionID: "advisor-session-1", time: { created: 1001, completed: 1002 }, finish: "stop" })
    first.client.messagesScript = async (call) => ({ data: call.path.id === "root" ? first.client.messages : [report] })
    const resumed = runtime({ journal, client: first.client, store: first.store })
    const delivered: Note[] = []
    try {
      await resumed.runtime.runPass("root", "idle", { onResult: (result) => { delivered.push(...result.notes) } })
      expect(first.client.prompts).toHaveLength(1)
      await resumed.runtime.recover("root")
      await resumed.runtime.recover("root")
      await resumed.runtime.runPass("root", "idle")
      expect(delivered.map((note) => note.note)).toEqual(["Keep the later remedy"])
      expect(first.client.prompts).toHaveLength(1)
      expect(first.store.notes).toHaveLength(1)
    } finally {
      await resumed.runtime.dispose()
      await journal.close()
      await rm(dataDir, { recursive: true, force: true })
    }
  })

  test("a stored user stop is respected before any request or recovery after restart", async () => {
    class StoppedStore extends MemoryStore {
      async readTask() { return { task_id: "user-1", revision: "r1", stopped: true } }
    }
    const subject = runtime({ store: new StoppedStore() })
    await subject.runtime.runPass("root", "idle")
    expect(subject.client.creates).toHaveLength(0)
    expect(subject.client.prompts).toHaveLength(0)
    await subject.runtime.dispose()
  })

  test("a damaged reviewer journal pauses visibly while another reviewer can still run", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "advisor-damaged-journal-"))
    const journal = new ReviewJournal(dataDir, DIRECTORY)
    const database = new FindingStore(dataDir)
    const key = { cwd: DIRECTORY, root_session: "root", advisor_slug: "reviewer" }
    const subject = runtime({ journal, roster: [entry("Reviewer"), entry("Healthy")] })
    try {
      expect(await database.claimJournal(key, "fixture", process.pid, null)).toBe(true)
      await database.saveJournal(key, "fixture", '{"cursor": "corrupt"}')
      await database.releaseJournal(key, "fixture")
      const first: unknown = await subject.runtime.runPass("root", "idle").catch((error: unknown) => error)
      expect(first).toMatchObject([{ slug: "healthy", outcome: "silent" }])
      await subject.runtime.recover("root")
      expect(await subject.runtime.runPass("root", "idle")).toEqual([])
      expect(subject.client.prompts).toHaveLength(1)
      expect(subject.store.states.at(-1)?.execution).toContainEqual(expect.objectContaining({
        advisor_slug: "reviewer", state: "recovery_required",
      }))
    } finally {
      await subject.runtime.dispose()
      await journal.close()
      await database.close()
      await rm(dataDir, { recursive: true, force: true })
    }
  })

  test("a durable cursor survives restart, while another live instance cannot claim the same reviewer", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "advisor-restart-"))
    const journal = new ReviewJournal(dataDir, DIRECTORY)
    const otherJournal = new ReviewJournal(dataDir, DIRECTORY)
    const first = runtime({ journal })
    const second = runtime({ journal: otherJournal, client: first.client, store: first.store })
    try {
      await first.runtime.runPass("root", "idle")
      await second.runtime.runPass("root", "idle")
      expect(first.client.prompts).toHaveLength(1)
      await first.runtime.dispose()
      await second.runtime.dispose()
      const resumed = runtime({ journal: otherJournal, client: first.client, store: first.store })
      try {
        await resumed.runtime.runPass("root", "idle")
        expect(first.client.prompts).toHaveLength(1)
        first.client.messages.push(userMessage("user-2", "Continue", 10))
        await resumed.runtime.runPass("root", "idle")
        expect(first.client.prompts).toHaveLength(2)
        expect(first.client.creates).toHaveLength(2)
      } finally { await resumed.runtime.dispose() }
    } finally {
      await first.runtime.dispose()
      await second.runtime.dispose()
      await journal.close()
      await otherJournal.close()
      await rm(dataDir, { recursive: true, force: true })
    }
  })

  test("forgotten lanes finish releasing ownership before their journal store closes", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "advisor-release-"))
    const journal = new ReviewJournal(dataDir, DIRECTORY)
    const database = new FindingStore(dataDir)
    const release = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    const create = journal.lane.bind(journal)
    journal.lane = (...args) => {
      const lane = create(...args)
      const close = lane.close.bind(lane)
      lane.close = async () => { entered.resolve(); await release.promise; await close() }
      return lane
    }
    const timers = new FakeTimers()
    const subject = runtime({ journal, timers })
    let disposed: Promise<void> | undefined
    let closed: Promise<void> | undefined
    try {
      await subject.runtime.runPass("root", "idle")
      subject.runtime.forget("root")
      await entered.promise
      let disposalDone = false
      disposed = subject.runtime.dispose().then(() => { disposalDone = true })
      for (let i = 0; i < 200; i++) await Promise.resolve()
      expect(disposalDone).toBe(true)
      await disposed
      let journalDone = false
      closed = journal.close().then(() => { journalDone = true })
      for (let i = 0; i < 200; i++) await Promise.resolve()
      expect(journalDone).toBe(false)
      release.resolve()
      await closed
      expect(await database.readJournal({ cwd: DIRECTORY, root_session: "root", advisor_slug: "reviewer" }))
        .toMatchObject({ owner: null, pid: null })
    } finally {
      release.resolve()
      await disposed
      await subject.runtime.dispose()
      await closed
      await journal.close()
      await database.close()
      await rm(dataDir, { recursive: true, force: true })
    }
  })

  test("stop preserves a late finding and resume delivers it without reviewing the same delta again", async () => {
    const client = new FakeClient()
    const late = Promise.withResolvers<ReturnTypeData>()
    client.promptScripts.push(() => late.promise)
    client.abortScript = async () => {
      late.resolve({ data: assistant("", { error: { name: "MessageAbortedError", data: { message: "Aborted" } } }) })
      return { data: true }
    }
    const { runtime: subject, store } = runtime({ client })
    const delivered: Note[] = []
    const work = subject.runPass("root", "idle", { onResult: (result) => { delivered.push(...result.notes) } })
    await until(() => client.prompts.length === 1)
    subject.pause("root")
    for (let i = 0; i < 200; i++) await Promise.resolve()
    expect(client.aborts).toHaveLength(0)
    late.resolve({ data: assistant('<advice severity="concern">reasoning: checked\nnote: Preserve this fix\nevidence: test.ts:1</advice>') })
    await work
    await until(() => store.notes.length === 1)
    await subject.runPass("root", "idle")
    expect(delivered).toHaveLength(0)
    expect(client.prompts).toHaveLength(1)
    await subject.resume("root")
    await until(() => delivered.length === 1)
    expect(delivered[0]?.note).toBe("Preserve this fix")
    await subject.dispose()
  })

  test("resume schedules every reviewer after the last notification targeted one reviewer", async () => {
    const timers = new FakeTimers()
    const subject = runtime({ timers, roster: [entry("First"), entry("Second")] })
    try {
      await subject.runtime.runPass("root", "idle", { advisorSlug: "second" })
      subject.client.messages.push(userMessage("user-2", "Continue", 10))
      subject.runtime.pause("root")
      await subject.runtime.resume("root")
      for (let i = 0; i < 300; i++) await Promise.resolve()
      expect(subject.client.prompts.map((call) => call.body.agent).sort()).toEqual([
        "advisor-first", "advisor-second", "advisor-second",
      ])
    } finally { await subject.runtime.dispose() }
  })

  test("resume can deliver retained findings before the new runtime receives a watcher callback", async () => {
    const first = runtime()
    first.client.promptScripts.push(async () => ({ data: assistant(
      '<advice severity="concern">reasoning: checked\nnote: Resume this fix\nevidence: test.ts:1</advice>') }))
    await first.runtime.runPass("root", "idle")
    await first.runtime.dispose()
    const delivered: Note[] = []
    const resumed = runtime({ store: first.store, onResult: (root, result) => {
      expect(root).toBe("root")
      delivered.push(...result.notes)
    } })
    try {
      await resumed.runtime.resume("root")
      expect(delivered.map((note) => note.note)).toEqual(["Resume this fix"])
    } finally { await resumed.runtime.dispose() }
  })

  test("forgetting a root while recovery is awaited cannot recreate its lane", async () => {
    const { runtime: subject, client } = runtime()
    const work = subject.runPass("root", "idle")
    subject.forget("root")
    await work
    expect(subject.metrics).toMatchObject({ lanes: 0, roots: 0, active: 0 })
    expect(client.prompts).toHaveLength(0)
    await subject.dispose()
  })

  test("an uncertain upstream throttle blocks overlap and uses fallback after confirmed recovery", async () => {
    let now = 1000
    const client = new FakeClient()
    client.abortScript = async () => ({ error: "not confirmed" })
    client.promptScripts.push(() => new Promise(() => {}))
    const { runtime: subject } = runtime({ client, clock: () => now, config: { cooldown_ms: 1000 } })
    const work = subject.runPass("root", "idle")
    await until(() => client.prompts.length === 1)
    subject.observe({ type: "session.status", properties: { sessionID: "advisor-session-1",
      status: { type: "retry", attempt: 1, message: "429 TooManyRequests", next: 2000 } } })
    expect((await work)[0]?.cancellation).toBe("cancellation_uncertain")
    await subject.runPass("root", "idle")
    expect(client.prompts).toHaveLength(1)
    now += 1001
    client.abortScript = async () => ({ data: true })
    await subject.runPass("root", "idle")
    expect(client.prompts[1]?.body.agent).toBe("advisor-reviewer-fb")
    await subject.dispose()
  })
  test("a context rollover carries the reviewer's independent findings into a new child between passes", async () => {
    const client = new FakeClient()
    client.promptScripts.push(async () => ({ data: assistant(
      '<advice severity="concern">reasoning: Verified by the fixture\nnote: Retain this independent remedy\nevidence: file.ts:40</advice>',
      { tokens: { input: 500, output: 20, reasoning: 0, cache: { read: 0, write: 0 } } }),
      response: { status: 200 } }))
    const { runtime: subject } = runtime({ client, config: { context_budget_tokens: 100 } })
    await subject.runPass("root", "idle")
    client.messages.push(userMessage("user-2", "Continue the same task", 10))
    await subject.runPass("root", "idle")
    expect(client.creates).toHaveLength(2)
    expect(client.prompts[1]?.body.parts[0].text).toContain("Retain this independent remedy")
    expect(client.prompts[1]?.body.parts[0].text).toContain("file.ts:40")
    expect(client.aborts).toHaveLength(0)
  })

  test("closed report bodies do not crowd required open remedies out of a context carry", async () => {
    const store = new MemoryStore()
    for (let index = 0; index < 16; index++) await store.writeNote({
      cwd: DIRECTORY, root_session: "root", advisor_session: "child", advisor_slug: "reviewer",
      roster_name: "Reviewer", provider: "provider", model: PRIMARY, model_display: "Primary",
      variant: "xhigh", severity: "concern", reasoning: "checked evidence ".repeat(100),
      note: `remedy-${index}`, evidence: ["file.ts:12"], is_fallback: false, quarantined: false,
    })
    const findings = await store.listFindings(DIRECTORY, "root")
    store.listFindings = async () => findings.map((finding, index) => index < 12
      ? { ...finding, state: "resolved", disposition: { state: "resolved", reason: "fixed",
        reviewed_revision: finding.reviewed_revision, evidence: [], time: finding.updated_at } } : finding)
    const requested: string[] = []
    const read = store.readNotes.bind(store)
    store.readNotes = async (cwd, root, ids) => { requested.push(...ids); return read(cwd, root, ids) }
    const carried = await carryFindings(store, DIRECTORY, "root", "reviewer", undefined, 24000)
    expect(carried).toBeDefined()
    expect(carried).toContain("remedy-15")
    expect(carried).toContain("resolved")
    expect(carried).toContain("fixed")
    expect(requested).toHaveLength(4)
    expect(carried?.length).toBeLessThanOrEqual(24000)
  })

  test("an oversized carry pauses visibly without discarding evidence or adding tools", async () => {
    const client = new FakeClient()
    client.promptScripts.push(async () => ({ data: assistant(
      `<advice severity="concern">reasoning: checked\nnote: ${"preserve this remedy ".repeat(100)}\nevidence: file.ts</advice>`,
      { tokens: { input: 500, output: 20, reasoning: 0, cache: { read: 0, write: 0 } } }),
      response: { status: 200 } }))
    const { runtime: subject, store } = runtime({ client, config: { context_budget_tokens: 100, context_carry_chars: 100 } })
    await subject.runPass("root", "idle")
    client.messages.push(userMessage("user-2", "Continue", 10))
    expect((await subject.runPass("root", "idle"))[0]?.outcome).toBe("context_budget_exceeded")
    expect(client.prompts).toHaveLength(1)
    expect(store.notes).toHaveLength(1)
  })

  test.each(["content-filter", "content_filter"])("an empty %s finish uses the configured fallback", async (finish) => {
    const client = new FakeClient()
    client.promptScripts.push(
      async () => ({ data: assistant("", { finish }), response: { status: 200 } }),
      async () => ({ data: assistant("<silent/>"), response: { status: 200 } }),
    )
    const { runtime: subject, store } = runtime({ client })
    expect((await subject.runPass("root", "idle"))[0]?.outcome).toBe("fallback")
    expect(client.prompts.map((call) => call.body.agent)).toEqual(["advisor-reviewer", "advisor-reviewer-fb"])
    expect(store.transcripts.map((record) => record.failure_kind)).toContain("content_filter")
  })

  test("the default fallback margin defers a retry that has only two seconds left", async () => {
    let now = 0
    const client = new FakeClient()
    client.promptScripts.push(async () => {
      now = 38000
      return { error: "429 throttled", response: { status: 429 } }
    })
    const subject = runtime({ client, clock: () => now,
      config: { pass_timeout_ms: 40000, min_fallback_budget_ms: DEFAULTS.min_fallback_budget_ms } })
    try {
      await subject.runtime.runPass("root", "idle")
      expect(client.prompts).toHaveLength(1)
      await subject.runtime.runPass("root", "idle")
      expect(client.prompts[1]?.body.agent).toBe("advisor-reviewer-fb")
    } finally { await subject.runtime.dispose() }
  })

  test.each(["429 TooManyRequests: upstream throttled", "response blocked by content filter"])(
    "an upstream retry event switches to fallback after confirmed abort: %s", async (message) => {
      const client = new FakeClient()
      client.promptScripts.push(() => new Promise(() => {}), async () => ({ data: assistant("<silent/>"), response: { status: 200 } }))
      const { runtime: subject } = runtime({ client })
      const pass = subject.runPass("root", "idle")
      await until(() => client.prompts.length === 1)
      subject.observe({ type: "session.status", properties: { sessionID: "advisor-session-1",
        status: { type: "retry", attempt: 1, message, next: 2000 } } })
      expect((await pass)[0]?.outcome).toBe("fallback")
      expect(client.aborts.map((call) => call.path.id)).toEqual(["advisor-session-1"])
      expect(client.prompts[1]?.body.agent).toBe("advisor-reviewer-fb")
    })

  test("a stalled report write releases the caller without replaying the provider, then delivers once", async () => {
    const timers = new FakeTimers()
    const store = new MemoryStore()
    const writing = Promise.withResolvers<void>()
    let saving = false
    const write = store.writeNote.bind(store)
    store.writeNote = async (input) => { saving = true; await writing.promise; return write(input) }
    const client = new FakeClient()
    client.promptScripts.push(async () => ({ data: assistant(
      '<advice severity="concern">reasoning: checked\nnote: Keep the independent fix\nevidence: test</advice>'),
      response: { status: 200 } }))
    const { runtime: subject } = runtime({ client, store, timers })
    const delivered: Note[] = []
    let done = false
    const pass = subject.runPass("root", "idle", { onResult: (result) => { delivered.push(...result.notes) } })
      .then((result) => { done = true; return result })
    await until(() => saving)
    timers.fireAll()
    for (let i = 0; i < 80; i++) await Promise.resolve()
    expect(done).toBe(true)
    expect((await pass)[0]?.persistence).toBe("pending")
    await subject.runPass("root", "idle")
    expect(client.prompts).toHaveLength(1)
    writing.resolve()
    await until(() => delivered.length === 1)
    expect(store.notes).toHaveLength(1)
    expect(client.aborts).toHaveLength(0)
    await subject.dispose()
  })

  test("uncertain cancellation backs off and reconciles the child before permitting another prompt", async () => {
    let now = 1_000
    const timers = new FakeTimers()
    const client = new FakeClient()
    client.abortScript = async () => ({ error: "not acknowledged" })
    client.promptScripts.push(() => new Promise(() => {}))
    const { runtime: subject } = runtime({ client, timers, clock: () => now, config: { cooldown_ms: 1000 } })
    const pass = subject.runPass("root", "idle")
    await until(() => client.prompts.length === 1)
    timers.fireAll()
    expect((await pass)[0]?.cancellation).toBe("cancellation_uncertain")
    await subject.runPass("root", "idle")
    expect(client.aborts).toHaveLength(1)
    now += 1001
    client.abortScript = async () => ({ data: true, response: { status: 200 } })
    await subject.runPass("root", "idle")
    expect(client.aborts).toHaveLength(2)
    expect(client.prompts).toHaveLength(2)
    await subject.dispose()
  })

  test("new work starts another fast review while a slower reviewer is still running", async () => {
    const client = new FakeClient()
    const slow = Promise.withResolvers<ReturnTypeData>()
    client.promptScripts.push(
      async () => ({ data: assistant("<silent/>"), response: { status: 200 } }),
      () => slow.promise,
      async () => ({ data: assistant("<silent/>"), response: { status: 200 } }),
    )
    const { runtime: subject } = runtime({
      client, roster: [entry("Fast"), entry("Slow")], config: { cooldown_ms: 0, pass_debounce_ms: 0 },
    })
    const completed: string[] = []
    const context = { onResult: (result: { slug: string }) => { completed.push(result.slug) } }
    subject.notify("root", "idle", context)
    await until(() => client.prompts.length === 2 && completed.includes("fast"))
    client.messages.push(watchedAssistant("edit-2", [editPart("edit-2", "src/fix.ts")], 10))
    subject.notify("root", "idle", context)
    await until(() => client.prompts.length === 3)
    expect(client.prompts[2]?.body.agent).toBe("advisor-fast")
    expect(completed).not.toContain("slow")
    slow.resolve({ data: assistant("<silent/>"), response: { status: 200 } })
    await until(() => completed.filter((slug) => slug === "slow").length === 1)
    expect(client.aborts).toHaveLength(0)
    await subject.dispose()
  })

  test.each(["history", "create"] as const)("the execution deadline includes a hung %s phase", async (phase) => {
    const timers = new FakeTimers()
    const client = new FakeClient()
    if (phase === "history") client.messagesScript = () => new Promise(() => {})
    else client.createScript = () => new Promise(() => {})
    const { runtime: subject } = runtime({ client, timers })
    let done = false
    const pass = subject.runPass("root", "idle").then((value) => { done = true; return value })
    for (let index = 0; index < 30; index++) await Promise.resolve()
    timers.fireAll()
    for (let index = 0; index < 50; index++) await Promise.resolve()
    expect(done).toBe(true)
    expect((await pass)[0]?.outcome).toBe("timeout")
    expect(client.prompts).toHaveLength(0)
    expect(client.aborts).toHaveLength(0)
  })

  test("a hung abort cannot keep a timed-out pass pending or permit an overlapping retry", async () => {
    const timers = new FakeTimers()
    const client = new FakeClient()
    const releaseAbort = Promise.withResolvers<Awaited<ReturnType<AdvisorClient["session"]["abort"]>>>()
    client.abortScript = () => releaseAbort.promise
    client.promptScripts.push(() => new Promise<ReturnTypeData>(() => {}))
    const { runtime: subject } = runtime({ client, timers })
    let finished = false
    const first = subject.runPass("root", "idle").then((value) => { finished = true; return value })
    try {
      await until(() => client.prompts.length === 1)
      timers.fireAll()
      await until(() => client.aborts.length === 1)
      timers.fireAll()
      for (let index = 0; index < 50; index++) await Promise.resolve()
      expect(finished).toBe(true)
      expect((await first)[0]?.outcome).toBe("timeout")
      await subject.runPass("root", "idle")
      expect(client.prompts).toHaveLength(1)
    } finally {
      releaseAbort.resolve({ data: true, response: { status: 200 } })
    }
  })

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
    expect(store.states.at(-1)?.advisors.map((advisor) => advisor.passes)).toEqual([1, 1])
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
    expect(store.states.at(-1)?.advisors[0]?.cooled_until).toBe(
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
    let now = 1000
    const timers = new FakeTimers()
    const client = new FakeClient()
    client.promptScripts.push(
      async () => new Promise<ReturnTypeData>(() => {}),
      async () => ({ data: assistant(""), response: { status: 200 } }),
    )
    const { runtime: subject } = runtime({ client, timers, clock: () => now, config: { cooldown_ms: 1000 } })

    // When
    const first = subject.runPass("root", "idle", {})
    await until(() => client.prompts.length === 1)
    timers.fireAll()
    const firstResult = await first
    expect(await subject.runPass("root", "idle", {})).toEqual([])
    now += 1001
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
