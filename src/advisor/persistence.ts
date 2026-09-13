import { within } from "../async"
import { transcript, writeSuccessfulNotes } from "./report"
import type { AttemptResult, ExecutePassInput, NoteWriteInput, PassResult } from "./pass-types"

type Response = Extract<AttemptResult, { kind: "response" }>
/** The provider has finished. Bound persistence independently and never repeat its request to recover a write. */
export async function saveResponse(input: ExecutePassInput, details: Omit<NoteWriteInput, "input" | "parts">,
  response: Response): Promise<PassResult> {
  const result = async (verify = false, repair = false): Promise<PassResult> => {
    const written = await writeSuccessfulNotes({ input, ...details, parts: response.parts, verify, repair })
    const outcome = written.quarantined ? "quarantined" : details.isFallback ? "fallback" : written.parsedCount === 0 ? "silent" : "ok"
    if (!verify) await input.store.appendTranscript(input.watchedID, transcript({
      input, ...details, outcome, result: response,
    }))
    const tokens = response.info.tokens
    return confirmed ??= { slug: input.entry.slug, outcome, notes: written.notes,
      context: { model: details.model.long, tokens: tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write } }
  }
  let confirmed: PassResult | undefined
  let failed = false
  const saving = result().then((value) => confirmed ??= value).catch(async (error: unknown): Promise<PassResult> => {
    failed = true
    await input.log.error({ msg: "advisor report persistence requires reconciliation", advisor: input.entry.slug, passID: input.passID, error })
    return { slug: input.entry.slug, outcome: "error", notes: [], persistence: "recovery_required" }
  })
  const finished = await within(saving, Math.max(1, input.lifetime?.remaining() ?? input.config.abort_grace_ms), input.timers)
  if (finished.completed && finished.value.persistence === undefined) return finished.value
  return {
    slug: input.entry.slug, outcome: finished.completed ? finished.value.outcome : "timeout", notes: [],
    persistence: finished.completed ? "recovery_required" : "pending", pending: saving,
    reconcile: async () => {
      if (confirmed !== undefined) return confirmed
      try { return confirmed = await result(true, failed) } catch { return undefined }
    },
  }
}
