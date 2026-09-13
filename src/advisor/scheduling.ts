import { PassScheduler, type PassReason } from "../watcher/scheduler"
import type { AdvisorRuntimeOptions, RunPassContext } from "./runtime-types"
import type { PassResult } from "./pass"

type Request = Readonly<{ root: string; slug: string; context: RunPassContext }>
export class ReviewScheduler {
  readonly #requests = new Map<string, Request>()
  readonly #scheduler: PassScheduler<unknown>
  constructor(
    private readonly options: AdvisorRuntimeOptions,
    run: (root: string, reason: PassReason, context: RunPassContext) => Promise<PassResult[]>,
  ) {
    this.#scheduler = new PassScheduler({
      config: { ...options.config, pass_debounce_ms: 0 },
      log: options.log, clock: options.clock, timers: options.timers, respectIdleCooldown: true,
      onPass: async (key, reason) => {
        const request = this.#requests.get(key)
        if (request === undefined) return false
        const { root, slug, context } = request
        const results = await run(root, reason, {
          ...context, advisorSlug: slug, detached: true,
        })
        return results.length > 0
      },
    })
  }
  pending(root: string): boolean {
    return [...this.#requests.entries()].some(([key, request]) => request.root === root && this.#scheduler.pending(key))
  }
  notify(root: string, reason: PassReason, context: RunPassContext): void {
    for (const entry of this.options.roster) {
      if (!entry.enabled || (context.advisorSlug !== undefined && entry.slug !== context.advisorSlug)) continue
      const key = `${root}\u0000${entry.slug}`
      this.#requests.set(key, { root, slug: entry.slug, context })
      this.#scheduler.trigger(key, reason)
    }
  }
  forget(root: string): void {
    for (const [key, request] of this.#requests) {
      if (request.root !== root) continue
      this.#scheduler.forget(key)
      this.#requests.delete(key)
    }
  }
  dispose(): void {
    for (const key of this.#requests.keys()) this.#scheduler.forget(key)
    this.#requests.clear()
  }
}
