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
const log = createLogger({ level: config.log_level, path: join(dataDir, "advisor.log"),
  maxBytes: config.log_max_bytes, retention: config.log_retention })
const store = new NoteStore({
  dataDir,
  log,
})
const command = process.argv[2]

try {
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
        ...(snapshot.build === undefined ? [] : [
          `build | ${snapshot.build.version} ${snapshot.build.fingerprint}; instance ${snapshot.build.instance_id}`,
          `provider admission | ${snapshot.build.admission_scope}; limit ${snapshot.build.max_concurrent_passes_per_provider || "unlimited"}`,
        ]),
        ...(snapshot.execution ?? []).map((lane) => `reviewer | ${lane.advisor_slug}; ${lane.root_session}; ${lane.state}`),
        ...(snapshot.accounting === undefined ? ["usage coverage | legacy snapshot only; totals exclude unobserved steps"] : [
          `usage coverage | ${snapshot.accounting.coverage}; ${snapshot.accounting.messages} assistant messages; ${snapshot.accounting.unattributed} unattributed; ${snapshot.accounting.unknown_usage} with unknown usage`,
          `compaction usage | ${snapshot.accounting.summary_messages} messages; estimated cost ${snapshot.accounting.summary_cost}`,
          "usage scope | durable observed usage; legacy transcripts excluded; pass/note counters are per instance",
        ]),
      ].join("\n"),
    )
  }
} else if (command === "notes") {
  const lastIndex = process.argv.indexOf("--last")
  const requested = lastIndex === -1 ? undefined : Number(process.argv[lastIndex + 1])
  const last = Number.isInteger(requested) && requested !== undefined && requested >= 0 ? requested : 10
  const notes = await store.listNotes(cwd, { last })
  const coverage = await store.catalogStatus()
  if (!coverage.complete) console.error("Advisor note index is incomplete; run `advisor index --all` to include the remaining legacy files.")
  if (coverage.unavailable > 0) console.error(`Advisor note index: ${coverage.unavailable} unavailable legacy report files.`)
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
} else if (command === "index") {
  let coverage = await store.backfillNotes()
  while (process.argv.includes("--all") && !coverage.complete) coverage = await store.backfillNotes()
  console.log(JSON.stringify(coverage))
} else if (command === "repair-receipts") {
  console.log(JSON.stringify(await store.repairReceipts()))
} else if (command === "--note" && process.argv[3] !== undefined) {
  const noteID = process.argv[3]
  try {
    const result = await store.readForDelivery(cwd, noteID, config.pending_ttl_ms)
    if (result.status === "ready") {
      await store.claimPending(cwd, { ttlMs: config.pending_ttl_ms, noteID })
      console.log(renderCard(result.note))
    }
    else {
      console.log(`Advisor · ${result.status} note ${noteID}`)
      process.exitCode = result.status === "expired" ? 3 : 4
    }
  } catch (error) {
    await log.error({ msg: "unable to render note", noteID, error })
    console.error("Advisor · unable to render note; see advisor log")
    process.exitCode = 1
  }
} else if (command === undefined) {
  let notes: Note[] = []
  try {
    notes = await store.claimPending(cwd, {
      ttlMs: config.pending_ttl_ms,
    })
  } catch (error) {
    // no-excuse-ok: catch - this command runs inside chat and must always exit successfully.
    await log.error({ msg: "unable to claim pending notes", error })
  }
  console.log(notes.length === 0 ? "Advisor · no pending notes" : notes.map(renderCard).join("\n\n"))
} else {
  console.error(
    "Usage: advisor [--note <id> | status [--json] | notes [--last N] [--json] | index [--all] | repair-receipts | --version]",
  )
  process.exitCode = 2
}
} finally { await store.close(); await log.close?.() }
