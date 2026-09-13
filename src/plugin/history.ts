import { SessionHistory } from "../history/session"
import type { AdvisorPluginClient } from "./client"

export function createSessionHistory(client: AdvisorPluginClient, directory: string, clock: () => number) {
  return new SessionHistory({
    clock,
    read: async (sessionID) => {
      const result = await client.session.messages({ path: { id: sessionID }, query: { directory } })
      if (!result.response.ok || result.error !== undefined || result.data === undefined) {
        throw new Error("Could not read the current advisor session history")
      }
      return result.data
    },
    ...(client.session.message === undefined ? {} : { message: async (sessionID: string, messageID: string) => {
      const result = await client.session.message?.({ path: { id: sessionID, messageID }, query: { directory } })
      return result?.response.ok && result.error === undefined ? result.data : undefined
    } }),
  })
}
