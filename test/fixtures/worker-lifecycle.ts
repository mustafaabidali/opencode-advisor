import { mock } from "bun:test"
import * as threads from "node:worker_threads"

const dataDir = process.argv[2]
if (dataDir === undefined) throw new Error("Missing test directory")
const RealWorker = threads.Worker
let workers = 0
let exits = 0
class ObservedWorker extends RealWorker {
  constructor(...args: ConstructorParameters<typeof RealWorker>) {
    super(...args)
    workers += 1
    this.once("exit", () => { exits += 1 })
  }
}
mock.module("node:worker_threads", () => ({ ...threads, Worker: ObservedWorker }))
const { FindingStore } = await import("../../src/notes/findings")
const first = new FindingStore(dataDir)
const second = new FindingStore(dataDir)
await first.writeTask("/project", "root", { task_id: "task", revision: "r1", stopped: false })
await second.readTask("/project", "root")
await first.close()
const sharedOwnerKeptWorker = exits === 0
await second.writeTask("/project", "root", { task_id: "task", revision: "r2", stopped: true })
const closing = second.close()
await second.close()
const exitsAfterLastOwner = exits
await closing
let closedRejected = false
try { await first.readTask("/project", "root") } catch { closedRejected = true }
const reopened = new FindingStore(dataDir)
const persisted = await reopened.readTask("/project", "root")
await reopened.close()
console.log(JSON.stringify({ sharedOwnerKeptWorker, exitsAfterLastOwner, closedRejected, persisted, workers, exits }))
