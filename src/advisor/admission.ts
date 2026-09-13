type Waiter = {
  root: string
  resolve: (release: () => void) => void
  reject: (error: Error) => void
  signal?: AbortSignal
  abort: () => void
}
type Bucket = { active: number; lastRoot: string; queue: Waiter[] }

/** Fair per-provider permits in this process; a permit survives uncertain cancellation. */
export class ProviderAdmission {
  readonly #buckets = new Map<string, Bucket>()
  readonly #attempts = new Map<string, () => void>()
  constructor(readonly limit: number, private readonly idle?: () => void) {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("Invalid provider concurrency limit")
  }
  active(provider: string): number { return this.#buckets.get(provider)?.active ?? 0 }
  get busy(): boolean { return this.#buckets.size > 0 }
  releaseAttempt(id: string): void { this.#attempts.get(id)?.() }
  async acquire(provider: string, root: string, signal?: AbortSignal, attemptID?: string): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new Error("Advisor admission cancelled"))
    const bucket = this.#buckets.get(provider) ?? { active: 0, lastRoot: "", queue: [] }
    this.#buckets.set(provider, bucket)
    const permit = await new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = {
        root, resolve, reject, ...(signal === undefined ? {} : { signal }),
        abort: () => {
          bucket.queue = bucket.queue.filter((entry) => entry !== waiter)
          reject(new Error("Advisor admission cancelled"))
          this.#drain(provider, bucket)
        },
      }
      signal?.addEventListener("abort", waiter.abort, { once: true })
      bucket.queue.push(waiter)
      this.#drain(provider, bucket)
    })
    const release = () => {
      if (attemptID !== undefined && this.#attempts.get(attemptID) === release) this.#attempts.delete(attemptID)
      permit()
    }
    if (attemptID !== undefined) this.#attempts.set(attemptID, release)
    return release
  }
  #drain(provider: string, bucket: Bucket): void {
    while (bucket.queue.length > 0 && (this.limit === 0 || bucket.active < this.limit)) {
      const differentRoot = bucket.queue.findIndex((waiter) => waiter.root !== bucket.lastRoot)
      const waiter = bucket.queue.splice(Math.max(0, differentRoot), 1)[0]
      if (waiter === undefined) return
      waiter.signal?.removeEventListener("abort", waiter.abort)
      if (waiter.signal?.aborted) { waiter.reject(new Error("Advisor admission cancelled")); continue }
      bucket.lastRoot = waiter.root
      bucket.active++
      let released = false
      waiter.resolve(() => {
        if (released) return
        released = true
        bucket.active--
        this.#drain(provider, bucket)
      })
    }
    if (bucket.active === 0 && bucket.queue.length === 0) {
      this.#buckets.delete(provider)
      if (!this.busy) this.idle?.()
    }
  }
}

const pools = new Map<string, { pool: ProviderAdmission; owners: number }>()
export function processAdmission(dataDir: string, limit: number): ProviderAdmission {
  const key = `${dataDir}\u0000${limit}`
  let entry = pools.get(key)
  if (entry === undefined) {
    entry = { pool: new ProviderAdmission(limit, () => {
      if (pools.get(key)?.owners === 0) pools.delete(key)
    }), owners: 0 }
    pools.set(key, entry)
  }
  entry.owners++
  return entry.pool
}
export function releaseProcessAdmission(dataDir: string, limit: number): void {
  const key = `${dataDir}\u0000${limit}`
  const entry = pools.get(key)
  if (entry === undefined) return
  entry.owners = Math.max(0, entry.owners - 1)
  if (entry.owners === 0 && !entry.pool.busy) pools.delete(key)
}
