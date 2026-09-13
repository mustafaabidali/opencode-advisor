import { randomUUID } from "node:crypto"
import type { Message } from "@opencode-ai/sdk"
import { FindingStore } from "../notes/findings"
import type { UsageAttempt, UsageCoverage, UsageState } from "./types"
import { within } from "../async"
import { remember } from "../cache"

type BeginInput = Pick<UsageAttempt, "root_session" | "advisor_session" | "advisor_slug" | "model" | "variant"> &
  Readonly<{ pass_id?: string }>
type Options = Readonly<{
  dataDir: string
  directory: string
  clock?: () => number
  readMessage?: (sessionID: string, messageID: string) => Promise<Message | undefined>
  readHistory?: (sessionID: string, limit: number) => Promise<readonly Message[]>
  reconcileMaxMessages?: number
  reconcileTimeoutMs?: number
}>

export class UsageLedger {
  readonly #store: FindingStore
  readonly #clock: () => number
  readonly #reconciling = new Set<AbortController>()
  readonly #children = new Set<string>()
  #closed = false
  constructor(private readonly options: Options) {
    this.#store = new FindingStore(options.dataDir)
    this.#clock = options.clock ?? Date.now
  }

  async begin(input: BeginInput): Promise<UsageAttempt> {
    const attempt: UsageAttempt = { ...input, id: randomUUID(), pass_id: input.pass_id ?? randomUUID(),
      cwd: this.options.directory, started_at: this.#clock(), settled_at: null, prompt_id: null,
      state: "running", coverage: "unknown" }
    await this.#store.beginUsage(attempt)
    remember(this.#children, attempt.advisor_session, 800)
    return attempt
  }
  tracks(sessionID: string): boolean { return this.#children.has(sessionID) }

  async observe(info: Message): Promise<void> { await this.#observe(info, false) }

  async #observe(info: Message, authoritative: boolean, signal?: AbortSignal): Promise<void> {
    if (this.#closed || signal?.aborted) return
    const attempt = await this.#store.findUsage(info.sessionID, info.time.created, info.role === "assistant" ? info.parentID : "")
    if (this.#closed || signal?.aborted || attempt === undefined || attempt.cwd !== this.options.directory) return
    remember(this.#children, info.sessionID, 800)
    const inWindow = info.time.created >= attempt.started_at &&
      (attempt.settled_at === null || info.time.created <= attempt.settled_at)
    if (info.role === "user") {
      if (inWindow && attempt.prompt_id === null) await this.#store.usagePrompt(attempt.id, info.id)
      return
    }
    const attributed = inWindow || info.parentID === attempt.prompt_id
    const valid = (value: number | undefined) => typeof value === "number" && Number.isFinite(value) && value >= 0
    const amount = (value: number | undefined) => valid(value) ? value ?? 0 : 0
    const raw = [info.cost, info.tokens?.input, info.tokens?.output, info.tokens?.reasoning,
      info.tokens?.cache?.read, info.tokens?.cache?.write]
    const accepted = await this.#store.recordUsage({
      message_id: info.id, advisor_session: info.sessionID, cwd: attempt.cwd,
      root_session: attempt.root_session, advisor_slug: attempt.advisor_slug,
      attempt_id: attributed ? attempt.id : null, parent_id: info.parentID,
      created_at: info.time.created, completed_at: info.time.completed ?? null,
      model: `${info.providerID}/${info.modelID}`, cost: amount(raw[0]), input: amount(raw[1]),
      output: amount(raw[2]), reasoning: amount(raw[3]),
      cache_read: amount(raw[4]), cache_write: amount(raw[5]), unknown_usage: raw.every(valid) ? 0 : 1,
      summary: info.summary ? 1 : 0,
    }, authoritative)
    if (!accepted && !authoritative) {
      const read = this.options.readMessage?.(info.sessionID, info.id)
      const result = read === undefined ? undefined :
        await within(read, this.options.reconcileTimeoutMs ?? 2000).catch(() => undefined)
      const current = result?.completed ? result.value : undefined
      if (current?.id === info.id && current.sessionID === info.sessionID) await this.#observe(current, true, signal)
    }
  }

  async finish(id: string, state: UsageState, final?: Message): Promise<void> {
    if (this.#closed) return
    const attempt = await this.#store.getUsage(id)
    if (this.#closed || attempt === undefined) return
    if (state === "not_sent") {
      await this.#store.finishUsage(id, state, this.#clock(), "complete")
      return
    }
    if (final !== undefined) await this.observe(final)
    const controller = new AbortController()
    this.#reconciling.add(controller)
    try {
      const result = await within(
        this.#reconcile(attempt, controller.signal, final?.id), this.options.reconcileTimeoutMs ?? 2000,
      ).catch(() => undefined)
      const coverage = result?.completed ? result.value : "partial"
      controller.abort()
      if (!this.#closed) await this.#store.finishUsage(id, state, this.#clock(), state === "cancellation_uncertain" ? "partial" : coverage)
    } finally { controller.abort(); this.#reconciling.delete(controller) }
  }

  async #reconcile(attempt: UsageAttempt, signal: AbortSignal, finalID?: string): Promise<UsageCoverage> {
    const read = this.options.readHistory
    if (read === undefined) return "partial"
    const maximum = Math.max(1, this.options.reconcileMaxMessages ?? 256)
    let limit = Math.min(16, maximum)
    for (;;) {
      if (signal.aborted || this.#closed) return "partial"
      const history = [...await read(attempt.advisor_session, limit)]
        .filter((info) => info.sessionID === attempt.advisor_session)
        .sort((a, b) => a.time.created - b.time.created || a.id.localeCompare(b.id))
      if (signal.aborted || this.#closed) return "partial"
      const covered = (history.length < limit || history.some((info) => info.time.created < attempt.started_at)) &&
        (finalID === undefined || history.some((info) => info.id === finalID))
      if (covered || limit === maximum) {
        // The attempt window covers synthetic compaction prompts and their continuations too.
        for (const info of history.filter((info) => info.time.created >= attempt.started_at)) {
          if (info.role !== "user" || covered) await this.#observe(info, true, signal)
        }
        return covered ? "complete" : "partial"
      }
      limit = Math.min(maximum, limit * 2)
    }
  }
  summary(rootSession?: string) { return this.#store.usageSummary(this.options.directory, rootSession) }
  async recoverPass(passID: string, state: UsageState, final?: Message): Promise<void> {
    for (const attempt of await this.#store.usageForPass(passID)) {
      if (attempt.cwd !== this.options.directory) continue
      await this.finish(attempt.id, state, final?.sessionID === attempt.advisor_session ? final : undefined)
    }
  }
  close(): Promise<void> {
    this.#closed = true
    this.#children.clear()
    for (const controller of this.#reconciling) controller.abort()
    return this.#store.close()
  }
}
