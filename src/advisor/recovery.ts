import { within } from "../async"
import type { AdvisorRuntimeOptions } from "./runtime-types"
import type { PassResult } from "./pass-types"

/** Reconcile evidence of termination, never infer it from elapsed time. */
export class PendingReview {
  #result: PassResult
  #phase: "blocked" | "released" | "settled"
  #checks = 0
  #next: number
  #checking: Promise<PassResult | undefined> | undefined
  constructor(result: PassResult, private readonly options: AdvisorRuntimeOptions,
    private readonly complete: (result: PassResult) => void | Promise<void>,
    private readonly changed: () => void = () => {}) {
    this.#result = result
    this.#phase = result.cancellation === "cancellation_uncertain" || result.persistence !== undefined ? "blocked" : "released"
    this.#next = options.clock() + this.#backoff()
    this.#watch(result)
  }
  #backoff(): number { return Math.max(1000, this.options.config.cooldown_ms) * 2 ** this.#checks }
  get busy(): boolean { return this.#phase === "blocked" }
  get state(): string {
    if (!this.busy) return "idle"
    if (this.#checks >= 3 || this.#result.persistence === "recovery_required") return "recovery_required"
    return this.#result.persistence === undefined ? "cancellation_uncertain" : "persistence_pending"
  }
  get nextCheck(): number | undefined { return this.busy && this.#checks < 3 ? this.#next : undefined }
  #watch(result: PassResult): void {
    if (result.pending !== undefined) void result.pending.then(async (late) => {
      if (late !== undefined) await this.#accept(late)
    }).catch((error: unknown) => this.options.log.warn({ msg: "advisor pending result unavailable", advisor: result.slug, error }))
  }
  async #accept(result: PassResult): Promise<void> {
    if (this.#phase === "settled") return
    if (result.persistence !== undefined || result.cancellation === "cancellation_uncertain") {
      this.#result = { ...this.#result, ...result }
      this.#phase = "blocked"
      this.#watch(result)
      this.changed()
      return
    }
    this.#phase = "settled"
    try { await this.complete(result) } finally { this.changed() }
  }
  reconcile(force = false): Promise<PassResult | undefined> {
    if (this.#checking !== undefined) return this.#checking
    if (!this.busy || this.#result.reconcile === undefined ||
      (!force && (this.#checks >= 3 || this.options.clock() < this.#next))) return Promise.resolve(undefined)
    const probe = this.#result.reconcile
    this.#checking = (async () => {
      this.#checks++
      const result = await within(probe(), this.options.config.abort_grace_ms * 3, this.options.timers).catch(() => undefined)
      this.#next = this.options.clock() + this.#backoff()
      if (result?.completed && result.value !== undefined) {
        await this.#accept(result.value)
        return result.value
      }
      if (this.#checks >= 3) await within(Promise.resolve().then(() => this.options.onWarning(this.#result.slug,
        "Advisor recovery required: its previous request or report is still unconfirmed. Use advisor_checkpoint with recover=true to recheck; it will not start an overlapping request.")).catch(() => {}),
      this.options.config.abort_grace_ms, this.options.timers)
      return undefined
    })().finally(() => { this.#checking = undefined; this.changed() })
    return this.#checking
  }
}
