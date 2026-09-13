import { createHash, randomUUID } from "node:crypto"
import { link, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { findingIdentity, issueIdentity } from "../policy"
import { redact, type Logger } from "../log"
import { atomicWrite } from "./files"
import { isMissingFile, parseNote } from "./parse"
import type { Note, NoteInput } from "./types"

export class ReportFiles {
  reads = 0
  constructor(readonly dataDir: string, private readonly log: Logger) {}

  path(id: string): string { return join(this.dataDir, "notes", `${id}.json`) }
  identity(input: NoteInput): string | undefined {
    return input.idempotency_key === undefined ? undefined :
      `pass-${createHash("sha256").update([input.cwd, input.root_session, input.idempotency_key].join("\0")).digest("hex").slice(0, 32)}`
  }

  async read(id: string): Promise<Note | undefined> {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) return undefined
    this.reads++
    try {
      const note = parseNote(await readFile(this.path(id), "utf8"))
      if (note === undefined || note.id !== id) {
        await this.log.warn({ msg: "advisor note corrupt", noteID: id })
        return undefined
      }
      return note
    } catch (error) {
      if (isMissingFile(error)) return undefined
      if (!(error instanceof SyntaxError)) throw error
      await this.log.warn({ msg: "advisor note corrupt", noteID: id, error })
      return undefined
    }
  }

  async create(input: NoteInput, time: string, random: number): Promise<{ note: Note; created: boolean }> {
    const { idempotency_key: key, ...body } = input
    const stamp = time.slice(0, 19).replaceAll("-", "").replace("T", "-").replaceAll(":", "")
    const suffix = Math.floor(random * 0x1000000).toString(16).padStart(6, "0").slice(-6)
    const id = this.identity(input) ?? `${stamp}-${suffix}`
    const safe: NoteInput = {
      ...body, reasoning: redact(body.reasoning), note: redact(body.note), evidence: body.evidence.map(redact),
      ...(body.failure === undefined ? {} : { failure: redact(body.failure) }),
      ...(body.location === undefined ? {} : { location: redact(body.location) }),
    }
    const note: Note = { ...safe, id, time, finding_id: findingIdentity(safe), issue_id: issueIdentity(safe) }
    await mkdir(join(this.dataDir, "notes"), { recursive: true })
    if (key === undefined) {
      await atomicWrite(this.path(id), JSON.stringify(note))
      return { note, created: true }
    }
    // A stable retry must never overwrite a delivered or concurrently committed report.
    const temporary = `${this.path(id)}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, JSON.stringify(note), { encoding: "utf8", flag: "wx" })
      try {
        await link(temporary, this.path(id))
        return { note, created: true }
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error
        const existing = await this.read(id)
        if (existing === undefined || existing.finding_id !== note.finding_id) throw new Error("Report identity requires recovery")
        return { note: existing, created: false }
      }
    } finally { await rm(temporary, { force: true }) }
  }

  async mirror(note: Note, fields: Pick<Partial<Note>, "delivered_at" | "expired_at">): Promise<void> {
    await atomicWrite(this.path(note.id), JSON.stringify({ ...note, ...fields }))
  }
}
