import type { Part, Session, SessionGetError } from "@opencode-ai/sdk"
import type { AdvisorConfig } from "../config"
import type { Logger } from "../log"
import type { PassReason, TimerApi } from "./scheduler"

export type ChatMessageInput = Readonly<{ sessionID: string; agent?: string }>
export type ChatMessageOutput = Readonly<{ parts: readonly Part[] }>
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
  dispatchOnly?: boolean
  isPinned?: (sessionID: string) => boolean
  onForget?: (sessionID: string, reason: "evicted" | "deleted" | "disposed") => void
}>
