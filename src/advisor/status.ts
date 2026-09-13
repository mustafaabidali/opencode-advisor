import { within } from "../async"
import type { StateSnapshot } from "../notes"
import type { ModelCatalog } from "../models"
import { withUsage } from "../usage/status"
import { buildSnapshot, type AdvisorStats } from "./snapshot"
import type { AdvisorRuntimeOptions } from "./runtime-types"

export class RuntimeStatus {
  #key = ""
  #catalog: ModelCatalog = new Map()
  #writing: Promise<void> | undefined
  #again = false
  #closed = false
  constructor(private readonly options: AdvisorRuntimeOptions, private readonly stats: ReadonlyMap<string, AdvisorStats>,
    private readonly current: () => Pick<StateSnapshot, "watched_sessions" | "execution">) {}
  catalog(catalog: ModelCatalog): void { this.#catalog = catalog }
  close(): void { this.#closed = true }
  async write(): Promise<void> {
    if (this.#closed) return
    this.#again = true
    const writing = this.#writing ??= this.#drain().finally(() => { this.#writing = undefined })
    await within(writing, this.options.config.abort_grace_ms, this.options.timers)
  }
  async #drain(): Promise<void> {
    while (this.#again && !this.#closed) {
      this.#again = false
      try {
        const usage = await this.options.usage?.summary()
        const current = this.current()
        let snapshot: StateSnapshot = {
          ...buildSnapshot({ roster: this.options.roster, stats: this.stats, cooldowns: this.options.cooldowns,
            catalog: this.#catalog, watched: current.watched_sessions, now: this.options.clock() }),
          ...current,
          ...(this.options.identity === undefined ? {} : { build: this.options.identity }),
          ...(this.options.history === undefined ? {} : { metrics: this.options.history.metrics }),
        }
        if (usage !== undefined) snapshot = withUsage(snapshot, usage)
        const key = JSON.stringify({ ...snapshot, updated_at: undefined, metrics: undefined,
          advisors: snapshot.advisors.map((advisor) => ({ ...advisor, last_pass_at: advisor.passes === 0 ? null : advisor.last_pass_at })) })
        if (key === this.#key || this.#closed) continue
        await this.options.store.writeState(this.options.directory, snapshot)
        this.#key = key
      } catch (error) { await this.options.log.warn({ msg: "advisor status write failed", error }) }
    }
  }
}
