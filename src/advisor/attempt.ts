import type { AssistantMessage, Part } from "@opencode-ai/sdk"
import { within } from "../async"
import { AdvisorCallError, type ApiResult, type PromptResponse, type AttemptInput, type AttemptResult } from "./pass-types"
import { Lifetime, LifetimeExpired } from "./lifetime"
import type { UsageAttempt, UsageState } from "../usage/types"
import { classifyFailure, displayLevel } from "../models"

export function normalize(data: PromptResponse): Readonly<{ info: AssistantMessage; parts: readonly Part[] }> {
  return "info" in data ? data : { info: data, parts: [] }
}

export function callError(result: ApiResult<unknown>, action: string): AdvisorCallError | undefined {
  if (result.error === undefined && result.data !== undefined && (result.response?.status ?? 200) < 400) {
    return undefined
  }
  return new AdvisorCallError(`${action} failed`, result.response?.status, result.error)
}

export async function attempt({ input, sessionID, model, agent }: AttemptInput): Promise<AttemptResult> {
  const started = input.clock()
  const lifetime = input.lifetime ?? new Lifetime(input.config.pass_timeout_ms, input.clock, input.timers)
  const controller = new AbortController()
  const cancelled = () => controller.abort(lifetime.signal.reason)
  lifetime.signal.addEventListener("abort", cancelled, { once: true })
  let upstream: ReturnType<NonNullable<typeof input.upstream>["listen"]> | undefined
  let request: Promise<ApiResult<PromptResponse>> | undefined
  let usage: UsageAttempt | undefined
  let release: (() => void) | undefined
  let uncertain = false
  const account = async (state: UsageState, response?: ApiResult<PromptResponse>) => {
    if (usage === undefined || input.usage === undefined) return
    const final = response?.data === undefined ? undefined : normalize(response.data).info
    if (state === "completed" && final?.error?.name === "MessageAbortedError") state = "cancelled_confirmed"
    await within(input.usage.finish(usage.id, state, final), input.config.abort_grace_ms, input.timers)
      .catch((error: unknown) => input.log.warn({ msg: "advisor usage reconciliation pending", error }))
  }
  try {
    if (input.admission !== undefined) {
      input.onPhase?.("queued")
      const waiting = input.admission.acquire(model.providerID, input.watchedID, lifetime.signal, input.passID)
      try {
        release = input.admission.limit === 0 ? await waiting :
          await lifetime.waitForSlot(() => waiting, input.config.admission_timeout_ms)
      } catch (error) {
        void waiting.then((permit) => permit()).catch(() => {})
        throw error
      }
    }
    input.onPhase?.("preparing")
    if (input.usage !== undefined) {
      const registering = input.usage.begin({
        root_session: input.watchedID, advisor_session: sessionID, advisor_slug: input.entry.slug,
        model: model.long, variant: displayLevel(model) ?? "default",
        ...(input.passID === undefined ? {} : { pass_id: input.passID }),
      })
      void registering.then((registered) => {
        if (lifetime.signal.aborted && request === undefined) return input.usage?.finish(registered.id, "not_sent")
        return undefined
      }).catch((error: unknown) => input.log.warn({ msg: "advisor attempt registration pending", error }))
      usage = await lifetime.run(() => registering)
    }
    const dispatch = input.beforeDispatch
    if (dispatch !== undefined) await lifetime.run(() => dispatch(sessionID, model, agent, input.clock()))
    const raced = await lifetime.run(() => {
      upstream = input.upstream?.listen(sessionID, input.clock())
      input.onPhase?.("running")
      request = input.client.prompt({
        signal: controller.signal,
        path: { id: sessionID },
        query: { directory: input.directory },
        body: {
          agent, model: { providerID: model.providerID, modelID: model.modelID },
          parts: [{ type: "text", text: input.prompt(sessionID) }],
        },
      })
      return upstream === undefined ? request : Promise.race([request, upstream.promise])
    })
    release?.()
    release = undefined
    input.onPhase?.("persisting")
    await account("completed", raced)
    const error = callError(raced, "advisor prompt")
    if (error !== undefined) return { kind: "failure", error, duration: input.clock() - started }
    const data = raced.data
    if (data === undefined) {
      return { kind: "failure", error: new AdvisorCallError("advisor prompt returned no data"), duration: input.clock() - started }
    }
    return { kind: "response", ...normalize(data), duration: input.clock() - started }
  } catch (error) {
    if (error instanceof LifetimeExpired || request !== undefined) {
      controller.abort(error)
      if (request === undefined) {
        void account("not_sent")
        return { kind: "timeout", duration: input.clock() - started, cancellation: "not_sent",
          pending: Promise.resolve({ error }) }
      }
      let confirmed = false
      const held = release
      const abort = () => input.client.abort({ path: { id: sessionID } }).then((value) => {
        if (value.data === true && value.error === undefined && (value.response?.status ?? 200) < 400) {
          confirmed = true
          held?.()
        }
        return value
      })
      await within(abort(), input.config.abort_grace_ms, input.timers).catch(() => undefined)
      const cancellation = confirmed ? "cancelled_confirmed" : "cancellation_uncertain"
      uncertain = !confirmed
      void account(cancellation)
      if (!(error instanceof LifetimeExpired) && confirmed) {
        return { kind: "failure", error, duration: input.clock() - started }
      }
      let returned: ApiResult<PromptResponse> | undefined
      const pending = request.then(async (response) => {
        if (response.data !== undefined) { held?.(); returned = response }
        await account(response.data === undefined ? cancellation : "completed", response)
        return response
      })
      return { kind: "timeout", duration: input.clock() - started, cancellation, pending,
        ...(error instanceof LifetimeExpired ? {} : { failure: classifyFailure({ thrown: error }, input.config.content_filter_patterns) ?? "api" }),
        reconcile: async () => {
          if (returned !== undefined) return returned
          const read = input.client.messages
          if (read !== undefined) {
            const history = await within(read({ path: { id: sessionID }, query: { directory: input.directory, limit: 256 } }),
              input.config.abort_grace_ms, input.timers).catch(() => undefined)
            const terminal = history?.completed ? history.value.data?.filter(({ info }) =>
              info.role === "assistant" && info.sessionID === sessionID && info.mode === agent &&
              info.time.created >= started && info.time.completed !== undefined &&
              (info.error !== undefined || (info.finish !== undefined && info.finish !== "tool-calls")))
              .sort((a, b) => b.info.time.created - a.info.time.created)[0] : undefined
            if (terminal?.info.role === "assistant") {
              returned = { data: { info: terminal.info, parts: terminal.parts } }
              held?.()
              await account("completed", returned)
              return returned
            }
          }
          if (!confirmed) await within(abort(), input.config.abort_grace_ms, input.timers).catch(() => undefined)
          if (confirmed) { await account("cancelled_confirmed"); return true }
          return undefined
        } }
    }
    await account("not_sent")
    return { kind: "failure", error, duration: input.clock() - started, notSent: true }
  } finally {
    upstream?.close()
    lifetime.signal.removeEventListener("abort", cancelled)
    if (!uncertain) release?.()
    if (input.lifetime === undefined) lifetime.close()
  }
}
