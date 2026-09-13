import { appendFile, mkdir, readdir, rename, rm, stat } from "node:fs/promises"
import { randomBytes } from "node:crypto"
import { basename, dirname, join } from "node:path"

/** Unique archive names avoid overwriting another process's rotation. Evidence is never pruned here. */
export function rotatingLog(path: string, maximum: number, retention: number): (batch: string) => Promise<void> {
  let ready: Promise<void> | undefined
  return async (batch) => {
    await (ready ??= mkdir(dirname(path), { recursive: true }).then(() => {}).catch((error: unknown) => {
      ready = undefined
      throw error
    }))
    const size = await stat(path).then((file) => file.size).catch(() => 0)
    if (size >= maximum) {
      await rename(path, `${path}.${Date.now()}-${randomBytes(6).toString("hex")}.log`).catch(() => {})
      const prefix = `${basename(path)}.`
      const archives = (await readdir(dirname(path))).filter((name) =>
        name.startsWith(prefix) && /^\d+-[0-9a-f]{12}\.log$/.test(name.slice(prefix.length))).sort().reverse()
      await Promise.all(archives.slice(retention).map((name) => rm(join(dirname(path), name), { force: true })))
    }
    await appendFile(path, batch, "utf8")
  }
}
