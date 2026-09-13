import { guardNote, meetsMinSeverity, parseAdvice } from "../advice"
import { displayLevel, displayName } from "../models"
import type { Note, NoteInput, TranscriptRecord } from "../notes"
import type { TranscriptInput, NoteWriteInput } from "./pass-types"

const ZERO_TOKENS = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } as const

export function transcript({ input, sessionID, model, outcome, result, duration, failureKind }: TranscriptInput): TranscriptRecord {
  const base = {
    time: new Date(input.clock()).toISOString(),
    root_session: input.watchedID,
    advisor_session: sessionID,
    roster_name: input.entry.name,
    model: model.long,
    variant: displayLevel(model) ?? "default",
    tokens: result?.info.tokens ?? ZERO_TOKENS,
    cost: result?.info.cost ?? 0,
    duration_ms: duration ?? result?.duration ?? 0,
    outcome,
  }
  return failureKind === undefined ? base : { ...base, failure_kind: failureKind }
}

export async function writeSuccessfulNotes({ input, sessionID, model, isFallback, parts, verify, repair }: NoteWriteInput): Promise<Readonly<{ notes: readonly Note[]; quarantined: boolean; parsedCount: number }>> {
  const parsed = parseAdvice(parts.filter((part) => part.type === "text").map((part) => part.text).join("\n"))
  const notes: Note[] = []
  let quarantined = false
  for (const [index, advice] of parsed.notes.entries()) {
    const guard = guardNote(advice, [...input.config.quarantine_patterns])
    if (!guard.quarantined && !meetsMinSeverity(advice.severity, input.entry.min_severity ?? input.config.min_severity)) continue
    const body: NoteInput = {
      ...(input.passID === undefined ? {} : { idempotency_key: `${input.passID}/${sessionID}/${model.long}/${index}` }),
      cwd: input.directory,
      root_session: input.watchedID,
      advisor_session: sessionID,
      advisor_slug: input.entry.slug,
      roster_name: input.entry.name,
      provider: model.providerID,
      model: model.long,
      model_display: displayName(model, input.catalog),
      variant: displayLevel(model) ?? "default",
      severity: advice.severity,
      reasoning: advice.reasoning,
      note: advice.note,
      evidence: advice.evidence,
      ...(advice.failure === undefined ? {} : { failure: advice.failure }),
      ...(advice.location === undefined ? {} : { location: advice.location }),
      is_fallback: isFallback,
      quarantined: guard.quarantined,
    }
    let note = verify ? await input.store.recoverNote?.(body) : await input.store.writeNote(body)
    // Repair only after the previous writer settled and a fresh read proved absence.
    if (note === undefined && repair && input.store.recoverNote !== undefined) note = await input.store.writeNote(body)
    if (note === undefined) throw new Error("Advisor report commit is not confirmed")
    if (guard.quarantined) {
      quarantined = true
      if (!verify) await input.onWarning(input.entry.slug, `Advisor note quarantined by pattern ${guard.matched}`)
    } else notes.push(note)
  }
  return { notes, quarantined, parsedCount: parsed.notes.length }
}
