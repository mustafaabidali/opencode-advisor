import { displayLevel, displayName, type CooldownRegistry, type ModelCatalog } from "../models"
import type { StateSnapshot, TranscriptOutcome } from "../notes"
import type { AdvisorEntry } from "../roster"

export type AdvisorStats = { passes: number; notes: number; cost: number; lastPassAt: string; lastOutcome: TranscriptOutcome }

export type SnapshotInput = Readonly<{
  roster: readonly AdvisorEntry[]
  stats: ReadonlyMap<string, AdvisorStats>
  cooldowns: Pick<CooldownRegistry, "cooledUntil">
  catalog: ModelCatalog
  watched: Iterable<string>
  now: number
}>

export function buildSnapshot(input: SnapshotInput): StateSnapshot {
  const nowIso = new Date(input.now).toISOString()
  return {
    advisors: input.roster.map((entry) => {
      const stats = input.stats.get(entry.slug)
      const cooledUntil = input.cooldowns.cooledUntil(entry.model.long)
      return {
        slug: entry.slug,
        roster_name: entry.name,
        model: entry.model.long,
        model_display: displayName(entry.model, input.catalog),
        variant: displayLevel(entry.model) ?? "default",
        ...(entry.fallback === undefined ? {} : { fallback: entry.fallback.long }),
        tools: entry.tools,
        enabled: entry.enabled,
        ...(cooledUntil === undefined ? {} : { cooled_until: new Date(cooledUntil).toISOString() }),
        passes: stats?.passes ?? 0,
        notes: stats?.notes ?? 0,
        cost: stats?.cost ?? 0,
        last_pass_at: stats?.lastPassAt ?? nowIso,
        last_outcome: stats?.lastOutcome ?? "silent",
      }
    }),
    watched_sessions: [...input.watched],
    updated_at: nowIso,
  }
}
