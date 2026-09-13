import type {
  Event,
  Message,
  Part,
  Session,
  SessionGetError,
} from "@opencode-ai/sdk"

import type { AdvisorConfig } from "./config"
import type { Logger } from "./log"
import { isIgnoredEventType } from "./watcher/events"
import {
  PassScheduler,
  type PassReason,
  type TimerApi,
  type TriggerAction,
} from "./watcher/scheduler"

export type ChatMessageInput = Readonly<{
  sessionID: string
  agent?: string
}>

export type ChatMessageOutput = Readonly<{
  parts: readonly Part[]
}>

export type SessionClient = Readonly<{
  session: Readonly<{
    get: (options: Readonly<{ path: Readonly<{ id: string }> }>) => Promise<Readonly<{
      data?: Session
      error?: SessionGetError
    }>>
  }>
}>

export type WatcherOptions<Timer> = Readonly<{
  config: AdvisorConfig
  log: Logger
  clock: () => number
  timers: TimerApi<Timer>
  client: SessionClient
  onPass: (sessionID: string, reason: PassReason) => Promise<void>
}>

type RootRecord = {
  directory: string
  firstUserText?: string
}

const ROOT_LIMIT = 200

export class Watcher<Timer> {
  private readonly roots = new Map<string, RootRecord>()
  private readonly children = new Set<string>()
  private readonly advisorSessions = new Set<string>()
  private readonly advisedChildren = new Map<string, string>()
  private readonly pendingSessionGets = new Map<string, Promise<void>>()
  private readonly ignoredRuntimeEventTypes = new Set<string>()
  private readonly scheduler: PassScheduler<Timer>

  constructor(private readonly options: WatcherOptions<Timer>) {
    this.scheduler = new PassScheduler(options)
  }

  dispose(): void {
    for (const id of [...this.roots.keys(), ...this.advisedChildren.keys()]) this.forgetSession(id)
    this.children.clear()
    this.advisorSessions.clear()
  }

  markAdvisorSession(sessionID: string): void {
    this.advisorSessions.add(sessionID)
    this.forgetSession(sessionID)
  }

  isWatched(sessionID: string): boolean {
    return !this.advisorSessions.has(sessionID) && (
      this.roots.has(sessionID) || this.advisedChildren.has(sessionID)
    )
  }

  firstUserText(sessionID: string): string | undefined {
    return this.roots.get(sessionID)?.firstUserText
  }

  suppress(sessionID: string, ms: number): void {
    this.scheduler.suppress(sessionID, ms)
  }

  handleChatMessage(input: ChatMessageInput, output: ChatMessageOutput): void {
    if (input.agent?.startsWith("advisor-") === true) return
    const root = this.roots.get(input.sessionID)
    if (root === undefined || root.firstUserText !== undefined) return
    const text = output.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("")
    if (text.length === 0) return
    root.firstUserText = text
    this.touchRoot(input.sessionID, root)
  }

  async handleEvent(event: Event): Promise<void> {
    const eventType: string = event.type
    switch (event.type) {
      case "session.created":
      case "session.updated":
        this.registerSession(event.properties.info)
        return
      case "message.updated":
        this.handleMessage(event.properties.info)
        return
      case "session.status":
        if (event.properties.status.type === "idle") {
          await this.handleIdle(event.properties.sessionID)
        }
        return
      case "session.deleted":
        this.evictSession(event.properties.info.id)
        return
      default:
        if (isIgnoredEventType(eventType)) return
        if (this.ignoredRuntimeEventTypes.has(eventType)) return
        this.ignoredRuntimeEventTypes.add(eventType)
        await this.options.log.debug({ msg: "watcher runtime event ignored", type: eventType })
    }
  }

  private registerSession(info: Session): void {
    if (this.advisorSessions.has(info.id)) return
    if (info.parentID !== undefined) {
      this.children.add(info.id)
      this.roots.delete(info.id)
      return
    }
    this.children.delete(info.id)
    this.advisedChildren.delete(info.id)
    const existing = this.roots.get(info.id)
    this.touchRoot(info.id, {
      directory: info.directory,
      ...(existing?.firstUserText === undefined ? {} : { firstUserText: existing.firstUserText }),
    })
  }

  private touchRoot(sessionID: string, root: RootRecord): void {
    this.roots.delete(sessionID)
    this.roots.set(sessionID, root)
    while (this.roots.size > ROOT_LIMIT) {
      const oldest = this.roots.keys().next().value
      if (oldest === undefined) return
      this.forgetSession(oldest)
    }
  }

  private handleMessage(info: Message): void {
    if (this.advisorSessions.has(info.sessionID)) {
      if (info.role === "assistant" && info.time.completed !== undefined) {
        this.logIgnoredTrigger(info.sessionID, "step")
      }
      return
    }
    if (info.role === "user") {
      if (info.agent === "advisor-delivery") return
      return
    }
    if (info.mode === "advisor-delivery") {
      if (info.time.completed !== undefined) this.logIgnoredTrigger(info.sessionID, "step")
      return
    }
    if (this.children.has(info.sessionID)) {
      const setting = this.options.config.advise_agents[info.mode]
      if (setting !== undefined && setting !== false) {
        this.advisedChildren.set(info.sessionID, info.mode)
      }
    }
    if (info.time.completed === undefined) return
    if (!this.isWatched(info.sessionID)) {
      this.logIgnoredTrigger(info.sessionID, "step")
      return
    }
    const root = this.roots.get(info.sessionID)
    if (root !== undefined) this.touchRoot(info.sessionID, root)
    this.scheduler.trigger(info.sessionID, "step")
  }

  private async handleIdle(sessionID: string): Promise<void> {
    if (this.advisorSessions.has(sessionID)) {
      this.logIgnoredTrigger(sessionID, "idle")
      return
    }
    if (this.isWatched(sessionID)) {
      const root = this.roots.get(sessionID)
      if (root !== undefined) this.touchRoot(sessionID, root)
      this.scheduler.trigger(sessionID, "idle")
      return
    }
    if (this.children.has(sessionID)) {
      this.logIgnoredTrigger(sessionID, "idle")
      return
    }
    const pending = this.pendingSessionGets.get(sessionID)
    if (pending !== undefined) {
      await pending
      return
    }
    const request = this.fetchUnknownSession(sessionID)
    this.pendingSessionGets.set(sessionID, request)
    await request
  }

  private async fetchUnknownSession(sessionID: string): Promise<void> {
    try {
      const result = await this.options.client.session.get({ path: { id: sessionID } })
      if (result.data === undefined || result.error !== undefined) {
        await this.options.log.warn({ msg: "watcher.session.get.failed", sessionID, error: result.error })
        return
      }
      this.registerSession(result.data)
      if (this.isWatched(sessionID)) this.scheduler.trigger(sessionID, "idle")
      else this.logIgnoredTrigger(sessionID, "idle")
    } catch (error) {
      await this.options.log.error({ msg: "watcher.session.get.failed", sessionID, error })
    } finally {
      this.pendingSessionGets.delete(sessionID)
    }
  }

  private forgetSession(sessionID: string): void {
    this.roots.delete(sessionID)
    this.children.delete(sessionID)
    this.advisedChildren.delete(sessionID)
    this.scheduler.forget(sessionID)
  }

  private evictSession(sessionID: string): void {
    this.advisorSessions.delete(sessionID)
    this.forgetSession(sessionID)
  }

  private logIgnoredTrigger(sessionID: string, reason: PassReason): void {
    const action: TriggerAction = "ignored"
    void this.options.log.info({ msg: "advisor trigger", sessionID, reason, action })
  }
}
