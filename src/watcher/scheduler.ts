import type { AdvisorConfig } from "../config"
import type { Logger } from "../log"

export type PassReason = "step" | "idle"

export type TimerApi<Timer> = Readonly<{
  setTimeout: (run: () => void, delayMs: number) => Timer
  clearTimeout: (timer: Timer) => void
}>

type SchedulerState<Timer> = {
  inFlight: boolean
  dirty: boolean
  dirtyReason: PassReason
  timer: Timer | undefined
  lastPassEnd: number
  suppressUntil: number
}

export type PassSchedulerOptions<Timer> = Readonly<{
  config: AdvisorConfig
  log: Logger
  clock: () => number
  timers: TimerApi<Timer>
  onPass: (sessionID: string, reason: PassReason) => Promise<void>
}>

export class PassScheduler<Timer> {
  private readonly states = new Map<string, SchedulerState<Timer>>()

  constructor(private readonly options: PassSchedulerOptions<Timer>) {}

  trigger(sessionID: string, reason: PassReason): void {
    const state = this.state(sessionID)
    if (this.options.clock() < state.suppressUntil) return
    if (state.inFlight) {
      state.dirty = true
      if (reason === "idle") state.dirtyReason = "idle"
      return
    }
    if (reason === "idle") {
      this.clearTimer(state)
      void this.run(sessionID, "idle")
      return
    }
    this.queueStep(sessionID, state, true)
  }

  suppress(sessionID: string, ms: number): void {
    const state = this.state(sessionID)
    state.suppressUntil = Math.max(state.suppressUntil, this.options.clock() + ms)
  }

  forget(sessionID: string): void {
    const state = this.states.get(sessionID)
    if (state !== undefined) this.clearTimer(state)
    this.states.delete(sessionID)
  }

  private state(sessionID: string): SchedulerState<Timer> {
    const existing = this.states.get(sessionID)
    if (existing !== undefined) return existing
    const created: SchedulerState<Timer> = {
      inFlight: false,
      dirty: false,
      dirtyReason: "step",
      timer: undefined,
      lastPassEnd: Number.NEGATIVE_INFINITY,
      suppressUntil: Number.NEGATIVE_INFINITY,
    }
    this.states.set(sessionID, created)
    return created
  }

  private clearTimer(state: SchedulerState<Timer>): void {
    if (state.timer === undefined) return
    this.options.timers.clearTimeout(state.timer)
    state.timer = undefined
  }

  private queueStep(sessionID: string, state: SchedulerState<Timer>, debounce: boolean): void {
    if (state.timer !== undefined) return
    const cooldownRemaining = Math.max(
      0,
      state.lastPassEnd + this.options.config.cooldown_ms - this.options.clock(),
    )
    const delay = Math.max(debounce ? this.options.config.pass_debounce_ms : 0, cooldownRemaining)
    if (delay === 0) {
      void this.run(sessionID, "step")
      return
    }
    state.timer = this.options.timers.setTimeout(() => {
      state.timer = undefined
      void this.run(sessionID, "step")
    }, delay)
  }

  private async run(sessionID: string, reason: PassReason): Promise<void> {
    const state = this.state(sessionID)
    if (this.options.clock() < state.suppressUntil) return
    if (state.inFlight) {
      state.dirty = true
      if (reason === "idle") state.dirtyReason = "idle"
      return
    }
    state.inFlight = true
    try {
      await this.options.onPass(sessionID, reason)
    } catch (error) {
      await this.options.log.error({ msg: "watcher.pass.failed", sessionID, reason, error })
    } finally {
      state.inFlight = false
      state.lastPassEnd = this.options.clock()
    }
    if (!state.dirty) return
    const followUpReason = state.dirtyReason
    state.dirty = false
    state.dirtyReason = "step"
    if (followUpReason === "idle") {
      void this.run(sessionID, "idle")
      return
    }
    this.queueStep(sessionID, state, false)
  }
}
