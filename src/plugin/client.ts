import type { PluginInput } from "@opencode-ai/plugin"
import type {
  Message,
  Part,
  Session,
  SessionGetError,
} from "@opencode-ai/sdk"

import type { AdvisorClient } from "../advisor"
import type { PromptResponse } from "../advisor/pass"
import type { DeliveryClient } from "../deliver"
import type { buildCatalog } from "../models"
import type { SessionClient } from "../watcher"

type ProviderRequest = Readonly<{
  query: Readonly<{ directory: string }>
}>

type ProviderData = Parameters<typeof buildCatalog>[0]

type ClientResult<Data, ErrorType = unknown> = Readonly<{
  data: Data | undefined
  error: ErrorType | undefined
  response: Pick<Response, "ok" | "status">
}>

type ProviderResult = ClientResult<ProviderData>
type ProviderMethod = (request: ProviderRequest) => Promise<ProviderResult>

type LegacyProviderClient = Readonly<{
  providers: ProviderMethod
}>

type MessageResponse = readonly Readonly<{
  info: Message
  parts: readonly Part[]
}>[]

export type AdvisorPluginClient = Readonly<{
  session: Readonly<{
    create: (
      call: Parameters<AdvisorClient["session"]["create"]>[0],
    ) => Promise<ClientResult<Readonly<{ id: string }>>>
    messages: (
      call: Parameters<AdvisorClient["session"]["messages"]>[0],
    ) => Promise<ClientResult<MessageResponse>>
    prompt: (
      call: Parameters<AdvisorClient["session"]["prompt"]>[0],
    ) => Promise<ClientResult<PromptResponse>>
    abort: (
      call: Parameters<AdvisorClient["session"]["abort"]>[0],
    ) => Promise<ClientResult<boolean>>
    shell: (
      call: Parameters<DeliveryClient["session"]["shell"]>[0],
    ) => Promise<ClientResult<unknown>>
    get: (
      call: Parameters<SessionClient["session"]["get"]>[0],
    ) => Promise<ClientResult<Session, SessionGetError>>
  }>
  tui: Readonly<{
    showToast: (
      call: Parameters<DeliveryClient["tui"]["showToast"]>[0],
    ) => Promise<ClientResult<unknown>>
  }>
  providers: ProviderMethod
}>

function hasLegacyProviders(
  client: PluginInput["client"],
): client is PluginInput["client"] & LegacyProviderClient {
  return "providers" in client && typeof client.providers === "function"
}

type SdkResult<Data, ErrorType = unknown> = Readonly<{
  data: Data | undefined
  error: ErrorType | undefined
  response: Response
}>

function normalizeClientResult<Data, ErrorType>(
  result: SdkResult<Data, ErrorType>,
): ClientResult<Data, ErrorType> {
  return {
    data: result.data,
    error: result.error,
    response: result.response,
  }
}

type OptionalResult<Data, ErrorType = unknown> = Readonly<{
  data?: Data
  error?: ErrorType
  response: Readonly<{ status: number }>
}>

function optionalResult<Data, ErrorType>(
  result: ClientResult<Data, ErrorType>,
): OptionalResult<Data, ErrorType> {
  return {
    ...(result.data === undefined ? {} : { data: result.data }),
    ...(result.error === undefined ? {} : { error: result.error }),
    response: { status: result.response.status },
  }
}

export function adaptPluginClient(
  client: PluginInput["client"],
): AdvisorPluginClient {
  return {
    session: {
      create: async (call) =>
        normalizeClientResult(
          await client.session.create({
            query: { directory: call.query.directory },
            body: { parentID: call.body.parentID, title: call.body.title },
          }),
        ),
      messages: async (call) =>
        normalizeClientResult(
          await client.session.messages({
            path: { id: call.path.id },
            query: { directory: call.query.directory },
          }),
        ),
      prompt: async (call) =>
        normalizeClientResult(
          await client.session.prompt({
            path: { id: call.path.id },
            query: { directory: call.query.directory },
            body: {
              agent: call.body.agent,
              model: {
                providerID: call.body.model.providerID,
                modelID: call.body.model.modelID,
              },
              parts: call.body.parts.map((part) => ({
                type: part.type,
                text: part.text,
              })),
            },
          }),
        ),
      abort: async (call) =>
        normalizeClientResult(
          await client.session.abort({ path: { id: call.path.id } }),
        ),
      shell: async (call) =>
        normalizeClientResult(
          await client.session.shell({
            path: { id: call.path.id },
            query: { directory: call.query.directory },
            body: { agent: call.body.agent, command: call.body.command },
          }),
        ),
      get: async (call) =>
        normalizeClientResult(
          await client.session.get({ path: { id: call.path.id } }),
        ),
    },
    tui: {
      showToast: async (call) =>
        normalizeClientResult(
          await client.tui.showToast({ body: { ...call.body } }),
        ),
    },
    providers: async (call) => {
      if (hasLegacyProviders(client)) return client.providers(call)
      return normalizeClientResult(
        await client.config.providers({
          query: { directory: call.query.directory },
        }),
      )
    },
  }
}

export function toAdvisorClient(client: AdvisorPluginClient): AdvisorClient {
  return {
    session: {
      create: async (call) => optionalResult(await client.session.create(call)),
      messages: async (call) =>
        optionalResult(await client.session.messages(call)),
      prompt: async (call) => optionalResult(await client.session.prompt(call)),
      abort: async (call) => optionalResult(await client.session.abort(call)),
    },
  }
}

export function toSessionClient(client: AdvisorPluginClient): SessionClient {
  return {
    session: {
      get: async (call) => optionalResult(await client.session.get(call)),
    },
  }
}
