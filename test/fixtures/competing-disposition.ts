import { FindingStore } from "../../src/notes/findings"

const dataDir = process.argv[2]
const state = process.argv[3]
if (dataDir === undefined || (state !== "resolved" && state !== "dismissed")) throw new Error("Invalid test arguments")
const store = new FindingStore(dataDir)
try {
  try {
    await store.recordDispositions("/project", "root", [{
      id: "legacy", state, reviewed_revision: "r1", version: 0,
      reason: "Concurrent checkpoint", evidence: ["checked regression"],
    }], new Date().toISOString())
    console.log(JSON.stringify({ ok: true }))
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: String(error) }))
  }
} finally {
  await store.close()
}
