import type { PluginInput } from "@opencode-ai/plugin"
import { createOpencodeClient, type OpencodeClient, type Part } from "@opencode-ai/sdk/v2"
import { createHash } from "node:crypto"

import type { DeliveryClient } from "../deliver"
import { renderCard, type Note } from "../notes"

type Transport = {
  baseUrl: string
  headers: Headers
  fetch: (request: Request) => Promise<Response>
}

function isTransport(value: unknown): value is Transport {
  return typeof value === "object" && value !== null &&
    "baseUrl" in value && typeof value.baseUrl === "string" &&
    "headers" in value && value.headers instanceof Headers &&
    "fetch" in value && typeof value.fetch === "function"
}

async function connect(client: PluginInput["client"], directory: string): Promise<OpencodeClient> {
  let transport: Transport | undefined
  // The plugin's v1 SDK predates part.update. Its public request-validator hook
  // supplies resolved settings, including embedded fetch and authentication.
  // Reuse those settings for v2 rather than opening a separate network connection.
  const result = await client.session.status({
    query: { directory },
    requestValidator: async (options) => {
      if (isTransport(options)) {
        transport = { baseUrl: options.baseUrl, headers: new Headers(options.headers), fetch: options.fetch }
      }
      return options
    },
  })
  if (!result.response.ok || transport === undefined) {
    throw new Error("advisor native rendering transport is unavailable")
  }
  const resolved = transport
  const nativeFetch = Object.assign(
    (request: RequestInfo | URL, init?: RequestInit) => resolved.fetch(new Request(request, init)),
    { preconnect: globalThis.fetch.preconnect },
  )
  return createOpencodeClient({ baseUrl: resolved.baseUrl, headers: resolved.headers, fetch: nativeFetch })
}

function matches(part: Part, note: Note, output: string, digest: string): boolean {
  return part.type === "tool" && part.tool === "advisor" &&
    part.sessionID === note.root_session && part.state.status === "completed" &&
    part.state.input["noteID"] === note.id && part.state.output === output &&
    part.state.metadata["noteID"] === note.id && part.state.metadata["renderHash"] === digest
}

export function createNativeRenderer(client: PluginInput["client"]): NonNullable<DeliveryClient["renderNote"]> {
  let connection: Promise<OpencodeClient> | undefined
  type Destination = NonNullable<Awaited<ReturnType<OpencodeClient["session"]["messages"]>>["data"]>
  const batches = new WeakMap<object, Map<string, Promise<Destination>>>()
  return async ({ note, directory, canRender, batch = {} }) => {
    const api = await (connection ??= connect(client, directory).catch((error: unknown) => {
      connection = undefined
      throw error
    }))
    const scope = `${directory}\0${note.root_session}`
    let destinations = batches.get(batch)
    if (destinations === undefined) { destinations = new Map(); batches.set(batch, destinations) }
    let loading = destinations.get(scope)
    if (loading === undefined) {
      loading = (async () => {
        const response = await api.session.messages({ sessionID: note.root_session, directory })
        if (!response.response.ok || response.error !== undefined || response.data === undefined) {
          throw new Error("advisor could not inspect the card destination")
        }
        return response.data
      })()
      destinations.set(scope, loading)
    }
    try {
    const messages = await loading
    const output = renderCard(note)
    const digest = createHash("sha256").update(output).digest("hex")
    const partID = `prt_advisor_${note.id}`
    for (const message of messages) {
      const existing = message.parts.find((part) => part.id === partID)
      if (existing === undefined) continue
      if (!matches(existing, note, output, digest)) throw new Error("advisor card identity conflicts with existing content")
      return message.info.id
    }
    const anchor = messages.findLast(({ info }) =>
      info.role === "assistant" && info.time.completed !== undefined &&
      !info.agent?.startsWith("advisor-") && !info.mode?.startsWith("advisor-"),
    )
    if (anchor === undefined || !canRender()) return undefined
    const now = Date.now()
    const part: Part = {
      id: partID, sessionID: note.root_session, messageID: anchor.info.id,
      type: "tool", callID: `advisor_${note.id}`, tool: "advisor",
      state: {
        status: "completed", input: { noteID: note.id }, output, title: "Advisor",
        metadata: { noteID: note.id, renderHash: digest, transport: "native" },
        time: { start: now, end: now },
      },
    }
    const written = await api.part.update({
      sessionID: note.root_session, messageID: anchor.info.id, partID, directory, part,
    })
    if (!written.response.ok || written.error !== undefined || written.data === undefined ||
      written.data.id !== partID || written.data.messageID !== anchor.info.id ||
      !matches(written.data, note, output, digest)) {
      throw new Error("advisor native card was not acknowledged")
    }
    anchor.parts.push(written.data)
    return anchor.info.id
    } catch (error) {
      destinations.delete(scope)
      throw error
    }
  }
}
