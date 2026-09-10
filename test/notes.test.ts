import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { Logger } from "../src/log"
import {
  NoteStore,
  renderCard,
  type Note,
  type NoteInput,
  type StateSnapshot,
  type TranscriptRecord,
} from "../src/notes"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  )
})

async function temporaryDataDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "opencode-advisor-notes-"))
  temporaryDirectories.push(directory)
  return directory
}

function cwdKey(cwd: string): string {
  return createHash("sha1").update(cwd).digest("hex")
}

function noteInput(overrides: Partial<NoteInput> = {}): NoteInput {
  return {
    cwd: "/workspace/project",
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
    evidence: ["src/a.ts", "test/a.test.ts"],
    is_fallback: false,
    quarantined: false,
    ...overrides,
  }
}

function fixedStore(
  dataDir: string,
  options: Readonly<{
    time?: string
    random?: number
    logs?: string[]
  }> = {},
): NoteStore {
  const logs = options.logs ?? []
  const log: Logger = {
    debug: async ({ msg }) => {
      logs.push(msg)
    },
    info: async ({ msg }) => {
      logs.push(msg)
    },
    warn: async ({ msg }) => {
      logs.push(msg)
    },
    error: async ({ msg }) => {
      logs.push(msg)
    },
  }
  return new NoteStore({
    dataDir,
    log,
    clock: () => new Date(options.time ?? "2026-09-10T12:34:56.000Z"),
    random: () => options.random ?? 0xabcdef / 0x1000000,
  })
}

describe("NoteStore notes", () => {
  test("persists the exact note schema with a deterministic id and redaction", async () => {
    // Given
    const dataDir = await temporaryDataDir()
    const store = fixedStore(dataDir)

    // When
    const note = await store.writeNote(
      noteInput({
        reasoning: "Bearer abcdefghijklmnop1234 exposed",
        note: "key 123e4567-e89b-12d3-a456-426614174000",
      }),
    )

    // Then
    expect(note.id).toBe("20260910-123456-abcdef")
    const persisted: unknown = JSON.parse(
      await readFile(join(dataDir, "notes", `${note.id}.json`), "utf8"),
    )
    expect(persisted).toEqual({
      ...noteInput({
        reasoning: "[REDACTED] exposed",
        note: "key [REDACTED]",
      }),
      id: "20260910-123456-abcdef",
      time: "2026-09-10T12:34:56.000Z",
    })
  })

  test("marks multiple notes delivered without deleting them", async () => {
    // Given
    const dataDir = await temporaryDataDir()
    const store = fixedStore(dataDir)
    const first = await store.writeNote(noteInput())
    const second = await fixedStore(dataDir, { random: 1 / 0x1000000 }).writeNote(
      noteInput(),
    )

    // When
    await store.markDelivered([first.id, second.id], "2026-09-10T13:00:00.000Z")

    // Then
    const listed = await store.listNotes("/workspace/project", { last: 10 })
    expect(listed).toHaveLength(2)
    expect(listed.every((note) => note.delivered_at === "2026-09-10T13:00:00.000Z")).toBe(
      true,
    )
  })

  test("lists only the requested cwd and limits newest notes", async () => {
    // Given
    const dataDir = await temporaryDataDir()
    await fixedStore(dataDir, { time: "2026-09-10T12:00:00.000Z" }).writeNote(
      noteInput({ note: "old" }),
    )
    await fixedStore(dataDir, {
      time: "2026-09-10T13:00:00.000Z",
      random: 1 / 0x1000000,
    }).writeNote(noteInput({ note: "new" }))
    await fixedStore(dataDir, {
      time: "2026-09-10T14:00:00.000Z",
      random: 2 / 0x1000000,
    }).writeNote(noteInput({ cwd: "/other", note: "unrelated" }))

    // When
    const notes = await fixedStore(dataDir).listNotes("/workspace/project", { last: 1 })

    // Then
    expect(notes.map(({ note }) => note)).toEqual(["new"])
  })
})

describe("NoteStore pending queue", () => {
  test("enqueues and atomically claims notes in FIFO order", async () => {
    // Given
    const dataDir = await temporaryDataDir()
    const firstStore = fixedStore(dataDir, { time: "2026-09-10T12:00:00.000Z" })
    const first = await firstStore.writeNote(noteInput())
    const secondStore = fixedStore(dataDir, {
      time: "2026-09-10T12:01:00.000Z",
      random: 1 / 0x1000000,
    })
    const second = await secondStore.writeNote(noteInput())
    await firstStore.enqueuePending("/workspace/project", [first.id])
    await secondStore.enqueuePending("/workspace/project", [second.id])

    // When
    const claimed = await secondStore.claimPending("/workspace/project", {
      ttlMs: 600_000,
    })

    // Then
    expect(claimed.map(({ id }) => id)).toEqual([first.id, second.id])
    expect(
      (await readdir(join(dataDir, "claimed", cwdKey("/workspace/project")))).sort(),
    ).toEqual([`${first.id}.json`, `${second.id}.json`].sort())
    expect(
      await readdir(join(dataDir, "pending", cwdKey("/workspace/project"))),
    ).toEqual([])
  })

  test("does not return a note whose pointer another claimant already renamed", async () => {
    // Given
    const dataDir = await temporaryDataDir()
    const store = fixedStore(dataDir)
    const note = await store.writeNote(noteInput())
    await store.enqueuePending("/workspace/project", [note.id])
    const key = cwdKey("/workspace/project")
    await mkdir(join(dataDir, "claimed", key), { recursive: true })
    await rename(
      join(dataDir, "pending", key, `${note.id}.json`),
      join(dataDir, "claimed", key, `${note.id}.json`),
    )

    // When
    const claimed = await store.claimPending("/workspace/project", { ttlMs: 600_000 })

    // Then
    expect(claimed).toEqual([])
  })

  test("discards stale pointers and records a log line", async () => {
    // Given
    const dataDir = await temporaryDataDir()
    const logs: string[] = []
    const oldStore = fixedStore(dataDir, { time: "2026-09-10T12:00:00.000Z" })
    const note = await oldStore.writeNote(noteInput())
    await oldStore.enqueuePending("/workspace/project", [note.id])
    const store = fixedStore(dataDir, {
      time: "2026-09-10T12:20:00.000Z",
      logs,
    })

    // When
    const claimed = await store.claimPending("/workspace/project", { ttlMs: 600_000 })

    // Then
    expect(claimed).toEqual([])
    expect(logs).toContain("discarding stale pending pointer")
    expect(
      await readdir(join(dataDir, "pending", cwdKey("/workspace/project"))),
    ).toEqual([])
  })

  test("walks parent directories before falling back to the newest queue", async () => {
    // Given
    const dataDir = await temporaryDataDir()
    const parentStore = fixedStore(dataDir, { time: "2026-09-10T12:00:00.000Z" })
    const parentNote = await parentStore.writeNote(noteInput({ cwd: "/workspace" }))
    await parentStore.enqueuePending("/workspace", [parentNote.id])
    const newestStore = fixedStore(dataDir, {
      time: "2026-09-10T12:01:00.000Z",
      random: 1 / 0x1000000,
    })
    const newest = await newestStore.writeNote(noteInput({ cwd: "/unrelated" }))
    await newestStore.enqueuePending("/unrelated", [newest.id])

    // When
    const parentClaim = await newestStore.claimPending("/workspace/project/src", {
      ttlMs: 600_000,
    })
    const fallbackClaim = await newestStore.claimPending("/missing", { ttlMs: 600_000 })

    // Then
    expect(parentClaim.map(({ id }) => id)).toEqual([parentNote.id])
    expect(fallbackClaim.map(({ id }) => id)).toEqual([newest.id])
  })

  test("removes selected pending pointers", async () => {
    // Given
    const dataDir = await temporaryDataDir()
    const store = fixedStore(dataDir)
    const note = await store.writeNote(noteInput())
    await store.enqueuePending("/workspace/project", [note.id])

    // When
    await store.removePending("/workspace/project", [note.id])

    // Then
    expect(
      await readdir(join(dataDir, "pending", cwdKey("/workspace/project"))),
    ).toEqual([])
  })

  test("skips, logs, and removes corrupt pointer JSON", async () => {
    // Given
    const dataDir = await temporaryDataDir()
    const logs: string[] = []
    const key = cwdKey("/workspace/project")
    await mkdir(join(dataDir, "pending", key), { recursive: true })
    await writeFile(join(dataDir, "pending", key, "broken.json"), "{", "utf8")
    const store = fixedStore(dataDir, { logs })

    // When
    const claimed = await store.claimPending("/workspace/project", { ttlMs: 600_000 })

    // Then
    expect(claimed).toEqual([])
    expect(logs).toContain("discarding corrupt pending pointer")
    expect(await readdir(join(dataDir, "pending", key))).toEqual([])
  })
})

describe("renderCard", () => {
  test("renders the exact card with one display model mention and no private ids", () => {
    // Given
    const note: Note = {
      ...noteInput({ is_fallback: true, variant: "max" }),
      id: "20260910-123456-abcdef",
      time: "2026-09-10T12:34:56.000Z",
    }

    // When
    const card = renderCard(note)

    // Then
    expect(card).toBe(
      "Advisor · GPT-5.6 Sol (max) · concern · fallback\n" +
        "reasoning: The result is inconsistent\n" +
        "note: Fix the shared boundary\n" +
        "evidence: src/a.ts, test/a.test.ts",
    )
    expect(card.match(/GPT-5\.6 Sol/g)).toHaveLength(1)
    expect(card).not.toContain(note.roster_name)
    expect(card).not.toContain(note.model)
  })

  test("omits the evidence line when evidence is empty", () => {
    // Given
    const note: Note = {
      ...noteInput({ evidence: [] }),
      id: "20260910-123456-abcdef",
      time: "2026-09-10T12:34:56.000Z",
    }

    // When
    const card = renderCard(note)

    // Then
    expect(card).toBe(
      "Advisor · GPT-5.6 Sol (xhigh) · concern\n" +
        "reasoning: The result is inconsistent\n" +
        "note: Fix the shared boundary",
    )
  })
})

describe("NoteStore recorders", () => {
  test("appends one canonical transcript JSON line per attempt", async () => {
    // Given
    const dataDir = await temporaryDataDir()
    const store = fixedStore(dataDir)
    const record: TranscriptRecord = {
      time: "2026-09-10T12:34:56.000Z",
      root_session: "root-1",
      advisor_session: "advisor-1",
      roster_name: "Reviewer",
      model: "amazon-bedrock/openai.gpt-5.6-sol",
      variant: "xhigh",
      tokens: { input: 10, output: 20, reasoning: 5, cache: { read: 2, write: 1 } },
      cost: 0.25,
      duration_ms: 1234,
      outcome: "fallback",
      failure_kind: "content_filter",
    }

    // When
    await store.appendTranscript("root-1", record)

    // Then
    const lines = (
      await readFile(join(dataDir, "transcripts", "root-1.jsonl"), "utf8")
    )
      .trimEnd()
      .split("\n")
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0] ?? "")).toEqual(record)
  })

  test("round trips the state snapshot keyed by cwd", async () => {
    // Given
    const dataDir = await temporaryDataDir()
    const store = fixedStore(dataDir)
    const snapshot: StateSnapshot = {
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

    // When
    await store.writeState("/workspace/project", snapshot)

    // Then
    expect(await store.readState("/workspace/project")).toEqual(snapshot)
  })

  test("returns undefined when no state snapshot exists", async () => {
    // Given
    const store = fixedStore(await temporaryDataDir())

    // When
    const snapshot = await store.readState("/workspace/project")

    // Then
    expect(snapshot).toBeUndefined()
  })
})
