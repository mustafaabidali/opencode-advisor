import { within } from "../async"

/** Best-effort telemetry has one writer and a fixed memory ceiling, even when its sink hangs. */
export class LogBuffer {
  #lines: string[] = []
  #bytes = 0
  #dropped = 0
  #writing: Promise<void> | undefined
  #timer: ReturnType<typeof setTimeout> | undefined
  #closed = false
  constructor(private readonly sink: (batch: string) => Promise<void>,
    private readonly maximum = 256 * 1024, private readonly timeoutMs = 1000) {}
  get metrics() { return { queued_bytes: this.#bytes, dropped: this.#dropped, writers: this.#writing === undefined ? 0 : 1 } }
  add(line: string): void {
    if (this.#closed) return
    const size = Buffer.byteLength(line)
    if (size + this.#bytes > this.maximum) { this.#dropped++; return }
    this.#lines.push(line)
    this.#bytes += size
    if (this.#timer === undefined && this.#writing === undefined) {
      this.#timer = setTimeout(() => { this.#timer = undefined; void this.flush() }, 100)
      this.#timer.unref()
    }
  }
  async flush(): Promise<void> {
    if (this.#timer !== undefined) { clearTimeout(this.#timer); this.#timer = undefined }
    if (this.#lines.length === 0 && this.#writing === undefined) return
    const writing = this.#writing ??= this.#drain().finally(() => { this.#writing = undefined })
    await within(writing, this.timeoutMs)
  }
  async #drain(): Promise<void> {
    while (this.#lines.length > 0) {
      const batch = this.#lines.join("")
      this.#lines = []
      this.#bytes = 0
      try { await this.sink(batch) } catch { this.#dropped += batch.split("\n").length - 1 }
    }
  }
  async close(): Promise<void> { this.#closed = true; await this.flush() }
}
