import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"

import type { AdvisorTimers, ResolvedEntry } from "../advisor"
import type { AdvisorConfig, ConfigEnvironment } from "../config"
import {
  createLogger,
  type Logger,
  type LoggerOptions,
} from "../log"
import { buildCatalog, type ModelCatalog } from "../models"
import {
  defaultRoster,
  discoverRosterFiles,
  parseRoster,
  type ParsedRoster,
} from "../roster"
import type { AdvisorPluginClient } from "./client"

export type PluginDependencies = Readonly<{
  home: string
  environment: ConfigEnvironment
  readFile: (path: string) => Promise<string>
  exists: (path: string) => boolean
  clock: () => number
  timers: AdvisorTimers
  createLogger: (options: LoggerOptions) => Logger
}>

export type PluginDependencyOverrides = Readonly<
  Partial<PluginDependencies>
>

type RosterLoadInput = Readonly<{
  config: AdvisorConfig
  directory: string
  dependencies: PluginDependencies
  log: Logger
}>

const CATALOG_TTL_MS = 10 * 60 * 1000

function createTimers(): AdvisorTimers {
  let nextID = 1
  const handles = new Map<number, ReturnType<typeof setTimeout>>()
  return {
    setTimeout: (callback, ms) => {
      const id = nextID
      nextID += 1
      const handle = setTimeout(() => {
        handles.delete(id)
        callback()
      }, ms)
      handles.set(id, handle)
      return id
    },
    clearTimeout: (timer) => {
      if (typeof timer !== "number") return
      const handle = handles.get(timer)
      if (handle === undefined) return
      clearTimeout(handle)
      handles.delete(timer)
    },
  }
}

export function resolvePluginDependencies(
  overrides: PluginDependencyOverrides = {},
): PluginDependencies {
  return {
    home: overrides.home ?? homedir(),
    environment: overrides.environment ?? process.env,
    readFile:
      overrides.readFile ?? ((path: string) => readFile(path, "utf8")),
    exists: overrides.exists ?? existsSync,
    clock: overrides.clock ?? Date.now,
    timers: overrides.timers ?? createTimers(),
    createLogger: overrides.createLogger ?? createLogger,
  }
}

async function readWatchdogMarkdown(
  paths: readonly string[],
  dependencies: PluginDependencies,
  log: Logger,
): Promise<string | undefined> {
  const contents: string[] = []
  for (const path of paths) {
    try {
      contents.push(await dependencies.readFile(path))
    } catch (error) {
      const cause =
        error instanceof Error
          ? error
          : new TypeError("unknown WATCHDOG.md read failure")
      await log.warn({
        msg: "advisor startup warning",
        source: "roster",
        path,
        error: cause,
      })
    }
  }
  return contents.length === 0 ? undefined : contents.join("\n\n")
}

export async function loadResolvedRoster({
  config,
  directory,
  dependencies,
  log,
}: RosterLoadInput): Promise<readonly ResolvedEntry[]> {
  const files = discoverRosterFiles({
    cwd: directory,
    home: dependencies.home,
    exists: dependencies.exists,
  })
  let parsed: ParsedRoster
  if (files.yml === undefined) {
    parsed = defaultRoster(config)
  } else {
    try {
      parsed = parseRoster(await dependencies.readFile(files.yml), config)
    } catch (error) {
      const cause =
        error instanceof Error
          ? error
          : new TypeError("unknown WATCHDOG roster read failure")
      await log.warn({
        msg: "advisor startup warning",
        source: "roster",
        path: files.yml,
        error: cause,
      })
      parsed = defaultRoster(config)
    }
  }

  for (const warning of parsed.warnings) {
    await log.warn({ msg: "advisor startup warning", source: "roster", warning })
  }
  if (parsed.advisors.length === 0) parsed = defaultRoster(config)
  const watchdogMd = await readWatchdogMarkdown(files.md, dependencies, log)
  return parsed.advisors.map((entry) => ({
    ...entry,
    ...(parsed.instructions === undefined
      ? {}
      : { rosterInstructions: parsed.instructions }),
    ...(watchdogMd === undefined ? {} : { watchdogMd }),
  }))
}

export function createCatalogLoader(
  client: AdvisorPluginClient,
  directory: string,
  log: Logger,
  clock: () => number,
): () => Promise<ModelCatalog> {
  let cached:
    | Readonly<{ catalog: ModelCatalog; expiresAt: number }>
    | undefined
  return async () => {
    const now = clock()
    if (cached !== undefined && cached.expiresAt > now) return cached.catalog
    let catalog: ModelCatalog
    try {
      const result = await client.providers({ query: { directory } })
      if (
        result.error !== undefined ||
        result.data === undefined ||
        (result.response?.status ?? 200) >= 400
      ) {
        await log.warn({
          msg: "advisor provider catalog unavailable",
          source: "catalog",
          status: result.response?.status,
          error: result.error,
        })
        catalog = new Map()
      } else {
        catalog = buildCatalog(result.data)
      }
    } catch (error) {
      const cause =
        error instanceof Error
          ? error
          : new TypeError("unknown provider catalog failure")
      await log.warn({
        msg: "advisor provider catalog unavailable",
        source: "catalog",
        error: cause,
      })
      catalog = new Map()
    }
    cached = { catalog, expiresAt: now + CATALOG_TTL_MS }
    return catalog
  }
}
