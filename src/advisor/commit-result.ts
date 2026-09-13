import type { PassResult } from "./pass-types"
import { within } from "../async"
import type { AdvisorRuntimeOptions } from "./runtime-types"

/** Persist progress before advancing a cursor; retry bookkeeping without repeating inference. */
export function committedResults(commit: (result: PassResult) => Promise<void>, options: Pick<AdvisorRuntimeOptions, "config" | "timers">) {
  const completed = new WeakMap<PassResult, Promise<PassResult>>()
  const finish = (result: PassResult): Promise<PassResult> => {
    const existing = completed.get(result)
    if (existing !== undefined) return existing
    const work = (async (): Promise<PassResult> => {
      const mapped = {
        ...result,
        ...(result.pending === undefined ? {} : { pending: result.pending.then((late) => late === undefined ? undefined : finish(late)) }),
        ...(result.reconcile === undefined ? {} : { reconcile: async () => {
          const recovered = await result.reconcile?.()
          return recovered === undefined ? undefined : finish(recovered)
        } }),
      }
      if (result.persistence !== undefined || result.cancellation === "cancellation_uncertain") return mapped
      const durable = commit(result).then(() => mapped).catch((): PassResult => {
        completed.delete(result)
        return { slug: result.slug, outcome: result.outcome, notes: [], persistence: "recovery_required", reconcile: () => finish(result) }
      })
      const settled = await within(durable, options.config.abort_grace_ms, options.timers)
      return settled.completed ? settled.value : {
        slug: result.slug, outcome: result.outcome, notes: [], persistence: "pending", pending: durable,
        reconcile: () => durable,
      }
    })()
    completed.set(result, work)
    return work
  }
  return finish
}
