import type { Config, Event } from "@opencode-ai/sdk"
import type { ModelCatalog } from "../models"
import { DELIVERY_AGENT_ID, type AdvisorEntry } from "../roster"
import { AdvisorCallError, type PassResult } from "./pass"
import { recordStats, type AdvisorStats } from "./snapshot"
import { Lifetime, LifetimeExpired } from "./lifetime"
import { within } from "../async"
import { ReviewLane, type PreparedReview } from "./lane"
import { ReviewScheduler } from "./scheduling"
import { ProviderAdmission } from "./admission"
import { UpstreamFailures } from "./upstream"
import { RuntimeStatus } from "./status"
import { registerAgents } from "./registration"
import { resumedNotes } from "./resume"
import type { AdvisorRuntimeOptions, MessageResponse, ResolvedEntry, RunPassContext } from "./runtime-types"
export type { AdvisorClient, AdvisorRuntimeOptions, ResolvedEntry, RunPassContext } from "./runtime-types"

export class AdvisorRuntime {
  readonly #lanes = new Map<string, ReviewLane>()
  readonly #watched = new Set<string>()
  readonly #stats = new Map<string, AdvisorStats>()
  readonly #lifetimes = new Map<Lifetime, string>()
  readonly #running = new Set<Promise<PassResult[]>>()
  readonly #contexts = new Map<string, RunPassContext>()
  readonly #paused = new Set<string>()
  readonly #epochs = new Map<string, symbol>()
  readonly #deliveries = new Set<Promise<void>>()
  readonly #status: RuntimeStatus
  #catalogLoading: Promise<ModelCatalog> | undefined
  #disposed = false
  readonly #scheduler: ReviewScheduler
  constructor(private readonly options: AdvisorRuntimeOptions) {
    this.options = { ...options, admission: options.admission ?? new ProviderAdmission(options.config.max_concurrent_passes_per_provider),
      upstream: options.upstream ?? new UpstreamFailures(options.config.content_filter_patterns) }
    this.#scheduler = new ReviewScheduler(options, (root, reason, context) => this.runPass(root, reason, context))
    this.#status = new RuntimeStatus(this.options, this.#stats, () => ({
      watched_sessions: [...this.#watched], execution: [...this.#lanes.values()].map((lane) => lane.status),
    }))
  }

  notify(root: string, reason: "step" | "idle", context: RunPassContext = {}): void {
    if (this.#disposed) return
    context = this.#scope(root, context)
    if (!this.#disposed && !this.#paused.has(root)) this.#scheduler.notify(root, reason, context)
  }
  observe(event: Event): void { if (!this.#disposed) this.options.upstream?.observe(event) }
  start(): Promise<void> { return this.#status.write() }

  registerAgents(cfg: Config): Promise<void> { return registerAgents(cfg, this.options) }
  ensureSession(watchedID: string, entry: AdvisorEntry): Promise<string> {
    return this.#lane(watchedID, entry).ensureSession()
  }

  runPass(watchedID: string, _reason: "step" | "idle", context: RunPassContext = {}): Promise<PassResult[]> {
    if (this.#disposed || this.#paused.has(watchedID)) return Promise.resolve([])
    context = this.#scope(watchedID, context)
    const work = this.#run(watchedID, context)
    this.#running.add(work)
    void work.finally(() => this.#running.delete(work)).catch(() => {})
    return work
  }
  async dispose(): Promise<void> {
    this.#disposed = true
    this.#scheduler.dispose()
    this.#status.close()
    const retiring = [...this.#lanes.values()].map((lane) => lane.retire())
    for (const lifetime of this.#lifetimes.keys()) lifetime.cancel()
    await within(Promise.allSettled([...this.#running, ...this.#deliveries, ...retiring]), this.options.config.abort_grace_ms * 2, this.options.timers)
    this.#lanes.clear()
    this.#contexts.clear()
    this.#watched.clear()
    this.#paused.clear()
    this.#epochs.clear()
  }
  #scope(root: string, context: RunPassContext): RunPassContext {
    const epoch = this.#epochs.get(root) ?? Symbol(root)
    this.#epochs.set(root, epoch)
    const scoped = { ...this.#contexts.get(root), ...context, epoch }
    const { advisorSlug, detached, ...rootContext } = scoped
    this.#contexts.set(root, rootContext)
    return scoped
  }
  get metrics() { return { lanes: this.#lanes.size, roots: this.#watched.size, active: this.#lifetimes.size,
    deliveries: this.#deliveries.size } }
  isPinned(root: string): boolean {
    return this.#scheduler.pending(root) || [...this.#lifetimes.values()].includes(root) ||
      [...this.#lanes.values()].some((lane) => lane.root === root && lane.pinned)
  }
  pause(root: string): void {
    if (this.#disposed) return
    this.#paused.add(root)
    this.#scheduler.forget(root)
  }
  async resume(root: string): Promise<void> {
    if (this.#disposed) return
    this.#paused.delete(root)
    const context = this.#scope(root, this.#contexts.get(root) ?? {})
    const notes = await resumedNotes(this.options.store, this.options.directory, root)
    if (this.#disposed || context.epoch !== this.#epochs.get(root)) return
    await this.#emit(root, { slug: "resumed", outcome: "ok", notes }, context)
    this.notify(root, "idle", context)
  }
  forget(root: string): void {
    this.#scheduler.forget(root)
    for (const [key, lane] of this.#lanes) if (lane.root === root) {
      void lane.retire()
      this.#lanes.delete(key)
    }
    for (const [lifetime, id] of this.#lifetimes) if (id === root) lifetime.cancel()
    this.#contexts.delete(root)
    this.#watched.delete(root)
    this.#paused.delete(root)
    this.#epochs.delete(root)
    this.options.history?.forget(root)
  }
  async #run(watchedID: string, context: RunPassContext): Promise<PassResult[]> {
    const selected = this.options.roster.filter((entry) => entry.enabled &&
      (context.advisorSlug === undefined || entry.slug === context.advisorSlug))
    if (selected.length > 1 && this.options.config.max_concurrent_passes_per_provider > 0) {
      const results = await Promise.all(selected.map((entry) => this.runPass(watchedID, "idle", { ...context, advisorSlug: entry.slug })))
      return results.flat()
    }
    const lifetime = new Lifetime(this.options.config.pass_timeout_ms,
      this.options.monotonicClock ?? this.options.clock, this.options.timers)
    this.#lifetimes.set(lifetime, watchedID)
    try {
      if (!this.#watched.has(watchedID) && this.options.store.readTask !== undefined) {
        const task = await lifetime.run(() => this.options.store.readTask?.(this.options.directory, watchedID) ?? Promise.resolve(undefined))
        if (task?.stopped) { this.pause(watchedID); return [] }
      }
      for (const entry of selected) {
        if (this.#disposed || this.#paused.has(watchedID) || context.epoch !== this.#epochs.get(watchedID)) return []
        await lifetime.run(() => this.#lane(watchedID, entry).recover())
      }
      if (this.#disposed || this.#paused.has(watchedID) || context.epoch !== this.#epochs.get(watchedID)) return []
      if (selected.every((entry) => this.#lane(watchedID, entry).busy)) { await this.#status.write(); return [] }
      return await this.#perform(watchedID, selected, context, lifetime)
    } catch (error) {
      if (!(error instanceof LifetimeExpired)) throw error
      this.options.history?.forget(watchedID)
      return selected.map((entry) => ({ slug: entry.slug, outcome: "timeout", notes: [], cancellation: "not_sent" }))
    } finally {
      lifetime.close()
      this.#lifetimes.delete(lifetime)
    }
  }
  async #perform(root: string, entries: readonly ResolvedEntry[], context: RunPassContext,
    lifetime: Lifetime): Promise<PassResult[]> {
    let messages: MessageResponse
    try {
      const history = this.options.history
      const response = history === undefined ? await lifetime.run(() => this.options.client.session.messages({
        path: { id: root }, query: { directory: this.options.directory },
      })) : { data: await lifetime.run(() => history.read(root)), error: undefined, response: { status: 200 } }
      if (response.error !== undefined || response.data === undefined || (response.response?.status ?? 200) >= 400) {
        throw new AdvisorCallError("watched session messages failed", response.response?.status, response.error)
      }
      messages = response.data
    } catch (error) {
      if (error instanceof LifetimeExpired) throw error
      await this.options.log.error({ msg: "advisor pass could not fetch messages", watchedID: root, error })
      return []
    }
    if (lifetime.invalidated) throw new LifetimeExpired("cancelled")
    this.#watched.add(root)
    let preparing: Promise<PreparedReview> | undefined
    const prepare = () => preparing ??= (async () => {
      const [catalog, review] = await Promise.all([
        this.#catalog(),
        this.options.captureReview?.(root, messages),
      ])
      let content: Promise<string | undefined> | undefined
      return { catalog, ...(review === undefined ? {} : { review }),
        captureContent: () => content ??= Promise.resolve().then(() => this.options.captureContent?.(messages))
          .then((digest) => digest === undefined ? undefined : JSON.stringify([review?.task_id, users.at(-1)?.info.id, digest]))
          .catch(() => undefined) }
    })()
    const users = messages.filter(({ info }) => info.role === "user" &&
      info.agent !== DELIVERY_AGENT_ID && !info.id.startsWith("adv_"))
    const text = (message: MessageResponse[number] | undefined) =>
      message?.parts.filter((part) => part.type === "text").map((part) => part.text).join("\n")
    const original = context.firstUserText ?? text(users[0]) ?? ""
    const latest = text(users.at(-1))
    const settled = await Promise.allSettled(entries.map(async (entry) => {
      let result: PassResult | undefined
      try {
        result = await this.#lane(root, entry).run(messages, original, latest, prepare, lifetime,
          (result) => this.#emit(root, result, context))
      } catch (error) {
        if (!(error instanceof LifetimeExpired)) throw error
        result = { slug: entry.slug, outcome: "timeout", notes: [], cancellation: "not_sent" }
      }
      if (result !== undefined && !this.#disposed) await this.#emit(root, result, context)
      return result
    }))
    const results: PassResult[] = []
    for (const result of settled) {
      if (result.status === "fulfilled") {
        if (result.value !== undefined) results.push(result.value)
      } else await this.options.log.error({ msg: "advisor pass failed unexpectedly", watchedID: root, error: result.reason })
    }
    await this.#status.write()
    return results
  }
  async #emit(root: string, result: PassResult, context: RunPassContext): Promise<void> {
    if (this.#disposed || context.epoch !== this.#epochs.get(root)) return
    const deliver = (async () => {
      if (this.#paused.has(root)) return
      const handler = context.onResult ?? ((result: PassResult) => this.options.onResult?.(root, result))
      try { await handler(result) } catch (error) {
        await this.options.log.warn({ msg: "advisor result delivery failed", watchedID: root, advisor: result.slug, error })
      }
    })()
    this.#deliveries.add(deliver)
    void deliver.finally(() => this.#deliveries.delete(deliver)).catch(() => {})
    if (!context.detached) await deliver
  }
  async recover(root: string): Promise<void> {
    for (const lane of this.#lanes.values()) if (lane.root === root) {
      await lane.recover(true)
    }
    await this.#status.write()
  }
  #lane(root: string, entry: ResolvedEntry): ReviewLane {
    const key = `${root}\u0000${entry.slug}`
    let lane = this.#lanes.get(key)
    if (lane === undefined) {
      lane = new ReviewLane(root, entry, this.options,
        (result, cost, count) => recordStats(this.#stats, entry.slug, result, cost, count, this.options.clock()),
        () => (this.#stats.get(entry.slug)?.passes ?? 0) + 1, () => { void this.#status.write() },
        (result) => this.#emit(root, result, this.#contexts.get(root) ?? {}))
      this.#lanes.set(key, lane)
    }
    return lane
  }
  async #catalog(): Promise<ModelCatalog> {
    if (typeof this.options.catalog !== "function") { this.#status.catalog(this.options.catalog); return this.options.catalog }
    const loading = this.#catalogLoading ??= this.options.catalog()
    try { const catalog = await loading; this.#status.catalog(catalog); return catalog } finally {
      if (this.#catalogLoading === loading) this.#catalogLoading = undefined
    }
  }
}
