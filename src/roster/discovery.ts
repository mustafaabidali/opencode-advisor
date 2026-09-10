import { existsSync } from "node:fs"
import { join } from "node:path"

import type {
  DiscoveredRosterFiles,
  DiscoverRosterFilesOptions,
} from "./types"

export function discoverRosterFiles(
  options: DiscoverRosterFilesOptions,
): DiscoveredRosterFiles {
  const exists = options.exists ?? existsSync
  const yamlCandidates = [
    join(options.cwd, "WATCHDOG.yml"),
    join(options.cwd, "WATCHDOG.yaml"),
    join(options.cwd, ".opencode", "WATCHDOG.yml"),
    join(options.cwd, ".opencode", "WATCHDOG.yaml"),
    join(options.home, ".config", "opencode", "WATCHDOG.yml"),
    join(options.home, ".config", "opencode", "WATCHDOG.yaml"),
    join(options.home, ".omp", "agent", "WATCHDOG.yml"),
    join(options.home, ".omp", "agent", "WATCHDOG.yaml"),
  ]
  const markdownCandidates = [
    join(options.cwd, "WATCHDOG.md"),
    join(options.home, ".config", "opencode", "WATCHDOG.md"),
  ]
  const yml = yamlCandidates.find(exists)
  const md = markdownCandidates.filter(exists)
  return yml === undefined ? { md } : { yml, md }
}
