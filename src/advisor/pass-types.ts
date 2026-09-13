import type { AssistantMessage, Part } from "@opencode-ai/sdk"
import type { AdvisorConfig } from "../config"
import type { Logger } from "../log"
import type { CooldownRegistry, ModelCatalog, ModelRef } from "../models"
import type { Note, NoteInput, TranscriptOutcome, TranscriptRecord } from "../notes"
import type { AdvisorEntry } from "../roster"
import type { Lifetime } from "./lifetime"
import type { UsageLedger } from "../usage/ledger"
import type { ProviderAdmission } from "./admission"

export type ApiResult<Data> = Readonly<{
  data?: Data
  error?: unknown
  response?: Readonly<{ status: number }>
}>

export type PromptResponse = Readonly<{ info: AssistantMessage; parts: readonly Part[] }> | AssistantMessage

export type PromptCall = Readonly<{
  signal?: AbortSignal
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
  recoverNote?: (input: NoteInput) => Promise<Note | undefined>
  listFindings?: import("../notes").NoteStore["listFindings"]
  readNotes?: import("../notes").NoteStore["readNotes"]
  readTask?: import("../notes").NoteStore["readTask"]
  appendTranscript: (rootSession: string, record: TranscriptRecord) => Promise<void>
  writeState: import("../notes").NoteStore["writeState"]
}>

export type PassResult = Readonly<{
  slug: string
  outcome: TranscriptOutcome
  notes: readonly Note[]
  cancellation?: "not_sent" | "cancelled_confirmed" | "cancellation_uncertain"
  pending?: Promise<PassResult | undefined>
  persistence?: "pending" | "recovery_required"
  reconcile?: () => Promise<PassResult | undefined>
  context?: Readonly<{ model: string; tokens: number }>
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

export type AttemptResult =
  | Readonly<{ kind: "response"; info: AssistantMessage; parts: readonly Part[]; duration: number }>
  | Readonly<{ kind: "failure"; error: unknown; duration: number; notSent?: boolean }>
  | Readonly<{ kind: "timeout"; duration: number; cancellation: "not_sent" | "cancelled_confirmed" | "cancellation_uncertain"; pending: Promise<ApiResult<PromptResponse>>;
      reconcile?: () => Promise<ApiResult<PromptResponse> | true | undefined>; failure?: import("../models").FailureKind }>
export type AttemptInput = Readonly<{ input: ExecutePassInput; sessionID: string; model: ModelRef; agent: string }>
export type TranscriptInput = Readonly<{ input: ExecutePassInput; sessionID: string; model: ModelRef; outcome: TranscriptOutcome; result?: Extract<AttemptResult, { kind: "response" }>; duration?: number; failureKind?: TranscriptRecord["failure_kind"] }>
export type NoteWriteInput = Readonly<{ input: ExecutePassInput; sessionID: string; model: ModelRef; isFallback: boolean; parts: readonly Part[]; verify?: boolean; repair?: boolean }>

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
    messages?: import("./runtime-types").AdvisorClient["session"]["messages"]
  }>
  directory: string
  watchedID: string
  advisorSession: string
  prompt: (sessionID: string) => string
  clock: () => number
  timers: AdvisorTimers
  refreshSession: () => Promise<string>
  onWarning: (slug: string, message: string) => void | Promise<void>
  lifetime?: Lifetime
  usage?: UsageLedger
  passID?: string
  acceptResult?: () => boolean
  admission?: ProviderAdmission
  upstream?: import("./upstream").UpstreamFailures
  beforeDispatch?: (sessionID: string, model: ModelRef, agent: string, started: number) => Promise<void>
  onPhase?: (phase: "queued" | "preparing" | "running" | "persisting") => void
}>
