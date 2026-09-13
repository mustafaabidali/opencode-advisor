import { readdir } from "node:fs/promises"
import { join } from "node:path"
import type { Logger } from "../log"
import type { FindingStore } from "./findings"
import type { ReportFiles } from "./report-files"
import type { CatalogCursor, CatalogProgress } from "./catalog-database"
import type { Finding, Note } from "./types"
import { isMissingFile } from "./parse"

/** Bounded metadata migration, scoped lookup, and durable receipt/mirror ownership. */
export class NoteCatalog {
  #backfill: Promise<CatalogProgress> | undefined
  constructor(private readonly db: FindingStore, private readonly files: ReportFiles, private readonly log: Logger) {}

  backfill(limit = 128): Promise<CatalogProgress> {
    return this.#backfill ??= this.#migrate(Math.max(1, Math.min(limit, 512))).finally(() => { this.#backfill = undefined })
  }

  async #migrate(limit: number): Promise<CatalogProgress> {
    const progress = await this.db.catalogProgress()
    if (progress.complete) return progress
    let names: string[]
    try { names = await readdir(join(this.files.dataDir, "notes")) }
    catch (error) { if (!isMissingFile(error)) throw error; names = [] }
    const remaining = names.filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5))
      .filter((id) => progress.cursor === "" || id < progress.cursor).sort().reverse()
    const page = remaining.slice(0, limit)
    const missing = await this.db.catalogMissing(page)
    const notes: Note[] = []
    const unavailable: string[] = []
    for (const id of missing) {
      const note = await this.files.read(id)
      if (note === undefined) unavailable.push(id)
      else notes.push(note)
    }
    await this.db.catalogIndex(notes, unavailable, page.at(-1) ?? progress.cursor, remaining.length <= limit)
    return this.db.catalogProgress()
  }

  async delivered(findings: readonly Finding[]): Promise<ReadonlySet<string>> {
    const ids = [...new Set(findings.flatMap((finding) => finding.provenance.map((source) => source.note_id)))]
    const missing = await this.db.catalogMissing(ids)
    if (missing.length > 0) {
      const notes: Note[] = []
      for (const id of missing) {
        const note = await this.files.read(id)
        if (note !== undefined) notes.push(note)
      }
      await this.db.catalogIndex(notes, [])
    }
    return new Set(await this.db.delivered(findings.map(({ id, reopened_at }) =>
      reopened_at === undefined ? { id } : { id, reopened_at })))
  }

  async list(cwd: string, last: number): Promise<Note[]> {
    if (!Number.isSafeInteger(last) || last <= 0) return []
    await this.backfill()
    const notes: Note[] = []
    let cursor: CatalogCursor | undefined
    while (notes.length < last) {
      const page = await this.db.catalogPage(cwd, Math.min(128, last - notes.length), cursor)
      if (page.length === 0) break
      for (const entry of page) {
        const note = await this.files.read(entry.id)
        if (note !== undefined && note.cwd === cwd) notes.push(note)
      }
      cursor = page.at(-1)
    }
    const receipts = new Map((await this.db.receipts(notes.map((note) => note.id))).map((receipt) =>
      [receipt.note_id, receipt.delivered_at]))
    return notes.map((note) => {
      const at = receipts.get(note.id)
      return at === undefined ? note : { ...note, delivered_at: at }
    })
  }

  async acknowledge(ids: readonly string[], at: string): Promise<Note[]> {
    await this.db.acknowledge(ids, at)
    const notes: Note[] = []
    // A failed mirror cannot undo an acknowledged card. Rollback repair uses the canonical receipts.
    for (const id of ids) {
      try {
        const note = await this.files.read(id)
        if (note === undefined) throw new Error("Acknowledged report is currently unavailable")
        notes.push(note)
        await this.files.mirror(note, { delivered_at: at })
      } catch (error) { await this.log.warn({ msg: "advisor receipt mirror pending", noteID: id, error }) }
    }
    return notes
  }

  async repair(): Promise<{ repaired: number; missing: number }> {
    let after = ""
    let repaired = 0
    let missing = 0
    for (;;) {
      const receipts = await this.db.receiptPage(after, 128)
      if (receipts.length === 0) return { repaired, missing }
      for (const receipt of receipts) {
        const note = await this.files.read(receipt.note_id)
        if (note === undefined) { missing++; continue }
        if (note.delivered_at === receipt.delivered_at) continue
        await this.files.mirror(note, { delivered_at: receipt.delivered_at })
        repaired++
      }
      after = receipts.at(-1)?.note_id ?? after
    }
  }
}
