import { join } from "node:path"
import type { Config, Message, Part } from "@opencode-ai/sdk"
import type { AdvisorConfig } from "../config"
import { renderDelta, sliceDelta, type Cursor, type TranscriptMessage } from "../delta"
import { redact, type Logger } from "../log"
import { displayName, type CooldownRegistry, type ModelCatalog } from "../models"
import type { NoteStore, StateSnapshot, TranscriptOutcome } from "../notes"
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
}>
export type RunPassContext = Readonly<{ firstUserText?: string }>
type AdvisorStats = { passes: number; notes: number; cost: number; lastPassAt: string; lastOutcome: TranscriptOutcome }
const EMPTY_CURSOR = {} as const satisfies Cursor
export class AdvisorRuntime {
  readonly #sessions = new Map<string, string>(); readonly #cursors = new Map<string, Cursor>()
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
    const catalog = await this.#catalog()
    const files = await this.#projectFiles()
    const originalRequest = context.firstUserText ?? this.#firstUserText(messages)
    const latestRequest = this.#latestUserText(messages)
    const settled = await Promise.allSettled(
      this.options.roster.filter(({ enabled }) => enabled).map((entry) =>
        this.#runEntry(watchedID, entry, messages, originalRequest, latestRequest, catalog, files)),
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
    files: Readonly<{ agentsMd?: string; contextMd?: string }>): Promise<PassResult | undefined> {
    const key = this.#key(watchedID, entry.slug)
    if (this.#inFlight.has(key)) return undefined
    const sliced = sliceDelta(messages satisfies readonly TranscriptMessage[], this.#cursors.get(key) ?? EMPTY_CURSOR)
    const delta = renderDelta(sliced.delta, { maxChars: this.options.config.max_delta_chars, redact })
    const stats = this.#stats.get(entry.slug)
    const prompt = buildPassPrompt({
      originalRequest,
      ...(latestRequest === undefined ? {} : { latestRequest }),
      delta,
      passIndex: (stats?.passes ?? 0) + 1,
      isFirstPass: stats === undefined,
      ...(entry.rosterInstructions === undefined ? {} : { rosterInstructions: entry.rosterInstructions }),
      ...(entry.watchdogMd === undefined ? {} : { watchdogMd: entry.watchdogMd }),
      ...(entry.instructions === undefined ? {} : { entryInstructions: entry.instructions }),
      ...files,
    })
    if (prompt === null) return undefined
    this.#inFlight.add(key)
    try {
      const advisorSession = await this.ensureSession(watchedID, entry)
      let passCost = 0
      const store = this.options.store
      const result = await executeAdvisorPass({
        config: this.options.config,
        entry,
        catalog,
        cooldowns: this.options.cooldowns,
        store: {
          writeNote: (note) => store.writeNote(note),
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
        prompt,
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
  async #projectFiles(): Promise<Readonly<{ agentsMd?: string; contextMd?: string }>> {
    const read = async (name: string): Promise<string | undefined> => {
      try {
        return await this.options.readFile(join(this.options.directory, name))
      } catch (error) {
        await this.options.log.debug({ msg: "advisor context file unavailable", name, error })
        return undefined
      }
    }
    const [agentsMd, contextMd] = await Promise.all([read("AGENTS.md"), read("CONTEXT.md")])
    return {
      ...(agentsMd === undefined ? {} : { agentsMd }),
      ...(contextMd === undefined ? {} : { contextMd }),
    }
  }
  #firstUserText(messages: MessageResponse): string {
    const first = messages.find(({ info }) => info.role === "user"); return first?.parts.filter((part) => part.type === "text").map((part) => part.text).join("\n") ?? ""
  }
  #latestUserText(messages: MessageResponse): string | undefined {
    const latest = messages.findLast(({ info }) => info.role === "user" && info.agent !== DELIVERY_AGENT_ID && !info.id.startsWith("adv_")); return latest?.parts.filter((part) => part.type === "text").map((part) => part.text).join("\n")
  }
  #snapshot(catalog: ModelCatalog): StateSnapshot {
    return {
      advisors: this.options.roster.map((entry) => {
        const stats = this.#stats.get(entry.slug)
        const cooledUntil = this.options.cooldowns.cooledUntil(entry.model.long)
        return {
          slug: entry.slug,
          roster_name: entry.name,
          model: entry.model.long,
          model_display: displayName(entry.model, catalog),
          variant: entry.model.variant ?? "default",
          ...(entry.fallback === undefined ? {} : { fallback: entry.fallback.long }),
          tools: entry.tools,
          enabled: entry.enabled,
          ...(cooledUntil === undefined ? {} : { cooled_until: new Date(cooledUntil).toISOString() }),
          passes: stats?.passes ?? 0,
          notes: stats?.notes ?? 0,
          cost: stats?.cost ?? 0,
          last_pass_at: stats?.lastPassAt ?? new Date(this.options.clock()).toISOString(),
          last_outcome: stats?.lastOutcome ?? "silent",
        }
      }),
      watched_sessions: [...this.#watched],
      updated_at: new Date(this.options.clock()).toISOString(),
    }
  }
  #key(watchedID: string, slug: string): string {
    return `${watchedID}\u0000${slug}`
  }
}
