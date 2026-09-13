import type { Message, Part } from "@opencode-ai/sdk"
import type { AdvisorConfig } from "../config"
import type { TranscriptMessage } from "../delta"
import type { Logger } from "../log"
import type { CooldownRegistry, ModelCatalog } from "../models"
import type { NoteStore, ReviewContext } from "../notes"
import type { AdvisorEntry } from "../roster"
import type { UsageLedger } from "../usage/ledger"
import type { ProviderAdmission } from "./admission"
import type { AdvisorStore, ApiResult, AdvisorTimers, PassResult, PromptCall, PromptResponse } from "./pass"

export type ResolvedEntry = AdvisorEntry & Readonly<{ rosterInstructions?: string; watchdogMd?: string }>
export type MessageResponse = readonly Readonly<{ info: Message; parts: readonly Part[] }>[]
export type AdvisorClient = Readonly<{
  session: Readonly<{
    create: (call: Readonly<{ query: Readonly<{ directory: string }>; body: Readonly<{ parentID: string; title: string }> }>) => Promise<ApiResult<Readonly<{ id: string }>>>
    messages: (call: Readonly<{ path: Readonly<{ id: string }>; query: Readonly<{ directory: string; limit?: number }> }>) => Promise<ApiResult<MessageResponse>>
    message?: (call: Readonly<{ path: Readonly<{ id: string; messageID: string }>; query: Readonly<{ directory: string }> }>) => Promise<ApiResult<MessageResponse[number]>>
    status?: (call: Readonly<{ query: Readonly<{ directory: string }> }>) => Promise<ApiResult<Readonly<Record<string, { type: string }>>>>
    prompt: (call: PromptCall) => Promise<ApiResult<PromptResponse>>
    abort: (call: Readonly<{ path: Readonly<{ id: string }> }>) => Promise<ApiResult<boolean>>
  }>
}>
export type AdvisorRuntimeOptions = Readonly<{
  config: AdvisorConfig
  roster: readonly ResolvedEntry[]
  catalog: ModelCatalog | (() => Promise<ModelCatalog>)
  cooldowns: CooldownRegistry
  store: AdvisorStore | NoteStore
  log: Logger
  client: AdvisorClient
  directory: string
  clock: () => number
  timers: AdvisorTimers
  readFile: (path: string) => Promise<string>
  onAdvisorSession: (id: string) => void
  onWarning: (advisorSlug: string, message: string) => void | Promise<void>
  onResult?: (root: string, result: PassResult) => void | Promise<void>
  captureReview?: (sessionID: string, messages: readonly TranscriptMessage[]) => Promise<ReviewContext>
  captureContent?: (messages: readonly TranscriptMessage[]) => Promise<string | undefined>
  monotonicClock?: () => number
  usage?: UsageLedger
  admission?: ProviderAdmission
  upstream?: import("./upstream").UpstreamFailures
  history?: import("../history/session").SessionHistory
  journal?: import("./journal").ReviewJournal
  identity?: import("../identity").BuildIdentity
}>
export type RunPassContext = Readonly<{
  firstUserText?: string
  onResult?: (result: PassResult) => void | Promise<void>
  advisorSlug?: string
  detached?: boolean
  epoch?: symbol
}>
