import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { Logger } from "../src/log"
import { NoteStore, renderCard, type NoteInput, type StateSnapshot } from "../src/notes"

const temporaryDirectories: string[] = []
const cliPath = join(import.meta.dir, "..", "bin", "advisor.ts")
const silentLog: Logger = {
  debug: async () => {},
  info: async () => {},
  warn: async () => {},
  error: async () => {},
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  )
})

async function fixture(): Promise<Readonly<{ project: string; xdg: string; store: NoteStore }>> {
  const root = await mkdtemp(join(tmpdir(), "opencode-advisor-cli-"))
  temporaryDirectories.push(root)
  const projectPath = join(root, "project")
  const xdg = join(root, "data")
  await Bun.write(join(projectPath, ".keep"), "")
  const project = await realpath(projectPath)
  return {
    project,
    xdg,
    store: new NoteStore({ dataDir: join(xdg, "opencode-advisor"), log: silentLog }),
  }
}

function noteInput(cwd: string): NoteInput {
  return {
    cwd,
    root_session: "root-1",
    advisor_session: "advisor-1",
    advisor_slug: "reviewer",
    roster_name: "Private roster name",
    provider: "amazon-bedrock",
    model: "amazon-bedrock/openai.gpt-5.6-sol",
    model_display: "GPT-5.6 Sol",
    variant: "xhigh",
    severity: "concern",
    reasoning: "The result is inconsistent",
    note: "Fix the shared boundary",
    evidence: ["src/a.ts"],
    is_fallback: false,
    quarantined: false,
  }
}

function stateSnapshot(): StateSnapshot {
  return {
    advisors: [
      {
        slug: "reviewer",
        roster_name: "Reviewer",
        model: "amazon-bedrock/openai.gpt-5.6-sol",
        model_display: "GPT-5.6 Sol",
        variant: "xhigh",
        fallback: "amazon-bedrock/us.anthropic.claude-fable-5-1",
        tools: ["read", "grep", "glob"],
        enabled: true,
        cooled_until: "2026-09-10T13:00:00.000Z",
        passes: 3,
        notes: 1,
        cost: 0.42,
        last_pass_at: "2026-09-10T12:34:56.000Z",
        last_outcome: "ok",
      },
    ],
    watched_sessions: ["root-1"],
    updated_at: "2026-09-10T12:34:56.000Z",
  }
}

function runCli(project: string, xdg: string, args: readonly string[] = []) {
  return Bun.spawnSync(["bun", cliPath, ...args], {
    cwd: project,
    env: { ...process.env, XDG_DATA_HOME: xdg },
    stdout: "pipe",
    stderr: "pipe",
  })
}

describe("advisor CLI", () => {
  test("prints pending cards once and reports an empty queue on the next run", async () => {
    // Given
    const { project, xdg, store } = await fixture()
    const firstNote = await store.writeNote(noteInput(project))
    const secondStore = new NoteStore({
      dataDir: join(xdg, "opencode-advisor"),
      log: silentLog,
      clock: () => new Date(Date.parse(firstNote.time) + 1_000),
      random: () => 1 / 0x1000000,
    })
    const secondNote = await secondStore.writeNote({
      ...noteInput(project),
      severity: "nit",
      note: "Remove the duplicate branch",
    })
    await store.enqueuePending(project, [firstNote.id, secondNote.id])

    // When
    const first = runCli(project, xdg)
    const second = runCli(project, xdg)

    // Then
    expect(first.exitCode).toBe(0)
    expect(first.stdout.toString()).toBe(
      `${renderCard(firstNote)}\n\n${renderCard(secondNote)}\n`,
    )
    expect(first.stdout.toString()).not.toContain(firstNote.roster_name)
    expect(second.exitCode).toBe(0)
    expect(second.stdout.toString()).toBe("Advisor · no pending notes\n")
  })

  test("keeps the default command successful when a pending note is corrupt", async () => {
    // Given
    const { project, xdg } = await fixture()
    const dataDir = join(xdg, "opencode-advisor")
    const key = createHash("sha1").update(project).digest("hex")
    await mkdir(join(dataDir, "pending", key), { recursive: true })
    await mkdir(join(dataDir, "notes"), { recursive: true })
    await writeFile(
      join(dataDir, "pending", key, "broken.json"),
      JSON.stringify({ noteID: "broken", time: new Date().toISOString() }),
      "utf8",
    )
    await writeFile(join(dataDir, "notes", "broken.json"), "{", "utf8")

    // When
    const result = runCli(project, xdg)

    // Then
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toBe("Advisor · no pending notes\n")
  })

  test("prints the current directory state snapshot as JSON", async () => {
    // Given
    const { project, xdg, store } = await fixture()
    const snapshot = stateSnapshot()
    await store.writeState(project, snapshot)

    // When
    const result = runCli(project, xdg, ["status", "--json"])

    // Then
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout.toString())).toEqual(snapshot)
  })

  test("prints the current directory state as a readable table", async () => {
    // Given
    const { project, xdg, store } = await fixture()
    await store.writeState(project, stateSnapshot())

    // When
    const result = runCli(project, xdg, ["status"])

    // Then
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toBe(
      "slug | model display (variant) | fallback display | tools | enabled | cooled until | passes | notes | cost\n" +
        "reviewer | GPT-5.6 Sol (xhigh) | claude-fable-5-1 | read, grep, glob | true | 2026-09-10T13:00:00.000Z | 3 | 1 | 0.42\n" +
        "watched sessions | root-1\n" +
        "updated_at | 2026-09-10T12:34:56.000Z\n",
    )
  })

  test("treats corrupt state as absent without failing", async () => {
    // Given
    const { project, xdg } = await fixture()
    const stateDirectory = join(xdg, "opencode-advisor", "state")
    const key = createHash("sha1").update(project).digest("hex")
    await mkdir(stateDirectory, { recursive: true })
    await writeFile(join(stateDirectory, `${key}.json`), "{", "utf8")

    // When
    const result = runCli(project, xdg, ["status"])

    // Then
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toBe("Advisor · no state for this directory\n")
  })

  test("reports when the current directory has no state", async () => {
    // Given
    const { project, xdg } = await fixture()

    // When
    const result = runCli(project, xdg, ["status"])

    // Then
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toBe("Advisor · no state for this directory\n")
  })

  test("prints only the newest requested notes with their first line", async () => {
    // Given
    const { project, xdg } = await fixture()
    const dataDir = join(xdg, "opencode-advisor")
    await new NoteStore({
      dataDir,
      log: silentLog,
      clock: () => new Date("2026-09-10T10:00:00.000Z"),
      random: () => 0,
    }).writeNote(noteInput(project))
    await new NoteStore({
      dataDir,
      log: silentLog,
      clock: () => new Date("2026-09-10T11:00:00.000Z"),
      random: () => 1 / 0x1000000,
    }).writeNote({ ...noteInput(project), severity: "blocker", note: "Newest fix\nMore detail" })
    await new NoteStore({
      dataDir,
      log: silentLog,
      clock: () => new Date("2026-09-10T10:30:00.000Z"),
      random: () => 2 / 0x1000000,
    }).writeNote({ ...noteInput(project), severity: "nit", note: "Middle fix" })

    // When
    const result = runCli(project, xdg, ["notes", "--last", "2"])

    // Then
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toBe(
      "time | severity | model display | note\n" +
        "2026-09-10T11:00:00.000Z | blocker | GPT-5.6 Sol | Newest fix\n" +
        "2026-09-10T10:30:00.000Z | nit | GPT-5.6 Sol | Middle fix\n",
    )
  })

  test("prints notes as JSON with the default limit", async () => {
    // Given
    const { project, xdg, store } = await fixture()
    const note = await store.writeNote(noteInput(project))

    // When
    const result = runCli(project, xdg, ["notes", "--json"])

    // Then
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout.toString())).toEqual([note])
  })

  test("prints usage to stderr and exits 2 for an unknown subcommand", async () => {
    // Given
    const { project, xdg } = await fixture()

    // When
    const result = runCli(project, xdg, ["unknown"])

    // Then
    expect(result.exitCode).toBe(2)
    expect(result.stdout.toString()).toBe("")
    expect(result.stderr.toString()).toBe(
      "Usage: advisor [status [--json] | notes [--last N] [--json] | --version]\n",
    )
  })

  test("prints the package version", async () => {
    // Given
    const { project, xdg } = await fixture()
    const packageJson: unknown = JSON.parse(
      await readFile(join(import.meta.dir, "..", "package.json"), "utf8"),
    )
    const version =
      typeof packageJson === "object" &&
      packageJson !== null &&
      "version" in packageJson &&
      typeof packageJson.version === "string"
        ? packageJson.version
        : "0.0.0"

    // When
    const result = runCli(project, xdg, ["--version"])

    // Then
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toBe(`${version}\n`)
  })
})
