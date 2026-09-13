import type { Logger } from "../log"
import type { AdvisorPluginClient } from "./client"

export async function showRuntimeWarning(client: AdvisorPluginClient, log: Logger,
  advisor: string, message: string): Promise<void> {
  await log.warn({ msg: "advisor runtime warning", advisor, message })
  try {
    const result = await client.tui.showToast({
      body: { title: "Advisor · warning", message: message.slice(0, 240), variant: "warning", duration: 8000 },
    })
    if (!result.response.ok || result.error !== undefined) {
      await log.debug({ msg: "advisor warning toast unavailable", status: result.response.status })
    }
  } catch (error) {
    const cause = error instanceof Error ? error : new TypeError("unknown warning toast failure")
    await log.debug({ msg: "advisor warning toast unavailable", error: cause })
  }
}
