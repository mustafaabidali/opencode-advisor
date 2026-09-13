import type { StateSnapshot } from "../notes/types"
import type { UsageSummary } from "./types"

/** Durable usage is independent of whichever instance last wrote its roster/counters. */
export function withUsage(snapshot: StateSnapshot, accounting: UsageSummary): StateSnapshot {
  if (accounting.attempts === 0 && snapshot.build === undefined) return snapshot
  const totals = new Map(accounting.by_advisor.map((row) => [row.advisor_slug, row.cost]))
  return { ...snapshot, accounting,
    advisors: snapshot.advisors.map((advisor) => ({ ...advisor, cost: totals.get(advisor.slug) ?? 0 })) }
}
