import { within } from "../async"
import { classifyFailure, parseModelRef } from "../models"
import { saveResponse } from "./persistence"
import { reviewStore } from "./review-store"
import type { PendingPass } from "./journal-data"
import type { AdvisorRuntimeOptions, ResolvedEntry } from "./runtime-types"
import type { ExecutePassInput, PassResult } from "./pass-types"

/** Only called after exclusive ownership is recovered. A timer never proves termination. */
export function restartRecovery(options: AdvisorRuntimeOptions, entry: ResolvedEntry, root: string, pending: PendingPass): PassResult {
  let saved: PassResult | undefined
  return { slug: entry.slug, outcome: "timeout", notes: [], cancellation: "cancellation_uncertain",
    reconcile: async () => {
      if (saved !== undefined) return saved
      const response = await within(options.client.session.messages({
        path: { id: pending.child }, query: { directory: options.directory, limit: 256 },
      }), options.config.abort_grace_ms, options.timers).catch(() => undefined)
      const terminal = response?.completed ? response.value.data?.filter(({ info }) =>
        info.role === "assistant" && info.sessionID === pending.child && info.time.created >= pending.started_at &&
        info.mode === pending.agent && info.time.completed !== undefined &&
        (info.error !== undefined || (info.finish !== undefined && info.finish !== "tool-calls")))
        .sort((a, b) => b.info.time.created - a.info.time.created)[0] : undefined
      if (terminal?.info.role === "assistant") {
        options.admission?.releaseAttempt(pending.id)
        const aborted = terminal.info.error?.name === "MessageAbortedError"
        await options.usage?.recoverPass(pending.id, aborted ? "cancelled_confirmed" : "completed", terminal.info)
        if (aborted) return { slug: entry.slug, outcome: "timeout", notes: [], cancellation: "cancelled_confirmed" }
        const failure = classifyFailure({ info: terminal.info, parts: terminal.parts }, options.config.content_filter_patterns)
        const model = parseModelRef(pending.model, { provider_aliases: {}, variant_aliases: {} })
        if (failure !== null) {
          if (failure !== "content_filter" || options.config.fallback_on_content_filter) {
            options.cooldowns.markCooled(model.long, options.config.fallback_cooldown_ms)
          }
          return { slug: entry.slug, outcome: "error", notes: [], cancellation: "cancelled_confirmed" }
        }
        const store = reviewStore(options.store, pending.review)
        const catalog = typeof options.catalog === "function" ? await options.catalog() : options.catalog
        const input: ExecutePassInput = { ...options, catalog, entry, watchedID: root, advisorSession: pending.child,
          client: options.client.session, passID: pending.id, prompt: () => "",
          refreshSession: async () => { throw new Error("Recovery cannot dispatch") },
          store: { ...store, writeNote: async (note) => await store.recoverNote?.(note) ?? store.writeNote(note) },
        }
        saved = await saveResponse(input, { sessionID: pending.child, model, isFallback: pending.agent !== entry.agentId },
          { kind: "response", info: terminal.info, parts: terminal.parts, duration: 0 })
        return saved
      }
      const abort = await within(options.client.session.abort({ path: { id: pending.child } }),
        options.config.abort_grace_ms, options.timers).catch(() => undefined)
      if (!abort?.completed || abort.value.data !== true || abort.value.error !== undefined) return undefined
      options.admission?.releaseAttempt(pending.id)
      await options.usage?.recoverPass(pending.id, "cancelled_confirmed")
      return { slug: entry.slug, outcome: "timeout", notes: [], cancellation: "cancelled_confirmed" }
    } }
}
