import { describe, expect, spyOn, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type {
  AssistantMessage,
  EventSessionCreated,
  EventSessionStatus,
  Message,
  Part,
  Session,
  UserMessage,
} from "@opencode-ai/sdk"

import type { ConfigEnvironment } from "../src/config"
import type { LogFields, Logger, LoggerOptions } from "../src/log"
import { NoteStore } from "../src/notes"
import { TaskContexts } from "../src/advisor/context"
import { checkpointTool } from "../src/plugin/checkpoint"
import { ReviewJournal } from "../src/advisor/journal"
import { UsageLedger } from "../src/usage/ledger"

const NOW = 1_789_000_000_000
const ROOT_ID = "root-session"
const ROOT_SENTINEL = "ROOT_REQUEST_SENTINEL"
const ADVISOR_SENTINEL = "ADVISOR_MESSAGE_SENTINEL"
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
  readonly abortCalls: string[] = []
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
    abort: async (call: Readonly<{ path: Readonly<{ id: string }> }>) => {
      this.abortCalls.push(call.path.id)
      return {
        data: true,
        error: undefined,
        response: new Response(null, { status: 200 }),
      }
    },
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

const HARNESS_CONFIG = JSON.stringify({
  default_model: "amazon-bedrock/openai.gpt-5.6-sol:max",
  default_fallback: "amazon-bedrock/us.anthropic.claude-fable-5-1:xhigh",
})

function harnessReadFile(path: string): Promise<string> {
  return path.endsWith("advisor.jsonc") ? Promise.resolve(HARNESS_CONFIG) : readFile(path, "utf8")
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
      readFile: overrides.readFile ?? harnessReadFile,
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
  const deadline = Date.now() + 1500
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
  }
  throw new Error("test condition was not reached")
}

describe("advisor plugin entry", () => {
  test("the installed hooks deduplicate unchanged files and review the next untracked edit", async () => {
    const plugin = await loadPlugin()
    if (plugin === undefined) throw new Error("Plugin module missing")
    const harness = await makeHarness({
      readFile: (path) => path.endsWith("advisor.jsonc") ? Promise.resolve(JSON.stringify({
        default_model: "amazon-bedrock/openai.gpt-5.6-sol:max", cooldown_ms: 0, pass_debounce_ms: 0,
      })) : readFile(path, "utf8"),
    })
    await mkdir(harness.directory, { recursive: true })
    await promisify(execFile)("git", ["-C", harness.directory, "init", "--quiet"])
    await writeFile(join(harness.directory, "module.ts"), "export const value = 1\n")
    await writeFile(join(harness.directory, "WATCHDOG.yml"),
      'advisors:\n  - name: Reviewer\n    when:\n      edits: ["**/*.ts"]\n')
    const messages = [userTranscriptMessage(ROOT_SENTINEL)]
    const fake = new FakeClient()
    const client = { ...fake, session: { ...fake.session, messages: async () => ({
      data: messages, error: undefined, response: new Response(null, { status: 200 }),
    }) } }
    const hooks = await plugin.createAdvisorHooks({ client, directory: harness.directory }, harness.dependencies)
    const edit = async (id: string) => {
      const info: AssistantMessage = { ...advisorResponse().info, id, sessionID: ROOT_ID, mode: "build",
        parentID: "root-user-message", path: { cwd: harness.directory, root: harness.directory } }
      const part: Part = { id, messageID: id, sessionID: ROOT_ID, type: "tool", callID: id, tool: "edit",
        state: { status: "completed", input: { filePath: join(harness.directory, "module.ts") },
          output: "", title: "Edit", metadata: {}, time: { start: NOW, end: NOW + 1 } } }
      messages.push({ info, parts: [part] })
      await hooks.event?.({ event: { type: "message.part.updated", properties: { part } } })
      await hooks.event?.({ event: { type: "message.updated", properties: { info } } })
      await hooks.event?.({ event: sessionIdle() })
    }
    try {
      await hooks.event?.({ event: sessionCreated(harness.directory) })
      await edit("first-edit")
      await until(() => fake.promptCalls.length === 1)
      await edit("noop-edit")
      await until(() => fake.promptCalls.length > 1 ||
        harness.logs.some(({ fields }) => fields["reason"] === "unchanged_content"))
      expect(fake.promptCalls).toHaveLength(1)
      await writeFile(join(harness.directory, "module.ts"), "export const value = 2\n")
      await edit("next-edit")
      await until(() => fake.promptCalls.length === 2)
      expect(fake.promptCalls).toHaveLength(2)
    } finally {
      await hooks.event?.({ event: { type: "server.instance.disposed", properties: { directory: harness.directory } } })
      await removeHarness(harness.temporaryRoot)
    }
  })

  test.each(["journal", "usage", "notes"])("shutdown closes the remaining owners when %s cleanup fails", async (failing) => {
    const plugin = await loadPlugin()
    if (plugin === undefined) throw new Error("Plugin module missing")
    const harness = await makeHarness()
    const calls: string[] = []
    const cleanup: Array<() => Promise<void>> = []
    const journalClose = ReviewJournal.prototype.close
    const usageClose = UsageLedger.prototype.close
    const notesClose = NoteStore.prototype.close
    const journalSpy = spyOn(ReviewJournal.prototype, "close").mockImplementation(function (this: ReviewJournal) {
      calls.push("journal")
      cleanup.push(() => journalClose.call(this))
      return failing === "journal" ? Promise.reject(new Error("Journal release failed")) : journalClose.call(this)
    })
    const usageSpy = spyOn(UsageLedger.prototype, "close").mockImplementation(function (this: UsageLedger) {
      calls.push("usage")
      cleanup.push(() => usageClose.call(this))
      return failing === "usage" ? Promise.reject(new Error("Usage close failed")) : usageClose.call(this)
    })
    const notesSpy = spyOn(NoteStore.prototype, "close").mockImplementation(function (this: NoteStore) {
      calls.push("notes")
      cleanup.push(() => notesClose.call(this))
      return failing === "notes" ? Promise.reject(new Error("Note store close failed")) : notesClose.call(this)
    })
    try {
      const hooks = await plugin.createAdvisorHooks({ client: new FakeClient(), directory: harness.directory }, {
        ...harness.dependencies, createLogger: (options) => ({
          ...harness.dependencies.createLogger(options),
          close: async () => { calls.push("log") },
        }),
      })
      await hooks.event?.({ event: { type: "server.instance.disposed", properties: { directory: harness.directory } } })
      expect(calls).toEqual(["journal", "usage", "notes", "log"])
      expect(harness.logs.some(({ fields }) => fields["msg"] === "advisor shutdown cleanup failed" &&
        fields["resource"] === failing)).toBe(true)
    } finally {
      journalSpy.mockRestore()
      usageSpy.mockRestore()
      notesSpy.mockRestore()
      await Promise.allSettled(cleanup.map((close) => close()))
      await removeHarness(harness.temporaryRoot)
    }
  })

  test("checkpoint completion returns while requested advisor recovery is still pending", async () => {
    const harness = await makeHarness()
    const client = new FakeClient()
    const log = harness.dependencies.createLogger({ level: "info" })
    const store = new NoteStore({ dataDir: join(harness.temporaryRoot, "checkpoint-data"), log })
    const release = Promise.withResolvers<void>()
    let recovering = false
    let completed = false
    const checkpoint = checkpointTool({
      client, config: { abort_on_blocker: false }, contexts: new TaskContexts(store, harness.directory),
      log, store, directory: harness.directory, isWatched: () => true,
      recover: async () => { recovering = true; await release.promise; throw new Error("Recovery unavailable") },
    })
    const work = checkpoint.execute({ phase: "complete", task: "continue", updates: [], recover: true }, {
      sessionID: ROOT_ID, messageID: "checkpoint", agent: "build", directory: harness.directory,
      worktree: harness.directory, abort: new AbortController().signal, metadata: () => {}, ask: async () => {},
    }).then((result) => { completed = true; return result })
    void work.catch(() => {})
    try {
      await until(() => recovering)
      await until(() => completed)
      expect(await work).toContain('"completion_allowed":true')
      expect(await work).toContain('"recovery_requested":true')
      expect(client.abortCalls).toEqual([])
      release.resolve()
      await until(() => harness.logs.some(({ fields }) => fields["msg"] === "advisor background recovery failed"))
    } finally {
      release.resolve()
      await work.catch(() => {})
      await store.close()
      await removeHarness(harness.temporaryRoot)
    }
  })

  test("the primary can continue and complete with an unfinished advisor", async () => {
    const plugin = await loadPlugin()
    if (plugin === undefined) throw new Error("Plugin module missing")
    const harness = await makeHarness()
    const fake = new FakeClient()
    const release = Promise.withResolvers<void>()
    let prompted = false
    let returned = false
    const client = { ...fake, session: { ...fake.session, prompt: async () => {
      prompted = true
      await release.promise
      returned = true
      return { data: advisorResponse(), error: undefined, response: new Response() }
    } } }
    const hooks = await plugin.createAdvisorHooks({ client, directory: harness.directory }, harness.dependencies)
    try {
      await hooks.event?.({ event: sessionCreated(harness.directory) })
      await hooks.event?.({ event: sessionIdle() })
      await until(() => prompted)
      const output = { messages: [{ ...userTranscriptMessage(ROOT_SENTINEL), parts: [] as Part[] }] }
      await hooks["experimental.chat.messages.transform"]?.({}, output)
      const checkpoint = hooks.tool?.["advisor_checkpoint"]
      if (checkpoint === undefined) throw new Error("Checkpoint tool missing")
      const report = await checkpoint.execute({ phase: "complete", task: "continue", updates: [] }, {
        sessionID: ROOT_ID, messageID: "checkpoint", agent: "build", directory: harness.directory,
        worktree: harness.directory, abort: new AbortController().signal, metadata: () => {}, ask: async () => {},
      })
      expect(report).toContain('"completion_allowed":true')
      expect(returned).toBe(false)
      expect(fake.abortCalls).toEqual([])
    } finally {
      release.resolve()
      await until(() => harness.logs.some(({ fields }) => fields["msg"] === "advisor pass end"))
      await hooks.event?.({ event: { type: "server.instance.disposed", properties: { directory: harness.directory } } })
      await removeHarness(harness.temporaryRoot)
    }
  })

  test("a checkpoint awaiting reports cannot abort after its instance is disposed", async () => {
    const harness = await makeHarness()
    const client = new FakeClient()
    class GatedNoteStore extends NoteStore {
      paused = false
      readonly reading = Promise.withResolvers<void>()
      readonly release = Promise.withResolvers<void>()
      override async readNotes(...args: Parameters<NoteStore["readNotes"]>) {
        const notes = await super.readNotes(...args)
        if (this.paused) {
          this.reading.resolve()
          await this.release.promise
        }
        return notes
      }
    }
    const log = harness.dependencies.createLogger({ level: "info" })
    const store = new GatedNoteStore({ dataDir: join(harness.temporaryRoot, "checkpoint-data"), log })
    let watched = true
    const checkpoint = checkpointTool({
      client, config: { abort_on_blocker: true }, contexts: new TaskContexts(store, harness.directory),
      log, store, directory: harness.directory, isWatched: () => watched,
    })
    const context = {
      sessionID: ROOT_ID, messageID: "checkpoint", agent: "build", directory: harness.directory,
      worktree: harness.directory, abort: new AbortController().signal, metadata: () => {}, ask: async () => {},
    }
    try {
      await checkpoint.execute({ phase: "inspect", task: "continue", updates: [] }, context)
      const captured = await store.readTask(harness.directory, ROOT_ID)
      if (captured === undefined) throw new Error("Checkpoint did not capture its task")
      const note = await store.writeNote({
        cwd: harness.directory, root_session: ROOT_ID, advisor_session: "advisor-session",
        advisor_slug: "reviewer", roster_name: "Reviewer", provider: "amazon-bedrock",
        model: "amazon-bedrock/openai.gpt-5.6-sol", model_display: "GPT-5.6 Sol", variant: "max",
        severity: "blocker", reasoning: "The publish step ships the failing build",
        note: "Fix the build before publishing", evidence: ["bun run build exits 1"],
        review: captured, is_fallback: false, quarantined: false,
      })
      await store.recordDispositions(harness.directory, ROOT_ID, [{
        id: note.id, state: "open", reviewed_revision: captured.revision, version: 0,
        reason: "Reproduced the failing build", evidence: ["bun run build exits 1"],
        verification: {
          revision: captured.revision, in_scope: true, affected_action: "publish",
          cost_if_delayed: "a broken release ships",
        },
      }])
      store.paused = true
      const inFlight = checkpoint.execute({
        phase: "before_action", task: "continue", next_action: "publish", updates: [],
      }, context)
      await store.reading.promise
      watched = false
      await store.close()
      store.release.resolve()
      const result = await inFlight
      expect(client.abortCalls).toEqual([])
      expect(result).toContain("only in a watched primary session")
    } finally {
      store.release.resolve()
      await store.close()
      await removeHarness(harness.temporaryRoot)
    }
  })

  test("disposing one instance stops its checkpoints and timers while another shared-data instance remains usable", async () => {
    const plugin = await loadPlugin()
    if (plugin === undefined) throw new Error("Plugin module missing")
    const first = await makeHarness()
    const second = await makeHarness({ environment: first.environment })
    const a = await plugin.createAdvisorHooks({ client: new FakeClient(), directory: first.directory }, first.dependencies)
    const b = await plugin.createAdvisorHooks({ client: new FakeClient(), directory: second.directory }, second.dependencies)
    const inspect = async (hooks: typeof a, harness: typeof first) => {
      const checkpoint = hooks.tool?.["advisor_checkpoint"]
      if (checkpoint === undefined) throw new Error("Checkpoint tool missing")
      return checkpoint.execute({ phase: "inspect", task: "continue", updates: [] }, {
        sessionID: ROOT_ID, messageID: "checkpoint", agent: "build", directory: harness.directory, worktree: harness.directory,
        abort: new AbortController().signal, metadata: () => {}, ask: async () => {},
      })
    }
    const dispose = (directory: string) => ({ type: "server.instance.disposed" as const, properties: { directory } })
    try {
      await a.event?.({ event: sessionCreated(first.directory) })
      await b.event?.({ event: sessionCreated(second.directory) })
      await inspect(a, first)
      await inspect(b, second)
      await a.event?.({ event: {
        type: "message.updated", properties: { info: {
          ...advisorResponse().info, sessionID: ROOT_ID, mode: "build",
        } },
      } })
      expect(first.dependencies.timers.pending.size).toBe(1)

      await a.event?.({ event: dispose(first.directory) })
      await b.event?.({ event: dispose(first.directory) })
      expect(first.dependencies.timers.pending.size).toBe(0)
      expect(await inspect(a, first)).toContain("only in a watched primary session")
      expect(await inspect(b, second)).toContain('"action_allowed":true')
      await a.event?.({ event: sessionIdle() })
      expect(first.logs.some(({ fields }) => fields["msg"] === "advisor pass start")).toBeFalse()
    } finally {
      await a.event?.({ event: dispose(first.directory) })
      await b.event?.({ event: dispose(second.directory) })
      await removeHarness(first.temporaryRoot)
      await removeHarness(second.temporaryRoot)
    }
  })

  test("makes the fast review available to the primary before the slow review finishes", async () => {
    const plugin = await loadPlugin()
    if (plugin === undefined) throw new Error("Plugin module missing")
    const harness = await makeHarness({
      exists: (path) => path.endsWith("WATCHDOG.yml"),
      readFile: async (path) => path.endsWith("WATCHDOG.yml")
        ? "advisors:\n  - name: Fast\n  - name: Slow\n"
        : harnessReadFile(path),
    })
    const fake = new FakeClient()
    const slow = Promise.withResolvers<void>()
    let calls = 0
    let children = 0
    let slowDone = false
    const client = {
      ...fake, session: {
        ...fake.session,
        create: async () => ({ data: { id: `advisor-session-${++children}` }, error: undefined, response: new Response() }),
        prompt: async () => {
          const index = ++calls
          if (index === 2) { await slow.promise; slowDone = true }
          const response = advisorResponse()
          return {
            data: { ...response, parts: [{
              id: `review-${index}`, type: "text" as const, sessionID: response.info.sessionID, messageID: response.info.id,
              text: `<advice severity="concern">reasoning: Reproduced the failure\nnote: Fix ${index}\nevidence: failing regression</advice>`,
            }] }, error: undefined, response: new Response(),
          }
        },
      },
    }
    try {
      const hooks = await plugin.createAdvisorHooks({ client, directory: harness.directory }, harness.dependencies)
      await hooks.event?.({ event: sessionCreated(harness.directory) })
      await hooks.event?.({ event: sessionIdle() })
      await until(() => calls === 2 && harness.logs.some(({ fields }) => fields["msg"] === "advisor card withheld"))
      // OpenCode passes {messages} to the hook, ignores the wrapper afterwards, and
      // converts this same array for the model; the concern must land in it.
      const modelMessages = [{ ...userTranscriptMessage(ROOT_SENTINEL), parts: [] as Part[] }]
      const output = { messages: modelMessages }
      await hooks["experimental.chat.messages.transform"]?.({}, output)
      expect(output.messages).toBe(modelMessages)
      expect(JSON.stringify(modelMessages)).toContain("Fix 1")
      expect(slowDone).toBeFalse()
      slow.resolve()
      await until(() => harness.logs.filter(({ fields }) => fields["msg"] === "advisor card withheld").length === 2)
      await hooks["experimental.chat.messages.transform"]?.({}, output)
      expect(output.messages).toBe(modelMessages)
      expect(JSON.stringify(modelMessages)).toContain("Fix 2")
      expect(fake.abortCalls).toHaveLength(0)
    } finally {
      slow.resolve()
      await until(() => harness.logs.filter(({ fields }) => fields["msg"] === "advisor card withheld").length === 2)
      await removeHarness(harness.temporaryRoot)
    }
  })

  test("the checkpoint tool preserves stop and refuses reviewer or unwatched sessions", async () => {
    const plugin = await loadPlugin()
    if (plugin === undefined) throw new Error("Plugin module missing")
    const harness = await makeHarness()
    const client = new FakeClient()
    try {
      const hooks = await plugin.createAdvisorHooks({ client, directory: harness.directory }, harness.dependencies)
      await hooks.event?.({ event: sessionCreated(harness.directory) })
      const checkpoint = hooks.tool?.["advisor_checkpoint"]
      if (checkpoint === undefined) throw new Error("Checkpoint tool missing")
      const context = {
        sessionID: ROOT_ID, messageID: "checkpoint", agent: "build",
        directory: harness.directory, worktree: harness.directory, abort: new AbortController().signal,
        metadata: () => {}, ask: async () => { throw new Error("Unexpected permission request") },
      }
      await checkpoint.execute({ phase: "inspect", task: "stop", updates: [] }, context)
      const result = await checkpoint.execute({ phase: "inspect", task: "continue", updates: [] }, context)
      if (typeof result !== "string") throw new Error("Expected a JSON checkpoint result")
      const report: unknown = JSON.parse(result)
      expect(report).toMatchObject({ action_allowed: false, context: { stopped: true } })
      expect(await checkpoint.execute({ phase: "inspect", task: "continue", updates: [] },
        { ...context, agent: "advisor-reviewer" })).toContain("only in a watched primary session")
      expect(await checkpoint.execute({ phase: "inspect", task: "continue", updates: [] },
        { ...context, sessionID: "other-session" })).toContain("only in a watched primary session")
      expect(client.promptCalls).toHaveLength(0)
    } finally {
      await removeHarness(harness.temporaryRoot)
    }
  })

  test("abort_on_blocker pauses only the named action once a blocker is verified against it", async () => {
    const plugin = await loadPlugin()
    if (plugin === undefined) throw new Error("Plugin module missing")
    const harness = await makeHarness({
      readFile: async (path) => path.endsWith("advisor.jsonc")
        ? JSON.stringify({ ...JSON.parse(HARNESS_CONFIG), abort_on_blocker: true })
        : readFile(path, "utf8"),
    })
    const client = new FakeClient()
    try {
      const hooks = await plugin.createAdvisorHooks({ client, directory: harness.directory }, harness.dependencies)
      await hooks.event?.({ event: sessionCreated(harness.directory) })
      const checkpoint = hooks.tool?.["advisor_checkpoint"]
      if (checkpoint === undefined) throw new Error("Checkpoint tool missing")
      const context = {
        sessionID: ROOT_ID, messageID: "checkpoint", agent: "build",
        directory: harness.directory, worktree: harness.directory, abort: new AbortController().signal,
        metadata: () => {}, ask: async () => { throw new Error("Unexpected permission request") },
      }
      const run = async (args: Record<string, unknown>) => {
        const result = await checkpoint.execute({ phase: "inspect", task: "continue", updates: [], ...args }, context)
        if (typeof result !== "string") throw new Error("Expected a JSON checkpoint result")
        return JSON.parse(result) as { action_allowed: boolean; context: { task_id: string; revision: string } }
      }
      const { context: captured } = await run({})
      const store = new NoteStore({ dataDir: join(harness.temporaryRoot, "data", "opencode-advisor"), log: harness.dependencies.createLogger({ level: "info" }) })
      const note = await store.writeNote({
        cwd: harness.directory, root_session: ROOT_ID, advisor_session: "advisor-session",
        advisor_slug: "reviewer", roster_name: "Reviewer", provider: "amazon-bedrock",
        model: "amazon-bedrock/openai.gpt-5.6-sol", model_display: "GPT-5.6 Sol", variant: "max",
        severity: "blocker", reasoning: "The publish step ships the failing build",
        note: "Fix the build before publishing", evidence: ["bun run build exits 1"],
        review: { task_id: captured.task_id, revision: captured.revision },
        is_fallback: false, quarantined: false,
      })
      const verified = await run({
        updates: [{
          id: note.id, state: "open", reviewed_revision: captured.revision, version: 0, reason: "Reproduced the failing build",
          evidence: ["bun run build exits 1"],
          verification: { in_scope: true, affected_action: "publish", cost_if_delayed: "a broken release ships" },
        }],
      })
      expect(verified.action_allowed).toBeTrue()
      expect(client.abortCalls).toEqual([])

      const unrelated = await run({ phase: "before_action", next_action: "lint" })
      expect(unrelated.action_allowed).toBeTrue()
      expect(client.abortCalls).toEqual([])

      const paused = await run({ phase: "before_action", next_action: "publish" })
      expect(paused.action_allowed).toBeFalse()
      expect(client.abortCalls).toEqual([ROOT_ID])
      expect(harness.logs.some(({ fields }) => fields["msg"] === "advisor blocker paused the named action" &&
        fields["next_action"] === "publish")).toBeTrue()
      await rm(join(harness.temporaryRoot, "data", "opencode-advisor", "notes", `${note.id}.json`))
      const unavailable = await run({ phase: "before_action", next_action: "publish" })
      expect(unavailable.action_allowed).toBeFalse()
      expect(client.abortCalls).toEqual([ROOT_ID, ROOT_ID])
      expect((await run({ phase: "before_action", next_action: "lint" })).action_allowed).toBeTrue()
      expect(client.abortCalls).toEqual([ROOT_ID, ROOT_ID])
    } finally {
      await removeHarness(harness.temporaryRoot)
    }
  })

  test("returns the coexistence hooks and the primary checkpoint tool", async () => {
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
        "config",
        "event",
        "experimental.chat.messages.transform",
        "experimental.chat.system.transform",
        "experimental.session.compacting",
        "tool",
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
        return harnessReadFile(path)
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

  test("logs why no advisor runs when the roster file yields no usable entries and no default_model is set", async () => {
    // Given
    const plugin = await loadPlugin()
    expect(plugin).toBeDefined()
    if (plugin === undefined) return
    const harness = await makeHarness({
      exists: (path) => path.endsWith("WATCHDOG.yml"),
      readFile: async (path) => {
        if (path.endsWith("WATCHDOG.yml")) return "advisors:\n  - name: Implicit\n"
        if (path.endsWith("advisor.jsonc")) return "{}"
        return readFile(path, "utf8")
      },
    })

    try {
      // When
      await plugin.createAdvisorHooks(
        { client: new FakeClient(), directory: harness.directory },
        harness.dependencies,
      )

      // Then
      const rosterWarnings = harness.logs
        .filter(({ level, fields }) => level === "warn" && fields["source"] === "roster")
        .map(({ fields }) => fields["warning"])
      expect(rosterWarnings).toEqual([
        'Advisor "Implicit" has no model and no default_model is configured; skipped',
        "No usable roster entries and no default_model configured; no advisors will run",
      ])
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
      await until(() => harness.logs.some(({ fields }) => fields["msg"] === "advisor pass end"))

      // Then
      const prompt = client.promptCalls[0]?.body.parts[0].text ?? ""
      expect(prompt).toContain(ROOT_SENTINEL)
      expect(prompt).not.toContain(ADVISOR_SENTINEL)
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
      await until(() => harness.logs.some(({ fields }) => fields["msg"] === "advisor pass end"))

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
