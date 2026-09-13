import type { Config } from "@opencode-ai/sdk"
import { ADVISOR_SYSTEM_PROMPT } from "../prompts"
import { DELIVERY_AGENT_ID, deliveryAgentConfig, toAgentConfig, toFallbackAgentConfig } from "../roster"
import type { AdvisorRuntimeOptions } from "./runtime-types"

export async function registerAgents(cfg: Config, options: AdvisorRuntimeOptions): Promise<void> {
  cfg.agent ??= {}
  const register = async (key: string, value: NonNullable<Config["agent"]>[string]) => {
    if (cfg.agent?.[key] !== undefined) {
      await options.log.warn({ msg: "advisor agent registration skipped existing key", agent: key })
    } else if (value !== undefined && cfg.agent !== undefined) cfg.agent[key] = value
  }
  for (const entry of options.roster.filter(({ enabled }) => enabled)) {
    await register(entry.agentId, toAgentConfig(entry, ADVISOR_SYSTEM_PROMPT))
    const fallback = toFallbackAgentConfig(entry, ADVISOR_SYSTEM_PROMPT)
    if (fallback !== undefined) await register(`${entry.agentId}-fb`, fallback)
  }
  await register(DELIVERY_AGENT_ID, deliveryAgentConfig())
}
