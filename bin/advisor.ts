#!/usr/bin/env bun

import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

import { loadConfig, resolveDataDir } from "../src/config"
import { createLogger } from "../src/log"
import { NoteStore, renderCard, type Note } from "../src/notes"

const cwd = process.cwd()
const environment = process.env
const dataDir = resolveDataDir(environment)
const { config } = await loadConfig({
  home: environment["HOME"] ?? homedir(),
  cwd,
  env: environment,
  readFile: (path) => readFile(path, "utf8"),
})
const log = createLogger({ level: config.log_level, path: join(dataDir, "advisor.log") })
const store = new NoteStore({
  dataDir,
  log,
})
const command = process.argv[2]

if (command === "--version") {
  const packageJson: unknown = await Bun.file(new URL("../package.json", import.meta.url)).json()
  const version =
    typeof packageJson === "object" &&
    packageJson !== null &&
    "version" in packageJson &&
    typeof packageJson.version === "string"
      ? packageJson.version
      : "0.0.0"
  console.log(version)
} else if (command === "status") {
  let snapshot
  try {
    snapshot = await store.readState(cwd)
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    await log.warn({ msg: "ignoring corrupt state snapshot", cwd })
  }
  if (snapshot === undefined) {
    console.log("Advisor · no state for this directory")
  } else if (process.argv.includes("--json")) {
    console.log(JSON.stringify(snapshot))
  } else {
    const rows = snapshot.advisors.map((advisor) => {
      const fallback = advisor.fallback?.split("/").at(-1) ?? "-"
      return [
        advisor.slug,
        `${advisor.model_display} (${advisor.variant})`,
        fallback,
        advisor.tools.join(", "),
        String(advisor.enabled),
        advisor.cooled_until ?? "-",
        String(advisor.passes),
        String(advisor.notes),
        String(advisor.cost),
      ].join(" | ")
    })
    console.log(
      [
        "slug | model display (variant) | fallback display | tools | enabled | cooled until | passes | notes | cost",
        ...rows,
        `watched sessions | ${snapshot.watched_sessions.join(", ") || "-"}`,
        `updated_at | ${snapshot.updated_at}`,
      ].join("\n"),
    )
  }
} else if (command === "notes") {
  const lastIndex = process.argv.indexOf("--last")
  const requested = lastIndex === -1 ? undefined : Number(process.argv[lastIndex + 1])
  const last = Number.isInteger(requested) && requested !== undefined && requested >= 0 ? requested : 10
  const notes = await store.listNotes(cwd, { last })
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(notes))
  } else {
    const rows = notes.map((note) =>
      [note.time, note.severity, note.model_display, note.note.split(/\r?\n/, 1)[0] ?? ""].join(
        " | ",
      ),
    )
    console.log(["time | severity | model display | note", ...rows].join("\n"))
  }
} else if (command === undefined || (command === "--note" && process.argv[3] !== undefined)) {
  const noteID = process.argv[3]
  let notes: Note[] = []
  try {
    notes = await store.claimPending(cwd, {
      ttlMs: config.pending_ttl_ms,
      ...(noteID === undefined ? {} : { noteID }),
    })
  } catch (error) {
    // no-excuse-ok: catch - this command runs inside chat and must always exit successfully.
    await log.error({ msg: "unable to claim pending notes", error })
  }
  console.log(notes.length === 0 ? "Advisor · no pending notes" : notes.map(renderCard).join("\n\n"))
} else {
  console.error(
    "Usage: advisor [--note <id> | status [--json] | notes [--last N] [--json] | --version]",
  )
  process.exitCode = 2
}
