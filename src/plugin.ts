import type { Hooks, Plugin } from "@opencode-ai/plugin"
import type { Config as SdkConfig } from "@opencode-ai/sdk"

import packageMetadata from "../package.json" with { type: "json" }
import { AdvisorRuntime } from "./advisor"
import { loadConfig, resolveDataDir } from "./config"
import { Deliverer } from "./deliver"
import { createLogger, type Logger } from "./log"
import { CooldownRegistry, displayName } from "./models"
import { NoteStore } from "./notes"
import {
  adaptPluginClient,
  toAdvisorClient,
  toSessionClient,
  type AdvisorPluginClient,
} from "./plugin/client"
import {
  createCatalogLoader,
  loadResolvedRoster,
  resolvePluginDependencies,
  type PluginDependencyOverrides,
} from "./plugin/support"
import { safe } from "./safe"
import { Watcher } from "./watcher"

export type AdvisorPluginInput = Readonly<{
  client: AdvisorPluginClient
  directory: string
}>

async function showRuntimeWarning(
  client: AdvisorPluginClient,
  log: Logger,
  advisor: string,
  message: string,
): Promise<void> {
  await log.warn({ msg: "advisor runtime warning", advisor, message })
  try {
    const result = await client.tui.showToast({
      body: {
        title: "Advisor · warning",
        message: message.slice(0, 240),
        variant: "warning",
        duration: 8000,
      },
    })
    if (!result.response.ok || result.error !== undefined) {
      await log.debug({
        msg: "advisor warning toast unavailable",
        status: result.response.status,
      })
    }
  } catch (error) {
    const cause =
      error instanceof Error
        ? error
        : new TypeError("unknown warning toast failure")
    await log.debug({ msg: "advisor warning toast unavailable", error: cause })
  }
}

export async function createAdvisorHooks(
  input: AdvisorPluginInput,
  overrides: PluginDependencyOverrides = {},
): Promise<Hooks> {
  const dependencies = resolvePluginDependencies(overrides)
  let log = dependencies.createLogger({ level: "info" })
  try {
    const loaded = await loadConfig({
      home: dependencies.home,
      cwd: input.directory,
      env: dependencies.environment,
      readFile: dependencies.readFile,
    })
    log = dependencies.createLogger({ level: loaded.config.log_level })
    for (const warning of loaded.warnings) {
      await log.warn({
        msg: "advisor startup warning",
        source: "config",
        warning,
      })
    }
    if (!loaded.config.enabled) {
      await log.info({ msg: "advisor disabled" })
      return {}
    }

    const roster = await loadResolvedRoster({
      config: loaded.config,
      directory: input.directory,
      dependencies,
      log,
    })
    const dataDir = resolveDataDir(dependencies.environment)
    const store = new NoteStore({
      dataDir,
      log,
      clock: () => new Date(dependencies.clock()),
    })
    const cooldowns = new CooldownRegistry(dependencies.clock)
    let watcher: Watcher<unknown> | undefined
    const runtime = new AdvisorRuntime({
      config: loaded.config,
      roster,
      catalog: createCatalogLoader(
        input.client,
        input.directory,
        log,
        dependencies.clock,
      ),
      cooldowns,
      store,
      log,
      client: toAdvisorClient(input.client),
      directory: input.directory,
      clock: dependencies.clock,
      timers: dependencies.timers,
      readFile: dependencies.readFile,
      onAdvisorSession: (id) => watcher?.markAdvisorSession(id),
      onWarning: (advisor, message) =>
        showRuntimeWarning(input.client, log, advisor, message),
    })
    const deliverer = new Deliverer({
      config: loaded.config,
      store,
      log,
      client: input.client,
      directory: input.directory,
      clock: dependencies.clock,
      isWatched: (sessionID) => watcher?.isWatched(sessionID) ?? false,
      suppress: (sessionID, milliseconds) =>
        watcher?.suppress(sessionID, milliseconds),
    })
    watcher = new Watcher<unknown>({
      config: loaded.config,
      log,
      clock: dependencies.clock,
      timers: dependencies.timers,
      client: toSessionClient(input.client),
      onPass: async (sessionID, reason) => {
        const firstUserText = watcher?.firstUserText(sessionID)
        const results = await runtime.runPass(sessionID, reason, {
          ...(firstUserText === undefined ? {} : { firstUserText }),
        })
        await deliverer.deliver(
          sessionID,
          results.flatMap((result) => result.notes),
        )
      },
    })

    await log.info({
      msg: "advisor started",
      version: packageMetadata.version,
      rosterSize: roster.length,
      advisors: roster.map((entry) => ({
        id: entry.agentId,
        model: displayName(entry.model, new Map()),
      })),
      dataDir,
    })

    return {
      config: safe(log, "config", async (config) => {
        config.agent ??= {}
        const { plugin, ...sdkConfig } = config
        void plugin
        await runtime.registerAgents(sdkConfig satisfies SdkConfig)
      }),
      event: safe(log, "event", async ({ event }) => {
        await deliverer.onEvent(event)
        await watcher.handleEvent(event)
      }),
      "chat.message": safe(log, "chat.message", async (chatInput, output) => {
        if (chatInput.agent?.startsWith("advisor-") === true) return
        watcher.handleChatMessage(chatInput, output)
      }),
      "experimental.chat.messages.transform": safe(
        log,
        "experimental.chat.messages.transform",
        async (_transformInput, output) => {
          await deliverer.messagesTransform(output)
        },
      ),
      "experimental.chat.system.transform": safe(
        log,
        "experimental.chat.system.transform",
        async (transformInput, output) => {
          await deliverer.systemTransform(transformInput, output)
        },
      ),
      "experimental.session.compacting": safe(
        log,
        "experimental.session.compacting",
        async (compactingInput) => {
          deliverer.markCompacting(compactingInput.sessionID)
        },
      ),
    } satisfies Hooks
  } catch (error) {
    const cause =
      error instanceof Error ? error : new TypeError("unknown advisor startup failure")
    await log.error({ msg: "advisor startup failed", source: "startup", error: cause })
    return {}
  }
}

export const server: Plugin = async ({ client, directory }) => {
  try {
    return await createAdvisorHooks({
      client: adaptPluginClient(client),
      directory,
    })
  } catch (error) {
    const cause =
      error instanceof Error ? error : new TypeError("unknown advisor factory failure")
    await createLogger({ level: "info" }).error({
      msg: "advisor startup failed",
      source: "factory",
      error: cause,
    })
    return {}
  }
}

export default { id: "advisor", server }
