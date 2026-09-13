import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import type { BigIntStats } from "node:fs"
import { lstat, open } from "node:fs/promises"
import { resolve } from "node:path"
import { promisify } from "node:util"
import type { TranscriptMessage } from "../delta"
import { editedFiles } from "./trigger"

const exec = promisify(execFile)
const MAX_FILES = 10_000
const MAX_FILE_BYTES = 4 * 1024 * 1024
const MAX_TOTAL_BYTES = 64 * 1024 * 1024

function stamp(stat: BigIntStats): string {
  return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(":")
}
async function inspect(path: string): Promise<BigIntStats | undefined> {
  return lstat(path, { bigint: true }).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined
    throw error
  })
}

/** An unavailable fingerprint permits review; it never means unchanged. */
export class WorktreeContents {
  readonly #files = new Map<string, { stamp: string; digest: Promise<string | undefined> }>()
  constructor(private readonly directory: string, private readonly worktree = directory) {}

  capture = async (messages: readonly TranscriptMessage[] = []): Promise<string | undefined> => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        this.#capture(messages, controller.signal),
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => { controller.abort(); resolve(undefined) }, 2_000)
        }),
      ])
    } catch {
      return undefined
    } finally {
      clearTimeout(timer)
    }
  }

  async #capture(messages: readonly TranscriptMessage[], signal: AbortSignal): Promise<string | undefined> {
    const edits = editedFiles(messages)
    if (edits === undefined) return undefined
    const { stdout } = await exec("git", [
      "-C", this.worktree, "ls-files", "--cached", "--others", "--exclude-standard", "-z",
    ], { maxBuffer: 2 * 1024 * 1024, signal })
    const paths = [...new Set([
      ...stdout.split("\0").filter(Boolean).map((path) => resolve(this.worktree, path)),
      ...edits.map((path) => resolve(this.directory, path)),
    ])].sort()
    if (paths.length > MAX_FILES) return undefined
    const digest = createHash("sha256")
    let bytes = 0
    for (const absolute of paths) {
      signal.throwIfAborted()
      const stat = await inspect(absolute)
      if (stat === undefined) continue
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES || (bytes += Number(stat.size)) > MAX_TOTAL_BYTES) return undefined
      const key = stamp(stat)
      let cached = this.#files.get(absolute)
      if (cached?.stamp !== key) {
        cached = { stamp: key, digest: this.#hash(absolute, key, signal).catch(() => undefined) }
        this.#files.set(absolute, cached)
        if (this.#files.size > MAX_FILES) {
          const oldest = this.#files.keys().next().value
          if (oldest !== undefined) this.#files.delete(oldest)
        }
      }
      const contents = await cached.digest
      const after = await inspect(absolute)
      if (contents === undefined || after === undefined || stamp(after) !== key) {
        if (this.#files.get(absolute) === cached) this.#files.delete(absolute)
        return undefined
      }
      digest.update(JSON.stringify([absolute, stat.mode.toString(), contents]))
    }
    signal.throwIfAborted()
    return digest.digest("hex")
  }

  async #hash(path: string, expected: string, signal: AbortSignal): Promise<string | undefined> {
    const file = await open(path, "r")
    try {
      if (stamp(await file.stat({ bigint: true })) !== expected) return undefined
      const digest = createHash("sha256")
      const buffer = Buffer.alloc(64 * 1024)
      let total = 0
      while (true) {
        signal.throwIfAborted()
        const { bytesRead } = await file.read(buffer)
        if (bytesRead === 0) break
        if ((total += bytesRead) > MAX_FILE_BYTES) return undefined
        digest.update(buffer.subarray(0, bytesRead))
      }
      return stamp(await file.stat({ bigint: true })) === expected ? digest.digest("hex") : undefined
    } finally {
      await file.close()
    }
  }
}
