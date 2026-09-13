import { randomUUID } from "node:crypto"
import { rename, rm, writeFile } from "node:fs/promises"

/** Readers see either the previous complete file or the new complete file. */
export async function atomicWrite(path: string, text: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, text, { encoding: "utf8", flag: "wx" })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}
