import { Database } from "bun:sqlite"

const path = process.argv[2]
if (path === undefined) throw new Error("Missing isolated database")
const db = new Database(path)
try {
  db.exec("BEGIN IMMEDIATE")
  console.log("locked")
  await Bun.sleep(300)
  db.exec("COMMIT")
} finally {
  db.close()
}
