import { createHash, randomBytes } from "node:crypto"
import { readFile, readdir } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import metadata from "../package.json" with { type: "json" }
import type { AdvisorConfig } from "./config"

export type BuildIdentity = Readonly<{
  version: string
  fingerprint: string
  instance_id: string
  started_at: string
  admission_scope: "process"
  max_concurrent_passes_per_provider: number
}>

async function sourceFingerprint(): Promise<string> {
  const path = fileURLToPath(import.meta.url)
  const directory = dirname(path)
  const files = path.endsWith(".ts") ?
    (await readdir(directory, { recursive: true })).filter((name) => name.endsWith(".ts")).sort() :
    [path.slice(directory.length + 1), "database-worker.js"]
  const hash = createHash("sha256").update(JSON.stringify(metadata))
  for (const name of files) hash.update(name).update(await readFile(join(directory, name)))
  return hash.digest("hex").slice(0, 20)
}
// Capture the loaded source once; status never re-hashes the worktree.
const fingerprint = sourceFingerprint().catch(() => "unavailable")
export async function buildIdentity(config: AdvisorConfig, now: number): Promise<BuildIdentity> {
  return { version: metadata.version, fingerprint: await fingerprint, instance_id: randomBytes(12).toString("hex"),
    started_at: new Date(now).toISOString(), admission_scope: "process",
    max_concurrent_passes_per_provider: config.max_concurrent_passes_per_provider }
}
