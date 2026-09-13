import { parentPort } from "node:worker_threads"
import { FindingDatabase } from "./database"
import type { Request, Response, Result, Operation } from "./database-protocol"

const port = parentPort
if (port === null) throw new Error("Database worker needs a parent port")
const databases = new Map<string, FindingDatabase>()

function run(request: Request): Result<Operation> {
  let db = databases.get(request.dataDir)
  databases.delete(request.dataDir)
  if (request.operation === "close") {
    db?.close()
    return
  }
  if (db === undefined) db = new FindingDatabase(request.dataDir)
  databases.set(request.dataDir, db)
  // Bound open connections when the CLI/tests use several independent data directories.
  if (databases.size > 16) {
    const oldest = databases.entries().next().value
    if (oldest !== undefined) {
      oldest[1].close()
      databases.delete(oldest[0])
    }
  }
  switch (request.operation) {
    case "readJournal": return db.readJournal(...request.args)
    case "claimJournal": return db.claimJournal(...request.args)
    case "saveJournal": return db.saveJournal(...request.args)
    case "releaseJournal": return db.releaseJournal(...request.args)
    case "beginUsage": return db.beginUsage(...request.args)
    case "getUsage": return db.getUsage(...request.args)
    case "usageForPass": return db.usageForPass(...request.args)
    case "findUsage": return db.findUsage(...request.args)
    case "usagePrompt": return db.usagePrompt(...request.args)
    case "finishUsage": return db.finishUsage(...request.args)
    case "recordUsage": return db.recordUsage(...request.args)
    case "usageSummary": return db.usageSummary(...request.args)
    case "catalogProgress": return db.catalogProgress(...request.args)
    case "catalogMissing": return db.catalogMissing(...request.args)
    case "catalogIndex": return db.catalogIndex(...request.args)
    case "catalogPage": return db.catalogPage(...request.args)
    case "acknowledge": return db.acknowledge(...request.args)
    case "receipts": return db.receipts(...request.args)
    case "receiptPage": return db.receiptPage(...request.args)
    case "delivered": return db.delivered(...request.args)
    case "readTask": return db.readTask(...request.args)
    case "writeTask": return db.writeTask(...request.args)
    case "record": return db.record(...request.args)
    case "recordDispositions": return db.recordDispositions(...request.args)
    case "list": return db.list(...request.args)
  }
}

port.on("message", (request: Request) => {
  let response: Response
  try {
    response = { id: request.id, ok: true, value: run(request) }
  } catch (error) {
    response = { id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  port.postMessage(response)
})
