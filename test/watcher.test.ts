import { describe, expect, test } from "bun:test"
import type {
  AssistantMessage,
  Event,
  EventMessageUpdated,
  EventSessionCreated,
  EventSessionDeleted,
  EventSessionStatus,
  Session,
  TextPart,
} from "@opencode-ai/sdk"

import { DEFAULTS, type AdvisorConfig } from "../src/config"
import type { LogFields, Logger } from "../src/log"
import { Watcher } from "../src/watcher"

type FakeTimer = Readonly<{ id: number }>
type Pass = Readonly<{ sessionID: string; reason: "step" | "idle" }>

class FakeTime {
  now = 0
  private nextID = 1
  private readonly tasks = new Map<number, { readonly at: number; readonly run: () => void }>()

  readonly clock = (): number => this.now

  readonly timers = {
    setTimeout: (run: () => void, delay: number): FakeTimer => {
      const id = this.nextID
      this.nextID += 1
      this.tasks.set(id, { at: this.now + delay, run })
      return { id }
    },
    clearTimeout: (timer: FakeTimer): void => {
      this.tasks.delete(timer.id)
    },
  }

  async advance(ms: number): Promise<void> {
    const end = this.now + ms
    while (true) {
      const due = [...this.tasks.entries()]
        .filter(([, task]) => task.at <= end)
        .sort((left, right) => left[1].at - right[1].at)[0]
      if (due === undefined) break
      this.now = due[1].at
      this.tasks.delete(due[0])
      due[1].run()
      await settle()
    }
    this.now = end
    await settle()
  }
}

class FakeClient {
  readonly calls: string[] = []
  readonly sessions = new Map<string, Session>()

  readonly session = {
    get: async ({ path }: { readonly path: { readonly id: string } }) => {
      this.calls.push(path.id)
      const data = this.sessions.get(path.id)
      return data === undefined ? {} : { data }
    },
  }
}

function createLogger(): Readonly<{ logger: Logger; infos: LogFields[]; errors: LogFields[] }> {
  const infos: LogFields[] = []
  const errors: LogFields[] = []
  const ignore = async (): Promise<void> => {}
  return {
    logger: {
      debug: ignore,
      info: async (fields) => { infos.push(fields) },
      warn: ignore,
      error: async (fields) => { errors.push(fields) },
    },
    infos,
    errors,
  }
}

function config(overrides: Partial<AdvisorConfig> = {}): AdvisorConfig {
  return { ...DEFAULTS, ...overrides }
}

function session(id: string, parentID?: string): Session {
  const common = {
    id,
    projectID: "project",
    directory: `/work/${id}`,
    title: id,
    version: "1",
    time: { created: 0, updated: 0 },
  }
  return parentID === undefined ? common : { ...common, parentID }
}

function created(info: Session): EventSessionCreated {
  return { type: "session.created", properties: { info } }
}

function deleted(info: Session): EventSessionDeleted {
  return { type: "session.deleted", properties: { info } }
}

function assistant(sessionID: string, mode = "build", completed = 1): EventMessageUpdated {
  const info: AssistantMessage = {
    id: `message-${sessionID}-${mode}-${completed}`,
    sessionID,
    role: "assistant",
    time: { created: 0, completed },
    parentID: "user-message",
    modelID: "model",
    providerID: "provider",
    mode,
    path: { cwd: "/work", root: "/work" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
  return { type: "message.updated", properties: { info } }
}

function idle(sessionID: string): EventSessionStatus {
  return { type: "session.status", properties: { sessionID, status: { type: "idle" } } }
}

function textPart(sessionID: string, text: string): TextPart {
  return { id: "part", messageID: "message", sessionID, type: "text", text }
}

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

function harness(options: Readonly<{
  config?: AdvisorConfig
  onPass?: (sessionID: string, reason: "step" | "idle") => Promise<void>
}> = {}) {
  const time = new FakeTime()
  const client = new FakeClient()
  const passes: Pass[] = []
  const logs = createLogger()
  const onPass = options.onPass ?? (async (sessionID, reason) => { passes.push({ sessionID, reason }) })
  const watcher = new Watcher({
    config: options.config ?? config({ pass_debounce_ms: 10, cooldown_ms: 20 }),
    log: logs.logger,
    clock: time.clock,
    timers: time.timers,
    client,
    onPass,
  })
  return { watcher, time, client, passes, logs }
}

describe("Watcher registry", () => {
  test("ignores runtime event types missing from the pinned SDK union", async () => {
    // Given
    const { watcher, logs } = harness()
    const runtimeEvents = [
      { type: "plugin.added", properties: {} } as unknown as Event,
      { type: "message.part.delta", properties: {} } as unknown as Event,
    ]

    // When
    const handled = Promise.all(runtimeEvents.map((event) => watcher.handleEvent(event)))

    // Then
    await expect(handled).resolves.toBeDefined()
    expect(logs.errors).toEqual([])
  })

  test("learns roots and stores only the first non-advisor user text", async () => {
    // Given
    const { watcher } = harness()
    await watcher.handleEvent(created(session("root")))

    // When
    watcher.handleChatMessage(
      { sessionID: "root", agent: "build" },
      { parts: [textPart("root", "first"), textPart("root", " request")] },
    )
    watcher.handleChatMessage(
      { sessionID: "root", agent: "build" },
      { parts: [textPart("root", "replacement")] },
    )
    watcher.handleChatMessage(
      { sessionID: "root", agent: "advisor-delivery" },
      { parts: [textPart("root", "card")] },
    )

    // Then
    expect(watcher.isWatched("root")).toBe(true)
    expect(watcher.firstUserText("root")).toBe("first request")
  })

  test("ignores unpromoted children and explicitly marked advisor sessions", async () => {
    // Given
    const { watcher, time, passes, logs } = harness()
    await watcher.handleEvent(created(session("child", "root")))
    await watcher.handleEvent(created(session("advisor")))
    watcher.markAdvisorSession("advisor")

    // When
    await watcher.handleEvent(assistant("child"))
    await watcher.handleEvent(assistant("advisor"))
    await time.advance(20)

    // Then
    expect(watcher.isWatched("child")).toBe(false)
    expect(watcher.isWatched("advisor")).toBe(false)
    expect(passes).toEqual([])
    expect(logs.infos.filter((fields) => fields["action"] === "ignored")).toHaveLength(2)
  })

  test("promotes only children whose assistant mode is enabled in advise_agents", async () => {
    // Given
    const enabled = harness({ config: config({ pass_debounce_ms: 10, cooldown_ms: 0, advise_agents: { "sisyphus-junior": true } }) })
    const disabled = harness({ config: config({ pass_debounce_ms: 10, cooldown_ms: 0 }) })
    await enabled.watcher.handleEvent(created(session("enabled-child", "root")))
    await disabled.watcher.handleEvent(created(session("disabled-child", "root")))

    // When
    await enabled.watcher.handleEvent(assistant("enabled-child", "sisyphus-junior"))
    await disabled.watcher.handleEvent(assistant("disabled-child", "sisyphus-junior"))
    await enabled.time.advance(10)
    await disabled.time.advance(10)
    await enabled.watcher.handleEvent(idle("enabled-child"))

    // Then
    expect(enabled.watcher.isWatched("enabled-child")).toBe(true)
    expect(enabled.passes).toEqual([
      { sessionID: "enabled-child", reason: "step" },
      { sessionID: "enabled-child", reason: "idle" },
    ])
    expect(disabled.watcher.isWatched("disabled-child")).toBe(false)
    expect(disabled.passes).toEqual([])
  })

  test("fetches an unknown idle session once and caches it as a root", async () => {
    // Given
    const { watcher, client } = harness()
    client.sessions.set("unknown", session("unknown"))

    // When
    await watcher.handleEvent(idle("unknown"))
    await watcher.handleEvent(idle("unknown"))

    // Then
    expect(client.calls).toEqual(["unknown"])
    expect(watcher.isWatched("unknown")).toBe(true)
  })

  test("evicts deleted sessions and caps roots at 200 least-recently-seen entries", async () => {
    // Given
    const { watcher, time, passes } = harness()
    for (let index = 0; index <= 200; index += 1) {
      await watcher.handleEvent(created(session(`root-${index}`)))
    }
    await watcher.handleEvent(assistant("root-200"))

    // When
    await watcher.handleEvent(deleted(session("root-200")))
    await time.advance(20)

    // Then
    expect(watcher.isWatched("root-0")).toBe(false)
    expect(watcher.isWatched("root-1")).toBe(true)
    expect(watcher.isWatched("root-200")).toBe(false)
    expect(passes).toEqual([])
  })

  test("allows a deleted advisor session id to be learned again", async () => {
    // Given
    const { watcher } = harness()
    watcher.markAdvisorSession("reused")
    await watcher.handleEvent(deleted(session("reused")))

    // When
    await watcher.handleEvent(created(session("reused")))

    // Then
    expect(watcher.isWatched("reused")).toBe(true)
  })
})

describe("Watcher scheduling", () => {
  test("debounces quick completed assistant steps without restarting the deadline", async () => {
    // Given
    const { watcher, time, passes, logs } = harness()
    await watcher.handleEvent(created(session("root")))

    // When
    await watcher.handleEvent(assistant("root", "build", 1))
    await time.advance(4)
    await watcher.handleEvent(assistant("root", "build", 2))
    await time.advance(4)
    await watcher.handleEvent(assistant("root", "build", 3))
    await time.advance(2)

    // Then
    expect(passes).toEqual([{ sessionID: "root", reason: "step" }])
    expect(logs.infos).toEqual([
      { msg: "advisor trigger", sessionID: "root", reason: "step", action: "scheduled" },
      { msg: "advisor trigger", sessionID: "root", reason: "step", action: "debounced" },
      { msg: "advisor trigger", sessionID: "root", reason: "step", action: "debounced" },
      { msg: "advisor pass start", sessionID: "root", reason: "step" },
      { msg: "advisor pass end", sessionID: "root", reason: "step", durationMs: 0, ok: true },
    ])
  })

  test("idle cancels a pending debounce and runs immediately", async () => {
    // Given
    const { watcher, time, passes } = harness()
    await watcher.handleEvent(created(session("root")))
    await watcher.handleEvent(assistant("root"))

    // When
    await watcher.handleEvent(idle("root"))
    await time.advance(20)

    // Then
    expect(passes).toEqual([{ sessionID: "root", reason: "idle" }])
  })

  test("coalesces five triggers during an in-flight pass into one follow-up", async () => {
    // Given
    let release: (() => void) | undefined
    const passes: Pass[] = []
    const { watcher, logs } = harness({
      config: config({ pass_debounce_ms: 0, cooldown_ms: 0 }),
      onPass: async (sessionID, reason) => {
        passes.push({ sessionID, reason })
        if (passes.length === 1) await new Promise<void>((resolve) => { release = resolve })
      },
    })
    await watcher.handleEvent(created(session("root")))
    await watcher.handleEvent(idle("root"))

    // When
    for (let index = 1; index <= 5; index += 1) await watcher.handleEvent(assistant("root", "build", index))
    release?.()
    await settle()

    // Then
    expect(passes).toEqual([
      { sessionID: "root", reason: "idle" },
      { sessionID: "root", reason: "step" },
    ])
    expect(logs.infos.filter((fields) => fields["action"] === "dirty")).toHaveLength(5)
  })

  test("ignores delivery-agent completions and every trigger inside suppression", async () => {
    // Given
    const { watcher, time, passes, logs } = harness()
    await watcher.handleEvent(created(session("root")))

    // When
    await watcher.handleEvent(assistant("root", "advisor-delivery"))
    watcher.suppress("root", 30)
    await watcher.handleEvent(idle("root"))
    await time.advance(30)

    // Then
    expect(passes).toEqual([])
    expect(logs.infos).toEqual([
      { msg: "advisor trigger", sessionID: "root", reason: "step", action: "ignored" },
      { msg: "advisor trigger", sessionID: "root", reason: "idle", action: "suppressed" },
    ])
  })

  test("enforces cooldown for step passes while idle bypasses it", async () => {
    // Given
    const { watcher, time, passes, logs } = harness()
    await watcher.handleEvent(created(session("root")))
    await watcher.handleEvent(assistant("root", "build", 1))
    await time.advance(10)

    // When
    await watcher.handleEvent(assistant("root", "build", 2))
    await time.advance(10)
    expect(passes).toHaveLength(1)
    await watcher.handleEvent(idle("root"))

    // Then
    expect(passes).toEqual([
      { sessionID: "root", reason: "step" },
      { sessionID: "root", reason: "idle" },
    ])
    expect(logs.infos).toContainEqual({
      msg: "advisor trigger",
      sessionID: "root",
      reason: "step",
      action: "cooldown",
    })
  })

  test("logs a rejected pass, clears in-flight state, and accepts the next trigger", async () => {
    // Given
    let attempts = 0
    const passes: Pass[] = []
    const { watcher, logs } = harness({
      config: config({ pass_debounce_ms: 0, cooldown_ms: 0 }),
      onPass: async (sessionID, reason) => {
        attempts += 1
        if (attempts === 1) throw new Error("pass failed")
        passes.push({ sessionID, reason })
      },
    })
    await watcher.handleEvent(created(session("root")))
    await watcher.handleEvent(idle("root"))
    await settle()

    // When
    await watcher.handleEvent(idle("root"))
    await settle()

    // Then
    expect(logs.errors).toHaveLength(1)
    expect(passes).toEqual([{ sessionID: "root", reason: "idle" }])
  })
})
