import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ReviewJournal } from "../src/advisor/journal"
import { FindingStore } from "../src/notes/findings"

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
