import type { Config, Message, Part } from "@opencode-ai/sdk"
import type { AdvisorConfig } from "../config"
import { renderDelta, sliceDelta, type Cursor, type TranscriptMessage } from "../delta"
import { redact, type Logger } from "../log"
import type { CooldownRegistry, ModelCatalog } from "../models"
import type { NoteStore, ReviewContext, StateSnapshot } from "../notes"
import { ADVISOR_SYSTEM_PROMPT, buildPassPrompt } from "../prompts"
import {
  DELIVERY_AGENT_ID,
  deliveryAgentConfig,
  toAgentConfig,
  toFallbackAgentConfig,
  type AdvisorEntry,
} from "../roster"
import {
  AdvisorCallError,
  executeAdvisorPass,
  type AdvisorStore,
  type ApiResult,
  type AdvisorTimers,
  type PassResult,
  type PromptCall,
  type PromptResponse,
} from "./pass"
import { buildSnapshot, type AdvisorStats } from "./snapshot"
import { shouldReview } from "./trigger"
import { readProjectFiles } from "./files"
export type ResolvedEntry = AdvisorEntry & Readonly<{ rosterInstructions?: string; watchdogMd?: string }>; type MessageResponse = readonly Readonly<{ info: Message; parts: readonly Part[] }>[]
export type AdvisorClient = Readonly<{
  session: Readonly<{
    create: (call: Readonly<{ query: Readonly<{ directory: string }>; body: Readonly<{ parentID: string; title: string }> }>) => Promise<ApiResult<Readonly<{ id: string }>>>
    messages: (call: Readonly<{ path: Readonly<{ id: string }>; query: Readonly<{ directory: string }> }>) => Promise<ApiResult<MessageResponse>>
    prompt: (call: PromptCall) => Promise<ApiResult<PromptResponse>>; abort: (call: Readonly<{ path: Readonly<{ id: string }> }>) => Promise<ApiResult<boolean>>
  }>
}>
export type AdvisorRuntimeOptions = Readonly<{
  config: AdvisorConfig; roster: readonly ResolvedEntry[]; catalog: ModelCatalog | (() => Promise<ModelCatalog>)
  cooldowns: CooldownRegistry; store: AdvisorStore | NoteStore
  log: Logger; client: AdvisorClient
  directory: string; clock: () => number; timers: AdvisorTimers
  readFile: (path: string) => Promise<string>; onAdvisorSession: (id: string) => void; onWarning: (advisorSlug: string, message: string) => void | Promise<void>
  captureReview?: (sessionID: string, messages: readonly TranscriptMessage[]) => Promise<ReviewContext>
}>
export type RunPassContext = Readonly<{
  firstUserText?: string
  onResult?: (result: PassResult) => void | Promise<void>
}>
const EMPTY_CURSOR = {} as const satisfies Cursor
export class AdvisorRuntime {
  readonly #sessions = new Map<string, string>(); readonly #cursors = new Map<string, Cursor>(); readonly #primed = new Set<string>()
  readonly #inFlight = new Set<string>(); readonly #warnedNoModel = new Set<string>()
  readonly #watched = new Set<string>(); readonly #stats = new Map<string, AdvisorStats>(); #catalogPromise?: Promise<ModelCatalog>; constructor(private readonly options: AdvisorRuntimeOptions) {}
  async registerAgents(cfg: Config): Promise<void> {
    cfg.agent ??= {}
    for (const entry of this.options.roster.filter(({ enabled }) => enabled)) {
      await this.#register(cfg, entry.agentId, toAgentConfig(entry, ADVISOR_SYSTEM_PROMPT))
      const fallback = toFallbackAgentConfig(entry, ADVISOR_SYSTEM_PROMPT)
      if (fallback !== undefined) await this.#register(cfg, `${entry.agentId}-fb`, fallback)
    }
    await this.#register(cfg, DELIVERY_AGENT_ID, deliveryAgentConfig())
  }
  async #register(cfg: Config, key: string, value: NonNullable<Config["agent"]>[string]): Promise<void> {
    if (cfg.agent?.[key] !== undefined) {
      await this.options.log.warn({ msg: "advisor agent registration skipped existing key", agent: key }); return
    }
    if (value !== undefined && cfg.agent !== undefined) cfg.agent[key] = value
  }
  async ensureSession(watchedID: string, entry: AdvisorEntry): Promise<string> {
    const key = this.#key(watchedID, entry.slug)
    const cached = this.#sessions.get(key)
    if (cached !== undefined) return cached
    const result = await this.options.client.session.create({
      query: { directory: this.options.directory },
      body: { parentID: watchedID, title: `advisor:${entry.slug}` },
    })
    if (result.error !== undefined || result.data === undefined || (result.response?.status ?? 200) >= 400) {
      throw new AdvisorCallError("advisor session creation failed", result.response?.status, result.error)
    }
    this.#sessions.set(key, result.data.id)
    this.options.onAdvisorSession(result.data.id)
    return result.data.id
  }
  async runPass(watchedID: string, _reason: "step" | "idle", context: RunPassContext = {}): Promise<PassResult[]> {
    let messages: MessageResponse
    try {
      const response = await this.options.client.session.messages({
        path: { id: watchedID },
        query: { directory: this.options.directory },
      })
      if (response.error !== undefined || response.data === undefined || (response.response?.status ?? 200) >= 400) {
        throw new AdvisorCallError("watched session messages failed", response.response?.status, response.error)
      }
      messages = response.data
    } catch (error) {
      await this.options.log.error({ msg: "advisor pass could not fetch messages", watchedID, error })
      return []
    }
    this.#watched.add(watchedID)
    const review = await this.options.captureReview?.(watchedID, messages)
    const catalog = await this.#catalog()
    const files = await readProjectFiles(this.options.directory, this.options.readFile, this.options.log)
    const originalRequest = context.firstUserText ?? this.#firstUserText(messages)
    const latestRequest = this.#latestUserText(messages)
    const settled = await Promise.allSettled(
      this.options.roster.filter(({ enabled }) => enabled).map(async (entry) => {
        const result = await this.#runEntry(watchedID, entry, messages, originalRequest, latestRequest, catalog, files, review)
        if (result !== undefined) {
          try { await context.onResult?.(result) } catch (error) {
            await this.options.log.warn({ msg: "advisor result delivery failed", watchedID, advisor: entry.slug, error })
          }
        }
        return result
      }),
    )
    const results: PassResult[] = []
    for (const result of settled) {
      if (result.status === "fulfilled") {
        if (result.value !== undefined) results.push(result.value)
      } else {
        await this.options.log.error({ msg: "advisor pass failed unexpectedly", watchedID, error: result.reason })
      }
    }
    await this.options.store.writeState(this.options.directory, this.#snapshot(catalog))
    return results
  }
  async #runEntry(watchedID: string, entry: ResolvedEntry, messages: MessageResponse,
    originalRequest: string, latestRequest: string | undefined, catalog: ModelCatalog,
    files: Readonly<{ agentsMd?: string; contextMd?: string }>, review?: ReviewContext): Promise<PassResult | undefined> {
    const key = this.#key(watchedID, entry.slug)
    if (this.#inFlight.has(key)) return undefined
    const sliced = sliceDelta(messages satisfies readonly TranscriptMessage[], this.#cursors.get(key) ?? EMPTY_CURSOR)
    if (sliced.delta.length > 0 && !shouldReview(entry.when, sliced.delta, this.options.directory)) {
      await this.options.log.info({ msg: "advisor pass skipped", watchedID, advisor: entry.slug, reason: "no_trigger" })
      return undefined
    }
    const delta = renderDelta(sliced.delta, { maxChars: this.options.config.max_delta_chars, redact })
    const stats = this.#stats.get(entry.slug)
    const promptInput = {
      originalRequest,
      ...(latestRequest === undefined ? {} : { latestRequest }),
      delta,
      passIndex: (stats?.passes ?? 0) + 1,
      ...(entry.rosterInstructions === undefined ? {} : { rosterInstructions: entry.rosterInstructions }),
      ...(entry.watchdogMd === undefined ? {} : { watchdogMd: entry.watchdogMd }),
      ...(entry.instructions === undefined ? {} : { entryInstructions: entry.instructions }),
      ...files,
    }
    const primingPrompt = buildPassPrompt({ ...promptInput, isFirstPass: true })
    const continuationPrompt = buildPassPrompt({ ...promptInput, isFirstPass: false })
    if (primingPrompt === null || continuationPrompt === null) return undefined
    this.#inFlight.add(key)
    try {
      const advisorSession = await this.ensureSession(watchedID, entry)
      let passCost = 0
      const store = this.options.store
      const prompted = new Set<string>()
      const result = await executeAdvisorPass({
        config: this.options.config,
        entry,
        catalog,
        cooldowns: this.options.cooldowns,
        store: {
          writeNote: (note) => store.writeNote({ ...note, ...(review === undefined ? {} : { review }) }),
          appendTranscript: async (root, record) => { passCost += record.cost; await store.appendTranscript(root, record) },
          writeState: (cwd, snapshot) => store.writeState(cwd, snapshot) },
        log: this.options.log,
        client: {
          prompt: this.options.client.session.prompt,
          abort: this.options.client.session.abort,
        },
        directory: this.options.directory,
        watchedID,
        advisorSession,
        prompt: (sessionID) => { prompted.add(sessionID); return this.#primed.has(sessionID) ? continuationPrompt : primingPrompt },
        clock: this.options.clock,
        timers: this.options.timers,
        refreshSession: async () => {
          this.#sessions.delete(key)
          return this.ensureSession(watchedID, entry)
        },
        onWarning: (slug, message) => this.#warning(watchedID, slug, message),
      })
      if (["ok", "silent", "fallback", "quarantined"].includes(result.outcome)) {
        this.#cursors.set(key, sliced.next)
        this.#warnedNoModel.delete(key)
        for (const sessionID of prompted) this.#primed.add(sessionID)
      }
      this.#recordStats(entry.slug, result, passCost)
      return result
    } finally {
      this.#inFlight.delete(key)
    }
  }
  async #warning(watchedID: string, slug: string, message: string): Promise<void> {
    const key = this.#key(watchedID, slug)
    if (message.startsWith("No advisor model")) {
      if (this.#warnedNoModel.has(key)) return
      this.#warnedNoModel.add(key)
    }
    await this.options.onWarning(slug, message)
  }
  #recordStats(slug: string, result: PassResult, passCost: number): void {
    const previous = this.#stats.get(slug)
    this.#stats.set(slug, {
      passes: (previous?.passes ?? 0) + 1,
      notes: (previous?.notes ?? 0) + result.notes.length,
      cost: (previous?.cost ?? 0) + passCost,
      lastPassAt: new Date(this.options.clock()).toISOString(),
      lastOutcome: result.outcome,
    })
  }
  async #catalog(): Promise<ModelCatalog> {
    if (typeof this.options.catalog !== "function") return this.options.catalog
    this.#catalogPromise ??= this.options.catalog()
    return this.#catalogPromise
  }
  #firstUserText(messages: MessageResponse): string {
    const first = messages.find(({ info }) => info.role === "user"); return first?.parts.filter((part) => part.type === "text").map((part) => part.text).join("\n") ?? ""
  }
  #latestUserText(messages: MessageResponse): string | undefined {
    const latest = messages.findLast(({ info }) => info.role === "user" && info.agent !== DELIVERY_AGENT_ID && !info.id.startsWith("adv_")); return latest?.parts.filter((part) => part.type === "text").map((part) => part.text).join("\n")
  }
  #snapshot(catalog: ModelCatalog): StateSnapshot {
    return buildSnapshot({ roster: this.options.roster, stats: this.#stats, cooldowns: this.options.cooldowns, catalog, watched: this.#watched, now: this.options.clock() })
  }
  #key(watchedID: string, slug: string): string {
    return `${watchedID}\u0000${slug}`
  }
}
