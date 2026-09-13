import { renderDelta, sliceDelta, type Cursor } from "../delta"
import { within } from "../async"
import { randomUUID } from "node:crypto"
import { redact } from "../log"
import type { ModelCatalog } from "../models"
import type { ReviewContext } from "../notes"
import { buildPassPrompt } from "../prompts"
import { executeAdvisorPass, type PassResult } from "./pass"
import { PendingReview } from "./recovery"
import { ContextBudgetExceeded, ReviewChild } from "./child"
import { shouldReview } from "./trigger"
import { committedResults } from "./commit-result"
import { reviewStore } from "./review-store"
import { restartRecovery } from "./restart"
import type { JournalLane } from "./journal"
import type { Lifetime } from "./lifetime"
import { LifetimeExpired } from "./lifetime"
import { TimeoutBackoff } from "./backoff"
import type { AdvisorRuntimeOptions, MessageResponse, ResolvedEntry } from "./runtime-types"

export type PreparedReview = Readonly<{
  catalog: ModelCatalog
  review?: ReviewContext
}>

/** A reviewer's cursor and uncertain request never block a different reviewer. */
export class ReviewLane {
  #cursor: Cursor = {}
  readonly #child: ReviewChild
  #running = false
  #pending: PendingReview | undefined
  #warnedNoModel = false
  #activePassID: string | undefined
  #retired = false
  readonly #journal: JournalLane | undefined
  #loaded = false
  #foreign = false
  #damaged = false
  #loadRetry = 0
  #phase = "preparing"
  readonly #backoff: TimeoutBackoff
  constructor(
    readonly root: string,
    readonly entry: ResolvedEntry,
    private readonly options: AdvisorRuntimeOptions,
    private readonly record: (result: PassResult, cost: number, count: number) => void,
    private readonly passIndex: () => number,
    private readonly changed: () => void = () => {},
    private readonly publish: (result: PassResult) => Promise<void> = async () => {},
  ) {
    this.#child = new ReviewChild(root, entry, options)
    this.#backoff = new TimeoutBackoff(options.config, options.clock)
    this.#journal = options.journal?.lane(root, entry.slug, { entry, config: options.config })
  }

  get busy(): boolean { return this.#running || this.#foreign || this.#damaged || this.#pending?.busy === true || this.#backoff.until !== undefined }
  get pinned(): boolean { return this.#running || (this.#pending?.busy === true &&
    (this.#journal === undefined || this.#pending.state !== "recovery_required")) }
  get status() {
    const child = this.#child.status
    return { root_session: this.root, advisor_slug: this.entry.slug, advisor_session: this.#child.id, ...child,
      state: this.#foreign ? "owned_elsewhere" : this.#damaged ? "recovery_required" : this.#running ? this.#phase : child.context_budget_exceeded ? "context_budget_exceeded" :
        this.#pending?.busy ? this.#pending.state : this.#backoff.until === undefined ? "idle" : "timeout_backoff",
      next_reconcile_at: this.#pending?.nextCheck, next_retry_at: this.#backoff.until }
  }
  async recover(force = false): Promise<void> {
    await this.#load(force)
    await this.#pending?.reconcile(force)
  }
  async retire(): Promise<void> {
    this.#retired = true; this.#activePassID = undefined; this.#child.retire()
    await this.#journal?.close().catch(async (error: unknown) => {
      await within(this.options.log.warn({ msg: "advisor lane release pending", error }),
        this.options.config.abort_grace_ms, this.options.timers).catch(() => {})
    })
  }
  async #load(force = false): Promise<void> {
    if (this.#loaded || this.#retired || this.#journal === undefined) return
    if (!force && this.options.clock() < this.#loadRetry) return
    this.#loadRetry = this.options.clock() + 1000
    try {
      if (!await this.#journal.load()) { this.#foreign = true; return }
    } catch (error) {
      this.#damaged = true
      this.#foreign = false
      this.changed()
      await within(this.options.log.warn({ msg: "advisor journal recovery required",
        watchedID: this.root, advisor: this.entry.slug, error }).catch(() => {}),
      this.options.config.abort_grace_ms, this.options.timers)
      return
    }
    if (this.#retired) return
    this.#foreign = false
    this.#damaged = false
    this.#loaded = true
    const state = this.#journal.data
    const compatible = this.#journal.compatible
    this.#cursor = compatible ? state.cursor : {}
    this.#child.restore(state.generation)
    const pending = state.pending
    if (pending !== null) {
      this.#activePassID = pending.id
      const finish = committedResults(async (result) => {
        if (this.#activePassID !== pending.id) return
        const advance = compatible && ["ok", "silent", "fallback", "quarantined"].includes(result.outcome)
        await this.#journal?.settle(pending.id, advance ? pending.next : undefined)
        if (advance) this.#cursor = pending.next
      }, this.options)
      const restored = await finish(restartRecovery(this.options, this.entry, this.root, pending))
      this.#pending = new PendingReview(restored, this.options, async (result) => {
        this.record(result, 0, 0)
        if (this.#activePassID === pending.id) this.#backoff.observe(pending.id, result)
        if (!this.#retired) await this.publish(result)
      }, this.changed)
    }
  }

  async ensureSession(): Promise<string> {
    return this.#child.ensure()
  }

  async run(messages: MessageResponse, originalRequest: string, latestRequest: string | undefined,
    prepare: () => Promise<PreparedReview>, lifetime: Lifetime,
    publish = this.publish): Promise<PassResult | undefined> {
    if (this.busy || this.#retired) return undefined
    const sliced = sliceDelta(messages, this.#cursor)
    if (sliced.delta.length === 0) return undefined
    if (!shouldReview(this.entry.when, sliced.delta, this.options.directory)) {
      await this.options.log.info({ msg: "advisor pass skipped", watchedID: this.root, advisor: this.entry.slug, reason: "no_trigger" })
      return undefined
    }
    this.#running = true
    this.#phase = "preparing"
    this.changed()
    const passID = randomUUID()
    this.#activePassID = passID
    const record = (result: PassResult, cost: number, count: number) => {
      this.record(result, cost, count)
      if (this.#activePassID === passID) this.#backoff.observe(passID, result)
    }
    try {
      const prepared = await lifetime.run(prepare)
      const objective = messages.find((message) => message.info.id === prepared.review?.task_id)
      if (objective !== undefined) originalRequest = objective.parts.filter((part) => part.type === "text").map((part) => part.text).join("\n")
      try { await lifetime.run(() => this.#child.prepare(prepared.catalog, prepared.review)) }
      catch (error) {
        if (!(error instanceof ContextBudgetExceeded)) throw error
        return { slug: this.entry.slug, outcome: "context_budget_exceeded", notes: [] }
      }
      const advisorSession = await lifetime.run(() => this.ensureSession())
      const promptInput = {
        originalRequest,
        ...(latestRequest === undefined ? {} : { latestRequest }),
        delta: renderDelta(sliced.delta, { maxChars: this.options.config.max_delta_chars, redact }),
        passIndex: this.passIndex(),
        ...(this.entry.rosterInstructions === undefined ? {} : { rosterInstructions: this.entry.rosterInstructions }),
        ...(this.entry.watchdogMd === undefined ? {} : { watchdogMd: this.entry.watchdogMd }),
        ...(this.entry.instructions === undefined ? {} : { entryInstructions: this.entry.instructions }),
      }
      const continuation = buildPassPrompt({ ...promptInput, isFirstPass: false })
      if (continuation === null) return undefined
      let cost = 0
      let recordedCost = 0
      const prompted = new Set<string>()
      const finish = committedResults(async (completed) => {
        if (this.#activePassID !== passID) return
        const advance = ["ok", "silent", "fallback", "quarantined"].includes(completed.outcome)
        await this.#journal?.settle(passID, advance ? sliced.next : undefined)
        if (advance) {
          this.#cursor = sliced.next
          this.#warnedNoModel = false
          this.#child.complete(completed, prompted)
        }
      }, this.options)
      const result = await finish(await executeAdvisorPass({
        config: this.options.config, entry: this.entry, catalog: prepared.catalog,
        cooldowns: this.options.cooldowns, log: this.options.log,
        store: reviewStore(this.options.store, prepared.review, (record) => { cost += record.cost }),
        client: { prompt: this.options.client.session.prompt, abort: this.options.client.session.abort,
          messages: this.options.client.session.messages },
        directory: this.options.directory, watchedID: this.root, advisorSession,
        prompt: (sessionID) => {
          prompted.add(sessionID)
          return this.#child.primed ? continuation :
            buildPassPrompt({ ...promptInput, ...this.#child.material, isFirstPass: true }) ?? continuation
        },
        clock: this.options.clock, timers: this.options.timers, lifetime,
        passID,
        onPhase: (phase) => { this.#phase = phase; this.changed() },
        ...(this.#journal === undefined ? {} : { beforeDispatch: async (child, model, agent, started_at) => {
          await this.#journal?.begin({ id: passID, child, model: `${model.long}${model.effort === undefined && model.variant === undefined ? "" : `:${model.effort ?? model.variant}`}`,
            agent, started_at, next: sliced.next, ...(prepared.review === undefined ? {} : { review: prepared.review }) },
          this.#child.status.generation)
        } }),
        ...(this.options.usage === undefined ? {} : { usage: this.options.usage }),
        ...(this.options.admission === undefined ? {} : { admission: this.options.admission }),
        ...(this.options.upstream === undefined ? {} : { upstream: this.options.upstream }),
        acceptResult: () => !this.#retired,
        refreshSession: () => this.#child.refresh(prepared.review),
        onWarning: async (slug, message) => {
          if (message.startsWith("No advisor model")) {
            if (this.#warnedNoModel) return
            this.#warnedNoModel = true
          }
          await this.options.onWarning(slug, message)
        },
      }))
      record(result, cost, 1)
      recordedCost = cost
      if (result.pending !== undefined || result.reconcile !== undefined) this.#pending = new PendingReview(result, this.options, async (late) => {
        record(late, cost - recordedCost, 0)
        recordedCost = cost
        if (!this.#retired) await publish(late)
      }, this.changed)
      return result
    } catch (error) {
      if (!(error instanceof LifetimeExpired)) throw error
      const result: PassResult = { slug: this.entry.slug, outcome: "timeout", notes: [], cancellation: "not_sent" }
      record(result, 0, 1)
      return result
    } finally {
      this.#running = false
    }
  }
}
