import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NoteStore, type NoteInput } from "../src/notes"
import type { Logger } from "../src/log"

const log: Logger = { debug: async () => {}, info: async () => {}, warn: async () => {}, error: async () => {} }
const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })
const input: NoteInput = {
  cwd: "/project", root_session: "root", advisor_session: "child", advisor_slug: "oracle",
  roster_name: "Oracle", provider: "test", model: "test/model", model_display: "Test", variant: "default",
  severity: "concern", reasoning: "The receipt was checked", note: "Commit the receipt before removing pending",
  evidence: ["queue.ts:40"], is_fallback: false, quarantined: false,
}
async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), "advisor-receipts-"))
  directories.push(dataDir)
  return { dataDir, store: new NoteStore({ dataDir, log }) }
}

test("a committed receipt survives a stale JSON mirror and can repair it for rollback", async () => {
  const { dataDir, store } = await fixture()
  try {
    const note = await store.writeNote(input)
    await store.markDelivered([note.id], "2026-09-13T14:00:00.000Z")
    await writeFile(join(dataDir, "notes", `${note.id}.json`), JSON.stringify(note))
    const other = new NoteStore({ dataDir, log })
    try {
      expect((await other.readForDelivery("/project", note.id, 1e12)).status).toBe("delivered")
      expect(await other.repairReceipts()).toMatchObject({ repaired: 1, missing: 0 })
      expect((await other.readNotes("/project", "root", [note.id]))[0]?.delivered_at).toBe("2026-09-13T14:00:00.000Z")
    } finally { await other.close() }
  } finally { await store.close() }
})

test("an acknowledged card keeps its receipt even if its report is unreadable at acknowledgment", async () => {
  const { dataDir, store } = await fixture()
  try {
    const shown = await store.writeNote(input)
    const sibling = await store.writeNote(input)
    const path = join(dataDir, "notes", `${shown.id}.json`)
    await writeFile(path, "{")
    await store.markDelivered([shown.id], "2026-09-13T14:00:00.000Z")
    expect((await store.readForDelivery("/project", sibling.id, 1e12)).status).toBe("duplicate")
    await writeFile(path, JSON.stringify(shown))
    expect((await store.readForDelivery("/project", shown.id, 1e12)).status).toBe("delivered")
    expect(await store.repairReceipts()).toMatchObject({ repaired: 1, missing: 0 })
  } finally { await store.close() }
})

test("indexed receipts and last-N notes do not reopen the provenance archive", async () => {
  const { store } = await fixture()
  try {
    for (let i = 0; i < 100; i++) await store.writeNote(input)
    const notes = await store.listNotes("/project", { last: 5 })
    await store.markDelivered([notes[0]!.id], new Date().toISOString())
    const findings = await store.listFindings("/project", "root")
    const reads = store.metrics.note_reads
    expect((await store.deliveredFindingIDs(findings)).size).toBe(1)
    expect((await store.deliveredFindingIDs(findings)).size).toBe(1)
    expect(store.metrics.note_reads).toBe(reads)
    expect(await store.listNotes("/project", { last: 5 })).toHaveLength(5)
    expect(store.metrics.note_reads - reads).toBe(5)
  } finally { await store.close() }
})

test("a report retry uses its stable identity without clearing a receipt or adding provenance", async () => {
  const { store } = await fixture()
  try {
    const note = await store.writeNote({ ...input, idempotency_key: "pass/attempt/report-1" })
    await store.markDelivered([note.id], new Date().toISOString())
    const retried = await store.writeNote({ ...input, idempotency_key: "pass/attempt/report-1" })
    expect(retried.id).toBe(note.id)
    expect((await store.listFindings("/project", "root"))[0]?.provenance).toHaveLength(1)
    expect((await store.readForDelivery("/project", note.id, 1e12)).status).toBe("delivered")
  } finally { await store.close() }
})

test("legacy backfill is bounded, resumes across owners, and pages past corrupt scoped entries", async () => {
  const { dataDir, store } = await fixture()
  await mkdir(join(dataDir, "notes"), { recursive: true })
  for (let i = 0; i < 35; i++) {
    const id = `legacy-${String(i).padStart(3, "0")}`
    await writeFile(join(dataDir, "notes", `${id}.json`), JSON.stringify({
      ...input, cwd: i % 2 === 0 ? "/project" : "/other", id,
      time: new Date(1000 + i).toISOString(), ...(i === 34 ? { delivered_at: new Date(2000).toISOString() } : {}),
    }))
  }
  expect(await store.backfillNotes(4)).toMatchObject({ complete: false })
  expect(store.metrics.note_reads).toBe(4)
  await store.close()
  const resumed = new NoteStore({ dataDir, log })
  try {
    let progress = await resumed.backfillNotes(4)
    while (!progress.complete) progress = await resumed.backfillNotes(4)
    expect((await resumed.readForDelivery("/project", "legacy-034", 1e15)).status).toBe("delivered")
    await writeFile(join(dataDir, "notes", "legacy-032.json"), "broken")
    await rm(join(dataDir, "notes", "legacy-030.json"))
    const before = resumed.metrics.note_reads
    const notes = await resumed.listNotes("/project", { last: 5 })
    expect(notes.map((note) => note.id)).toEqual(["legacy-034", "legacy-028", "legacy-026", "legacy-024", "legacy-022"])
    expect(resumed.metrics.note_reads - before).toBe(7)
  } finally { await resumed.close() }
})
