import { UsageLedger } from "../usage/ledger"
import type { AdvisorPluginClient } from "./client"

export function createUsageLedger(client: AdvisorPluginClient, dataDir: string, directory: string, clock: () => number) {
  return new UsageLedger({
    dataDir, directory, clock,
    readHistory: async (sessionID, limit) => {
      const response = await client.session.messages({ path: { id: sessionID }, query: { directory, limit } })
      if (!response.response.ok || response.error !== undefined || response.data === undefined) {
        throw new Error("Advisor usage history unavailable")
      }
      return response.data.map((message) => message.info)
    },
    readMessage: async (sessionID, messageID) => {
      const response = await client.session.message?.({ path: { id: sessionID, messageID }, query: { directory } })
      return response?.response.ok && response.error === undefined ? response.data?.info : undefined
    },
  })
}
