import type { AdvisorConfig } from "../config"
import type { SeverityFloors } from "../advice"
import type { Logger } from "../log"
import type { Note, NoteStore } from "../notes"
import type { ToastClient } from "./toast"
import type { AdviceContext } from "../policy"

type ClientResult = Readonly<{
  data: unknown
  error: unknown
  response: Pick<Response, "ok" | "status">
}>

type ShellRequest = Readonly<{
  path: Readonly<{ id: string }>
  query: Readonly<{ directory: string }>
  body: Readonly<{ agent: "advisor-delivery"; command: string }>
}>

export type DeliveryClient = Readonly<{
  renderNote?: (input: Readonly<{
    note: Note
    directory: string
    canRender: () => boolean
    batch?: object
  }>) => Promise<string | undefined>
  session: Readonly<{
    shell: (request: ShellRequest) => Promise<ClientResult>
    abort: (request: Readonly<{ path: Readonly<{ id: string }> }>) => Promise<ClientResult>
  }>
  tui: ToastClient
}>

export type DeliveryStore = Pick<NoteStore, "enqueuePending" | "markDelivered" | "removePending" | "readForDelivery" | "listFindings" | "deliveredFindingIDs">

export type DelivererOptions = Readonly<{
  config: Pick<AdvisorConfig, "toast" | "abort_on_blocker" | "note_ttl_turns" | "chat_min_severity" | "inject_min_severity" | "pending_ttl_ms">
  floors?: (advisorSlug: string) => SeverityFloors | undefined
  context?: (sessionID: string) => AdviceContext
  store: DeliveryStore
  log: Logger
  client: DeliveryClient
  directory: string
  clock: () => number
  isWatched: (sessionID: string) => boolean
  suppress: (sessionID: string, milliseconds: number) => void
}>
