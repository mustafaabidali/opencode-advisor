import type { AssistantMessage, Part } from "@opencode-ai/sdk"
import { guardNote, meetsMinSeverity, parseAdvice } from "../advice"
import type { AdvisorConfig } from "../config"
import { redact, type Logger } from "../log"
import {
  classifyFailure, displayLevel, displayName, pickModel,
  type CooldownRegistry, type ModelCatalog, type ModelRef,
} from "../models"
import type { Note, NoteInput, TranscriptOutcome, TranscriptRecord } from "../notes"
import type { AdvisorEntry } from "../roster"

export type ApiResult<Data> = Readonly<{
  data?: Data
  error?: unknown
  response?: Readonly<{ status: number }>
}>

export type PromptResponse = Readonly<{ info: AssistantMessage; parts: readonly Part[] }> | AssistantMessage

export type PromptCall = Readonly<{
  path: Readonly<{ id: string }>
  query: Readonly<{ directory: string }>
  body: Readonly<{
    agent: string
    model: Readonly<{ providerID: string; modelID: string }>
    parts: readonly [{ readonly type: "text"; readonly text: string }]
  }>
}>

export type AdvisorTimers = Readonly<{
  setTimeout: (callback: () => void, ms: number) => unknown
  clearTimeout: (timer: unknown) => void
}>

export type AdvisorStore = Readonly<{
  writeNote: (input: NoteInput) => Promise<Note>
  appendTranscript: (rootSession: string, record: TranscriptRecord) => Promise<void>
  writeState: import("../notes").NoteStore["writeState"]
}>

export type PassResult = Readonly<{
  slug: string
  outcome: TranscriptOutcome
  notes: readonly Note[]
}>

export class AdvisorCallError extends Error {
  readonly name = "AdvisorCallError"

  constructor(
    message: string,
    readonly status?: number,
    readonly detail?: unknown,
  ) {
    super(message)
  }
}

type AttemptResult =
  | Readonly<{ kind: "response"; info: AssistantMessage; parts: readonly Part[]; duration: number }>
  | Readonly<{ kind: "failure"; error: unknown; duration: number }>
  | Readonly<{ kind: "timeout"; duration: number }>
type AttemptInput = Readonly<{ input: ExecutePassInput; sessionID: string; model: ModelRef; agent: string }>
type TranscriptInput = Readonly<{ input: ExecutePassInput; sessionID: string; model: ModelRef; outcome: TranscriptOutcome; result?: Extract<AttemptResult, { kind: "response" }>; duration?: number; failureKind?: TranscriptRecord["failure_kind"] }>
type NoteWriteInput = Readonly<{ input: ExecutePassInput; sessionID: string; model: ModelRef; isFallback: boolean; parts: readonly Part[] }>

export type ExecutePassInput = Readonly<{
  config: AdvisorConfig
  entry: AdvisorEntry
  catalog: ModelCatalog
  cooldowns: CooldownRegistry
  store: AdvisorStore
  log: Logger
  client: Readonly<{
    prompt: (call: PromptCall) => Promise<ApiResult<PromptResponse>>
    abort: (call: Readonly<{ path: Readonly<{ id: string }> }>) => Promise<ApiResult<boolean>>
  }>
  directory: string
  watchedID: string
  advisorSession: string
  prompt: (sessionID: string) => string
  clock: () => number
  timers: AdvisorTimers
  refreshSession: () => Promise<string>
  onWarning: (slug: string, message: string) => void | Promise<void>
}>

const ZERO_TOKENS = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } as const

function normalize(data: PromptResponse): Readonly<{ info: AssistantMessage; parts: readonly Part[] }> {
  return "info" in data ? data : { info: data, parts: [] }
}

function callError(result: ApiResult<unknown>, action: string): AdvisorCallError | undefined {
  if (result.error === undefined && result.data !== undefined && (result.response?.status ?? 200) < 400) {
    return undefined
  }
  return new AdvisorCallError(`${action} failed`, result.response?.status, result.error)
}

async function attempt({ input, sessionID, model, agent }: AttemptInput): Promise<AttemptResult> {
  const started = input.clock()
  let timer: unknown
  const timeout = new Promise<"timeout">((resolve) => {
    timer = input.timers.setTimeout(() => resolve("timeout"), input.config.pass_timeout_ms)
  })
  try {
    const request = input.client.prompt({
      path: { id: sessionID },
      query: { directory: input.directory },
      body: {
        agent,
        model: { providerID: model.providerID, modelID: model.modelID },
        parts: [{ type: "text", text: input.prompt(sessionID) }],
      },
    })
    const raced = await Promise.race([request, timeout])
    if (raced === "timeout") {
      await input.client.abort({ path: { id: sessionID } })
      return { kind: "timeout", duration: input.clock() - started }
    }
    const error = callError(raced, "advisor prompt")
    if (error !== undefined) return { kind: "failure", error, duration: input.clock() - started }
    const data = raced.data
    if (data === undefined) {
      return { kind: "failure", error: new AdvisorCallError("advisor prompt returned no data"), duration: input.clock() - started }
    }
    return { kind: "response", ...normalize(data), duration: input.clock() - started }
  } catch (error) {
    return { kind: "failure", error, duration: input.clock() - started }
  } finally {
    if (timer !== undefined) input.timers.clearTimeout(timer)
  }
}

function transcript({ input, sessionID, model, outcome, result, duration, failureKind }: TranscriptInput): TranscriptRecord {
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

async function writeSuccessfulNotes({ input, sessionID, model, isFallback, parts }: NoteWriteInput): Promise<Readonly<{ notes: readonly Note[]; quarantined: boolean; parsedCount: number }>> {
  const parsed = parseAdvice(parts.filter((part) => part.type === "text").map((part) => part.text).join("\n"))
  const notes: Note[] = []
  let quarantined = false
  for (const advice of parsed.notes) {
    const guard = guardNote(advice, [...input.config.quarantine_patterns])
    if (!guard.quarantined && !meetsMinSeverity(advice.severity, input.entry.min_severity ?? input.config.min_severity)) continue
    const note = await input.store.writeNote({
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
    })
    if (guard.quarantined) {
      quarantined = true
      await input.onWarning(input.entry.slug, `Advisor note quarantined by pattern ${guard.matched}`)
    } else notes.push(note)
  }
  return { notes, quarantined, parsedCount: parsed.notes.length }
}

export async function executeAdvisorPass(input: ExecutePassInput): Promise<PassResult> {
  let sessionID = input.advisorSession
  const selected = pickModel(input.entry, input.cooldowns)
  if (selected === null) {
    await input.store.appendTranscript(input.watchedID, transcript({ input, sessionID, model: input.entry.model, outcome: "no_model" }))
    await input.onWarning(input.entry.slug, "No advisor model is currently available")
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
      if (failure === "poisoned_session") await input.store.appendTranscript(input.watchedID, transcript({ input, sessionID, model, outcome: "error", ...(result.kind === "response" ? { result } : {}), failureKind: failure }))
      sessionID = await input.refreshSession()
    }
    if (result.kind === "timeout") {
      await input.store.appendTranscript(input.watchedID, transcript({ input, sessionID, model, outcome: "timeout", duration: result.duration, failureKind: "timeout" }))
      return { slug: input.entry.slug, outcome: "timeout", notes: [] }
    }
    if (failure !== null) {
      await input.store.appendTranscript(input.watchedID, transcript({ input, sessionID, model, outcome: "error", ...(result.kind === "response" ? { result } : { duration: result.duration }), failureKind: failure }))
      const canFallback = !isFallback && input.entry.fallback !== undefined && !input.cooldowns.isCooled(input.entry.fallback.long)
        && (failure !== "content_filter" || input.config.fallback_on_content_filter)
      input.cooldowns.markCooled(model.long, input.config.fallback_cooldown_ms)
      if (canFallback && attemptIndex === 0 && input.entry.fallback !== undefined) {
        model = input.entry.fallback
        isFallback = true
        agent = input.entry.fallbackAgentId ?? `${input.entry.agentId}-fb`
        continue
      }
      return { slug: input.entry.slug, outcome: "error", notes: [] }
    }
    if (result.kind !== "response") return { slug: input.entry.slug, outcome: "error", notes: [] }
    const written = await writeSuccessfulNotes({ input, sessionID, model, isFallback, parts: result.parts })
    const outcome: TranscriptOutcome = written.quarantined ? "quarantined" : isFallback ? "fallback" : written.parsedCount === 0 ? "silent" : "ok"
    await input.store.appendTranscript(input.watchedID, transcript({ input, sessionID, model, outcome, result }))
    return { slug: input.entry.slug, outcome, notes: written.notes }
  }
  await input.log.error({ msg: "advisor fallback loop exhausted", advisor: input.entry.slug })
  return { slug: input.entry.slug, outcome: "error", notes: [] }
}
