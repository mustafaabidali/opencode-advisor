import type { AdvisorConfig } from "../config"
import type { PassResult } from "./pass-types"

/** Back off once per timed-out pass; time spent confirming cancellation counts toward the gap. */
export class TimeoutBackoff {
  #count = 0
  #next = 0
  #lastPass = ""
  constructor(private readonly config: Pick<AdvisorConfig, "cooldown_ms">, private readonly clock: () => number) {}
  get until(): number | undefined { return this.clock() < this.#next ? this.#next : undefined }
  observe(passID: string, result: PassResult): void {
    if (result.outcome !== "timeout") {
      this.#count = 0
      this.#next = 0
      this.#lastPass = ""
      return
    }
    if (this.#lastPass === passID) return
    this.#lastPass = passID
    const base = Math.max(1000, this.config.cooldown_ms)
    const delay = Math.min(base * 2 ** Math.min(this.#count++, 8), Math.max(base, 300_000))
    this.#next = this.clock() + delay
  }
}
