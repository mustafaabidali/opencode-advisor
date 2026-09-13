import type { Hooks, Plugin } from "@opencode-ai/plugin"
import type { Config as SdkConfig } from "@opencode-ai/sdk"
import { join } from "node:path"

import { AdvisorRuntime } from "./advisor"
import { TaskContexts } from "./advisor/context"
import { loadConfig, resolveDataDir } from "./config"
import { Deliverer } from "./deliver"
import { createLogger } from "./log"
import { CooldownRegistry } from "./models"
import { NoteStore } from "./notes"
import { rosterFloors } from "./roster"
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
import { checkpointTool } from "./plugin/checkpoint"
import { createUsageLedger } from "./plugin/accounting"
import { processAdmission, releaseProcessAdmission } from "./advisor/admission"
import { createSessionHistory } from "./plugin/history"
import { showRuntimeWarning } from "./plugin/warnings"
import { ReviewJournal } from "./advisor/journal"
import { buildIdentity } from "./identity"
import { logStartup } from "./plugin/startup"

export type AdvisorPluginInput = Readonly<{ client: AdvisorPluginClient; directory: string }>

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
    log = dependencies.createLogger({ level: loaded.config.log_level,
      path: join(resolveDataDir(dependencies.environment), "advisor.log"),
      maxBytes: loaded.config.log_max_bytes, retention: loaded.config.log_retention })
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
    const usage = createUsageLedger(input.client, dataDir, input.directory, dependencies.clock)
    const history = createSessionHistory(input.client, input.directory, dependencies.clock)
    const contexts = new TaskContexts(store, input.directory)
    const journal = new ReviewJournal(dataDir, input.directory)
    const identity = await buildIdentity(loaded.config, dependencies.clock())
    let watcher: Watcher<unknown> | undefined
    let disposed = false
    const isWatched = (sessionID: string) => !disposed && (watcher?.isWatched(sessionID) ?? false)
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
      usage,
      history,
      journal,
      identity,
      admission: processAdmission(dataDir, loaded.config.max_concurrent_passes_per_provider),
      log,
      client: toAdvisorClient(input.client),
      directory: input.directory,
      clock: dependencies.clock,
      monotonicClock: dependencies.monotonicClock,
      timers: dependencies.timers,
      readFile: dependencies.readFile,
      onAdvisorSession: (id) => watcher?.markAdvisorSession(id),
      onResult: (sessionID, result) => disposed ? undefined : deliverer.deliver(sessionID, result.notes),
      captureReview: (sessionID, messages) => contexts.capture(sessionID, messages),
      onWarning: (advisor, message) =>
        showRuntimeWarning(input.client, log, advisor, message),
    })
    const deliverer = new Deliverer({
      config: loaded.config,
      floors: rosterFloors(roster),
      context: (sessionID) => contexts.current(sessionID),
      store,
      log,
      client: input.client,
      directory: input.directory,
      clock: dependencies.clock,
      isWatched,
      suppress: (sessionID, milliseconds) =>
        watcher?.suppress(sessionID, milliseconds),
    })
    watcher = new Watcher<unknown>({
      config: { ...loaded.config, cooldown_ms: 0 },
      dispatchOnly: true,
      log,
      clock: dependencies.clock,
      timers: dependencies.timers,
      client: toSessionClient(input.client),
      isPinned: (root) => runtime.isPinned(root),
      onForget: (root) => { runtime.forget(root); history.forget(root); contexts.forget(root); deliverer.forget(root) },
      onPass: async (sessionID, reason) => {
        if (disposed) return
        const firstUserText = watcher?.firstUserText(sessionID)
        runtime.notify(sessionID, reason, {
          ...(firstUserText === undefined ? {} : { firstUserText }),
        })
      },
    })

    await logStartup(log, identity, roster, dataDir)
    await runtime.start()
    return {
      tool: {
        advisor_checkpoint: checkpointTool({
          client: input.client, config: loaded.config, contexts, log, store, directory: input.directory,
          isWatched, history, recover: (root) => runtime.recover(root),
          onTask: async (root, task, stopped) => {
            if (!isWatched(root)) return
            if (task === "replace") { runtime.forget(root); deliverer.forget(root) }
            if (stopped) runtime.pause(root)
            else if (task === "resume") await runtime.resume(root)
          },
        }),
      },
      config: safe(log, "config", async (config) => {
        config.agent ??= {}
        const { plugin, ...sdkConfig } = config
        void plugin
        await runtime.registerAgents(sdkConfig satisfies SdkConfig)
      }),
      event: safe(log, "event", async ({ event }) => {
        if (event.type === "server.instance.disposed" && event.properties.directory === input.directory) {
          disposed = true
          watcher.dispose()
          history.clear()
          contexts.clear()
          await runtime.dispose()
          releaseProcessAdmission(dataDir, loaded.config.max_concurrent_passes_per_provider)
          for (const [resource, close] of [
            ["journal", () => journal.close()], ["usage", () => usage.close()], ["notes", () => store.close()],
          ] as const) {
            try { await close() } catch (error) {
              await log.warn({ msg: "advisor shutdown cleanup failed", resource, error }).catch(() => {})
            }
          }
          await log.close?.()
          return
        }
        if (disposed) return
        history.observe(event)
        runtime.observe(event)
        if (event.type === "message.updated") {
          const info = event.properties.info
          if (usage.tracks(info.sessionID) || (info.role === "assistant" ? info.mode : info.agent).startsWith("advisor-")) await usage.observe(info)
        }
        await watcher.handleEvent(event)
        if (event.type === "message.updated" && event.properties.info.role === "user" &&
          isWatched(event.properties.info.sessionID)) contexts.user(event.properties.info)
        await deliverer.onEvent(event)
      }),
      "chat.message": safe(log, "chat.message", async (chatInput, output) => {
        if (chatInput.agent?.startsWith("advisor-") === true) return
        deliverer.onUserMessage(output.message)
        contexts.user(output.message)
        history.message(output.message, output.parts)
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
          history.invalidate(compactingInput.sessionID)
        },
      ),
    } satisfies Hooks
  } catch (error) {
    const cause = error instanceof Error ? error : new TypeError("unknown advisor startup failure")
    await log.error({ msg: "advisor startup failed", source: "startup", error: cause })
    return {}
  }
}

export const server: Plugin = async ({ client, directory }) => {
  try {
    return await createAdvisorHooks({ client: adaptPluginClient(client), directory })
  } catch (error) {
    const cause = error instanceof Error ? error : new TypeError("unknown advisor factory failure")
    await createLogger({ level: "info" }).error({
      msg: "advisor startup failed",
      source: "factory",
      error: cause,
    })
    return {}
  }
}

export default { id: "advisor", server }
