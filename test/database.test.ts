import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FindingStore } from "../src/notes/findings"

test.each([
  { failure: "idle", uncertain: false, retainedNotes: 0, committedFindings: 0 },
  { failure: "after-commit", uncertain: true, retainedNotes: 1, committedFindings: 1 },
])("worker failure $failure cleans up only writes that definitely did not commit", async ({ failure, ...expected }) => {
  const dataDir = await mkdtemp(join(tmpdir(), "advisor-worker-failure-"))
  try {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/worker-failure.ts"), dataDir, failure], {
      stdout: "pipe", stderr: "pipe",
    })
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ])
      expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" })
      expect(JSON.parse(stdout)).toEqual({ ...expected, recovered: true })
    } finally {
      child.kill()
      await child.exited
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})

test("closing the last owner terminates the worker while shared owners and persisted data survive", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "advisor-worker-lifecycle-"))
  try {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/worker-lifecycle.ts"), dataDir], {
      stdout: "pipe", stderr: "pipe",
    })
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ])
      expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" })
      expect(JSON.parse(stdout)).toEqual({
        sharedOwnerKeptWorker: true, exitsAfterLastOwner: 1, closedRejected: true,
        persisted: { task_id: "task", revision: "r2", stopped: true }, workers: 2, exits: 2,
      })
    } finally {
      child.kill()
      await child.exited
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})

function legacyDatabase(dataDir: string): void {
  const db = new Database(join(dataDir, "findings.sqlite"), { create: true })
  try {
    db.exec(`CREATE TABLE findings (
      id TEXT PRIMARY KEY, cwd TEXT NOT NULL, root_session TEXT NOT NULL,
      task_id TEXT NOT NULL, reviewed_revision TEXT NOT NULL, state TEXT NOT NULL, updated_at TEXT NOT NULL
    )`)
    db.query("INSERT INTO findings VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("legacy", "/project", "root", "task", "r1", "open", "2026-09-12T00:00:00.000Z")
  } finally {
    db.close()
  }
}

test("an existing database migrates without losing findings and persists state versions across reopen", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "advisor-migration-"))
  legacyDatabase(dataDir)
  const store = new FindingStore(dataDir)
  const reopened = new FindingStore(dataDir)
  try {
    expect(await store.list("/project", "root")).toMatchObject([{
      id: "legacy", issue_id: "legacy", state: "open", reviewed_revision: "r1", version: 0,
    }])
    await store.recordDispositions("/project", "root", [{
      id: "legacy", state: "resolved", reviewed_revision: "r1", version: 0,
      reason: "Fixed", evidence: ["passing regression"],
    }], "2026-09-13T00:00:00.000Z")
    await store.close()
    expect(await reopened.list("/project", "root")).toMatchObject([{
      id: "legacy", state: "resolved", version: 1, disposition: { reason: "Fixed", evidence: ["passing regression"] },
    }])
  } finally {
    await store.close()
    await reopened.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test("competing processes cannot overwrite a newer disposition with the same inspected version", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "advisor-competing-writers-"))
  legacyDatabase(dataDir)
  const store = new FindingStore(dataDir)
  try {
    await store.list("/project", "root")
    const children = ["resolved", "dismissed"].map((state) => Bun.spawn([
      process.execPath, join(import.meta.dir, "fixtures/competing-disposition.ts"), dataDir, state,
    ], { stdout: "pipe", stderr: "pipe" }))
    try {
      const results = await Promise.all(children.map(async (child) => {
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
        ])
        expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" })
        return JSON.parse(stdout) as { ok: boolean; error?: string }
      }))
      expect(results.filter((result) => result.ok)).toHaveLength(1)
      expect(results.find((result) => !result.ok)?.error).toContain("Finding changed")
      expect((await store.list("/project", "root"))[0]?.version).toBe(1)
    } finally {
      for (const child of children) child.kill()
      await Promise.all(children.map((child) => child.exited))
    }
  } finally {
    await store.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test("waiting for another database writer leaves the event loop responsive", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "advisor-database-"))
  const store = new FindingStore(dataDir)
  try {
    await store.writeTask("/project", "root", { task_id: "task", revision: "r1", stopped: false })
    const child = Bun.spawn([
      process.execPath, join(import.meta.dir, "fixtures/hold-database-lock.ts"), join(dataDir, "findings.sqlite"),
    ], { stdout: "pipe", stderr: "pipe" })
    try {
      const reader = child.stdout.getReader()
      const ready = await reader.read()
      reader.releaseLock()
      expect(new TextDecoder().decode(ready.value).trim()).toBe("locked")
      const heartbeat = new Promise<"heartbeat">((resolve) => setTimeout(() => resolve("heartbeat"), 10))
      const write = store.writeTask("/project", "root", { task_id: "task", revision: "r2", stopped: false })
      expect(await Promise.race([heartbeat, write.then(() => "write")])).toBe("heartbeat")
      await write
      expect((await store.readTask("/project", "root"))?.revision).toBe("r2")
      expect(await child.exited).toBe(0)
    } finally {
      child.kill()
      await child.exited
    }
  } finally {
    await store.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})
