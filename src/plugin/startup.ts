import type { BuildIdentity } from "../identity"
import type { Logger } from "../log"
import type { ResolvedEntry } from "../advisor/runtime-types"
import { displayName } from "../models"

export async function logStartup(log: Logger, build: BuildIdentity, roster: readonly ResolvedEntry[], dataDir: string): Promise<void> {
  await log.info({ msg: "advisor started", ...build, rosterSize: roster.length, dataDir,
    advisors: roster.map((entry) => ({ id: entry.agentId, model: displayName(entry.model, new Map()) })) })
  await log.flush?.()
}
