import type { Timers } from "../async"

export class LifetimeExpired extends Error {
  constructor(readonly reason: "timeout" | "cancelled") {
    super(`Advisor operation ${reason}`)
  }
}

/** One execution budget; retries and preparation share the original deadline. */
export class Lifetime {
  readonly #controller = new AbortController()
  readonly #expiry = Promise.withResolvers<never>()
  #deadline: number
  #timer: unknown
  #queueTime = 0
  #reason: LifetimeExpired | undefined
  #invalidated = false
  constructor(ms: number, private readonly clock: () => number, private readonly timers: Timers) {
    this.#deadline = clock() + ms
    this.#timer = timers.setTimeout(() => this.#expire("timeout"), Math.max(0, ms))
    void this.#expiry.promise.catch(() => {})
  }
  get signal(): AbortSignal { return this.#controller.signal }
  get invalidated(): boolean { return this.#invalidated }
  remaining(): number { return this.#reason === undefined ? Math.max(0, this.#deadline - this.clock()) : 0 }
  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.remaining() === 0) this.#expire("timeout")
    if (this.#reason !== undefined) throw this.#reason
    return Promise.race([operation(), this.#expiry.promise])
  }
  async waitForSlot<T>(operation: () => Promise<T>, maximumWait: number): Promise<T> {
    const remaining = this.remaining()
    if (remaining === 0) this.#expire("timeout")
    if (this.#reason !== undefined) throw this.#reason
    this.timers.clearTimeout(this.#timer)
    const started = this.clock()
    this.#timer = this.timers.setTimeout(() => this.#expire("timeout"), Math.max(0, maximumWait - this.#queueTime))
    try {
      return await Promise.race([operation(), this.#expiry.promise])
    } finally {
      this.#queueTime += Math.max(0, this.clock() - started)
      this.timers.clearTimeout(this.#timer)
      this.#deadline = this.clock() + remaining
      if (this.#reason === undefined) this.#timer = this.timers.setTimeout(() => this.#expire("timeout"), remaining)
    }
  }
  cancel(invalidate = true): void {
    this.#invalidated ||= invalidate
    this.#expire("cancelled")
  }
  close(): void { this.timers.clearTimeout(this.#timer) }
  #expire(reason: "timeout" | "cancelled"): void {
    if (this.#reason !== undefined) return
    this.#reason = new LifetimeExpired(reason)
    this.#expiry.reject(this.#reason)
    this.#controller.abort(this.#reason)
  }
}
