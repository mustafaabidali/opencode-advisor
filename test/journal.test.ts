import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ReviewJournal } from "../src/advisor/journal"
import { FindingStore } from "../src/notes/findings"

test("settling an old pending pass cannot transfer its cursor or content baseline to a new configuration", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "advisor-journal-content-"))
  const journal = new ReviewJournal(dataDir, "/project")
  const first = journal.lane("root", "reviewer", { instructions: "Old review contract" })
  const second = journal.lane("root", "reviewer", { instructions: "New review contract" })
  try {
    expect(await first.load()).toBe(true)
    const pending = { id: "pass-1", child: "child", model: "fixture/model", agent: "reviewer",
      started_at: 1, next: { lastMessageID: "edit-1" }, content: "contents-a" }
    await first.begin(pending, 0)
    await first.settle(pending.id, pending.next)
    await first.begin({ ...pending, id: "pass-2", content: "contents-b" }, 0)
    await first.close()

    expect(await second.load()).toBe(true)
    expect(second.compatible).toBe(false)
    await second.settle("pass-2")
    expect(second.data.content).toBeUndefined()
    expect(second.data.cursor).toEqual({})
  } finally {
    await journal.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test("a corrupt journal stays blocked on repeated recovery instead of treating the cursor as empty", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "advisor-journal-"))
  const journal = new ReviewJournal(dataDir, "/project")
  const database = new FindingStore(dataDir)
  const key = { cwd: "/project", root_session: "root", advisor_slug: "reviewer" }
  const lane = journal.lane("root", "reviewer", {})
  try {
    expect(await database.claimJournal(key, "fixture", process.pid, null)).toBe(true)
    await database.saveJournal(key, "fixture", '{"cursor": "corrupt"}')
    await database.releaseJournal(key, "fixture")
    for (let i = 0; i < 2; i++) {
      const error: unknown = await lane.load().then(() => undefined, (error: unknown) => error)
      expect(error).toBeInstanceOf(Error)
      expect(String(error)).toContain("journal")
    }
  } finally {
    await lane.close()
    await journal.close()
    await database.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})
