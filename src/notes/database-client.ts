import { Worker } from "node:worker_threads"
import { resolve } from "node:path"
import type { Arguments, Operation, Response, Result } from "./database-protocol"

/** The worker may have committed before transport failed; do not roll back files blindly. */
export class DatabaseUnavailableError extends Error {}
/** The worker had already failed; this request was never posted and cannot have committed. */
export class DatabaseRequestNotSentError extends Error {}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void }
type QueryOperation = Exclude<Operation, "close">
export type DatabaseHandle = {
  request: <K extends QueryOperation>(operation: K, args: Arguments<K>) => Promise<Result<K>>
  close: () => Promise<void>
}

class DatabaseClient {
  readonly #worker = new Worker(new URL(
    import.meta.url.endsWith(".ts") ? "./database-worker.ts" : "./database-worker.js", import.meta.url,
  ))
  readonly #pending = new Map<number, Pending>()
  readonly #owners = new Map<string, number>()
  #next = 0
  #failed = false
  #termination: Promise<number> | undefined

  constructor() {
    this.#worker.on("message", (response: Response) => {
      const pending = this.#pending.get(response.id)
      if (pending === undefined) return
      this.#pending.delete(response.id)
      if (response.ok) pending.resolve(response.value)
      else pending.reject(new Error(response.error))
      if (this.#pending.size === 0) this.#worker.unref()
    })
    this.#worker.on("error", (error) => this.#fail(error))
    this.#worker.on("messageerror", (error) => this.#fail(error))
    this.#worker.on("exit", (code) => this.#fail(new Error(`Database worker exited (${code})`)))
  }

  #fail(error: Error): void {
    if (this.#failed) return
    this.#failed = true
    if (client === this) client = undefined
    for (const pending of this.#pending.values()) {
      pending.reject(new DatabaseUnavailableError(error.message))
    }
    this.#pending.clear()
    this.#worker.unref()
    this.#termination ??= this.#worker.terminate()
  }

  acquire(dataDir: string): DatabaseHandle {
    this.#owners.set(dataDir, (this.#owners.get(dataDir) ?? 0) + 1)
    let closing: Promise<void> | undefined
    return {
      request: (operation, args) => {
        if (closing !== undefined) return Promise.reject(new Error("Finding store closed"))
        return this.request(dataDir, operation, args)
      },
      close: () => closing ??= this.#release(dataDir),
    }
  }

  async #release(dataDir: string): Promise<void> {
    const remaining = (this.#owners.get(dataDir) ?? 1) - 1
    if (remaining > 0) {
      this.#owners.set(dataDir, remaining)
      if (this.#failed) await this.#termination
      return
    }
    this.#owners.delete(dataDir)
    const last = this.#owners.size === 0
    if (last && client === this) client = undefined
    try {
      if (!this.#failed) await this.request(dataDir, "close", [])
    } finally {
      if (last) await (this.#termination ??= this.#worker.terminate())
    }
  }

  request<K extends Operation>(dataDir: string, operation: K, args: Arguments<K>): Promise<Result<K>> {
    if (this.#failed) return Promise.reject(new DatabaseRequestNotSentError("Database worker unavailable"))
    return new Promise((resolveResult, reject) => {
      const id = this.#next++
      // Replies are from our typed worker and correlated with the operation by request ID.
      this.#pending.set(id, { resolve: (value) => resolveResult(value as Result<K>), reject })
      this.#worker.ref()
      try {
        this.#worker.postMessage({ id, dataDir: resolve(dataDir), operation, args })
      } catch (error) {
        this.#pending.delete(id)
        if (this.#pending.size === 0) this.#worker.unref()
        reject(error)
      }
    })
  }
}

let client: DatabaseClient | undefined

export function acquireDatabase(dataDir: string): DatabaseHandle {
  client ??= new DatabaseClient()
  return client.acquire(resolve(dataDir))
}
