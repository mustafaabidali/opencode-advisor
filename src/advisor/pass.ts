import { redact } from "../log"
import { classifyFailure, pickModel } from "../models"
import { attempt, callError, normalize } from "./attempt"
import { transcript } from "./report"
import { saveResponse } from "./persistence"
import { AdvisorCallError, type AttemptResult, type ExecutePassInput, type PassResult } from "./pass-types"
import { randomUUID } from "node:crypto"
import { Lifetime, LifetimeExpired } from "./lifetime"
import { within } from "../async"
export { AdvisorCallError } from "./pass-types"
export type { AdvisorStore, AdvisorTimers, ApiResult, PassResult, PromptCall, PromptResponse, ExecutePassInput } from "./pass-types"

export async function executeAdvisorPass(input: ExecutePassInput): Promise<PassResult> {
  const lifetime = input.lifetime ?? new Lifetime(input.config.pass_timeout_ms, input.clock, input.timers)
  try {
    return await execute({ ...input, lifetime, passID: input.passID ?? randomUUID() })
  } catch (error) {
    if (!(error instanceof LifetimeExpired)) throw error
    return { slug: input.entry.slug, outcome: "timeout", notes: [], cancellation: "not_sent" }
  } finally {
    if (input.lifetime === undefined) lifetime.close()
  }
}

async function execute(input: ExecutePassInput & { lifetime: Lifetime }): Promise<PassResult> {
  let sessionID = input.advisorSession
  const selected = pickModel(input.entry, input.cooldowns)
  if (selected === null) {
    await input.lifetime.run(() => input.store.appendTranscript(input.watchedID, transcript({ input, sessionID, model: input.entry.model, outcome: "no_model" })))
    await input.lifetime.run(async () => { await input.onWarning(input.entry.slug, "No advisor model is currently available") })
    return { slug: input.entry.slug, outcome: "no_model", notes: [] }
  }

  let model = selected.ref
  let isFallback = selected.isFallback
  let agent = isFallback ? (input.entry.fallbackAgentId ?? `${input.entry.agentId}-fb`) : input.entry.agentId
  for (let attemptIndex = 0; attemptIndex < 2; attemptIndex += 1) {
    let result: AttemptResult
    let failure: ReturnType<typeof classifyFailure>
    for (let refreshIndex = 0; ; refreshIndex += 1) {
      result = await attempt({ input, sessionID, model, agent })
      if (result.kind === "failure" && result.notSent) {
        const error = result.error
        await input.lifetime.run(() => input.log.warn({ msg: "advisor request was not sent",
          advisor: input.entry.slug, error }))
        await input.lifetime.run(() => input.store.appendTranscript(input.watchedID,
          transcript({ input, sessionID, model, outcome: "error", duration: result.duration })))
        return { slug: input.entry.slug, outcome: "error", notes: [], cancellation: "not_sent" }
      }
      if (result.kind === "response" && result.info.error?.name === "MessageAbortedError") {
        return { slug: input.entry.slug, outcome: "timeout", notes: [], cancellation: "cancelled_confirmed" }
      }
      failure = result.kind === "failure"
        ? classifyFailure({ thrown: result.error }, input.config.content_filter_patterns) ?? "api"
        : result.kind === "response"
          ? classifyFailure({ info: result.info, parts: result.parts }, input.config.content_filter_patterns)
          : null
      if (failure !== null) {
        const error = result.kind === "failure" ? result.error : result.kind === "response" ? result.info.error : null
        const detail = JSON.stringify(error, (_key, value: unknown) => value instanceof Error
          ? { ...value, name: value.name, message: value.message }
          : value) ?? "null"
        const thrownStatus = result.kind === "failure" && typeof result.error === "object" && result.error !== null
          && "status" in result.error && typeof result.error.status === "number" ? result.error.status : undefined
        const status = result.kind === "response" && result.info.error?.name === "APIError" ? result.info.error.data.statusCode : thrownStatus
        await input.log.warn({ msg: "advisor attempt failed", advisor: input.entry.slug, model: model.long, agent, failure_kind: failure, ...(status === undefined ? {} : { status }), detail: redact(detail).slice(0, 600) })
      }
      const missingSession = result.kind === "failure" && result.error instanceof AdvisorCallError && result.error.status === 404
      if (refreshIndex > 0 || !(missingSession || failure === "poisoned_session")) break
      if (failure === "poisoned_session") await input.lifetime.run(() => input.store.appendTranscript(input.watchedID, transcript({ input, sessionID, model, outcome: "error", ...(result.kind === "response" ? { result } : {}), failureKind: "poisoned_session" })))
      sessionID = await input.lifetime.run(input.refreshSession)
    }
    if (result.kind === "timeout") {
      if (result.failure !== undefined && (result.failure !== "content_filter" || input.config.fallback_on_content_filter)) {
        input.cooldowns.markCooled(model.long, input.config.fallback_cooldown_ms)
      }
      const outcome = result.failure === undefined ? "timeout" : "error"
      const cancelled: PassResult = { slug: input.entry.slug, outcome, notes: [], cancellation: "cancelled_confirmed" }
      void within(input.store.appendTranscript(input.watchedID, transcript({ input, sessionID, model, outcome, duration: result.duration, failureKind: result.failure ?? "timeout" })),
        input.config.abort_grace_ms, input.timers).catch((error: unknown) => input.log.warn({ msg: "advisor timeout transcript pending", error }))
      let processed: Promise<PassResult> | undefined
      const process = async (response: import("./pass-types").ApiResult<import("./pass-types").PromptResponse>): Promise<PassResult | undefined> => {
        if (callError(response, "late advisor prompt") !== undefined || response.data === undefined) return undefined
        if (input.lifetime.invalidated || input.acceptResult?.() === false) return undefined
        const late = normalize(response.data)
        if (late.info.error?.name === "MessageAbortedError") {
          return cancelled
        }
        const failed = classifyFailure(late, input.config.content_filter_patterns)
        if (failed !== null) {
          if (failed !== "content_filter" || input.config.fallback_on_content_filter) {
            input.cooldowns.markCooled(model.long, input.config.fallback_cooldown_ms)
          }
          return { slug: input.entry.slug, outcome: "error", notes: [], cancellation: "cancelled_confirmed" }
        }
        return processed ??= saveResponse(input, { sessionID, model, isFallback }, { kind: "response", ...late, duration: result.duration })
      }
      const pending = result.pending.then(process).catch(async (error: unknown) => {
        await input.log.warn({ msg: "advisor late result unavailable", advisor: input.entry.slug, error })
        return undefined
      })
      return { slug: input.entry.slug, outcome, notes: [], cancellation: result.cancellation, pending,
        ...(result.reconcile === undefined ? {} : { reconcile: async () => {
          const recovered = await result.reconcile?.()
          return recovered === true ? cancelled :
            recovered === undefined ? undefined : process(recovered)
        } }) }
    }
    if (failure !== null) {
      await input.lifetime.run(() => input.store.appendTranscript(input.watchedID, transcript({ input, sessionID, model, outcome: "error", ...(result.kind === "response" ? { result } : { duration: result.duration }), failureKind: failure })))
      const canFallback = !isFallback && input.entry.fallback !== undefined && !input.cooldowns.isCooled(input.entry.fallback.long)
        && (failure !== "content_filter" || input.config.fallback_on_content_filter)
      if (failure !== "content_filter" || input.config.fallback_on_content_filter) {
        input.cooldowns.markCooled(model.long, input.config.fallback_cooldown_ms)
      }
      if (canFallback && attemptIndex === 0 && input.entry.fallback !== undefined &&
        input.lifetime.remaining() >= input.config.min_fallback_budget_ms) {
        model = input.entry.fallback
        isFallback = true
        agent = input.entry.fallbackAgentId ?? `${input.entry.agentId}-fb`
        continue
      }
      return { slug: input.entry.slug, outcome: "error", notes: [] }
    }
    if (result.kind !== "response") return { slug: input.entry.slug, outcome: "error", notes: [] }
    return saveResponse(input, { sessionID, model, isFallback }, result)
  }
  await input.log.error({ msg: "advisor fallback loop exhausted", advisor: input.entry.slug })
  return { slug: input.entry.slug, outcome: "error", notes: [] }
}
