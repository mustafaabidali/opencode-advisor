import type { Cursor } from "../delta"
import type { ReviewContext } from "../notes"

export type JournalKey = Readonly<{ cwd: string; root_session: string; advisor_slug: string }>
export type PendingPass = Readonly<{
  id: string
  child: string
  model: string
  agent: string
  started_at: number
  next: Cursor
  review?: ReviewContext
}>
export type JournalData = Readonly<{
  fingerprint: string
  cursor: Cursor
  generation: number
  pending: PendingPass | null
}>
export type JournalRow = JournalKey & Readonly<{ owner: string | null; pid: number | null; payload: string }>
export const EMPTY_JOURNAL: JournalData = { fingerprint: "", cursor: {}, generation: 0, pending: null }

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
function cursor(value: unknown): value is Cursor {
  if (!record(value)) return false
  if (value["lastMessageID"] !== undefined && typeof value["lastMessageID"] !== "string") return false
  if (value["lastPartCount"] !== undefined && typeof value["lastPartCount"] !== "number") return false
  const prefix = value["prefix"]
  if (prefix !== undefined && (!record(prefix) || typeof prefix["before"] !== "string" || typeof prefix["digest"] !== "string")) return false
  const observed = value["observed"]
  return observed === undefined || (record(observed) && Object.values(observed).every((item) =>
    record(item) && typeof item["digest"] === "string" && (item["parts"] === undefined ||
      (record(item["parts"]) && Object.values(item["parts"]).every((part) => typeof part === "string")))))
}
function review(value: unknown): value is ReviewContext {
  return record(value) && typeof value["task_id"] === "string" && typeof value["revision"] === "string" &&
    (value["user_message_id"] === undefined || typeof value["user_message_id"] === "string")
}
function pending(value: unknown): value is PendingPass | null {
  return value === null || (record(value) && ["id", "child", "model", "agent"].every((key) => typeof value[key] === "string") &&
    typeof value["started_at"] === "number" && cursor(value["next"]) &&
    (value["review"] === undefined || review(value["review"])))
}
export function parseJournal(text: string): JournalData {
  const value: unknown = JSON.parse(text)
  if (!record(value) || typeof value["fingerprint"] !== "string" || !cursor(value["cursor"]) ||
    typeof value["generation"] !== "number" || !pending(value["pending"])) {
    throw new Error("Advisor journal is invalid; recovery required")
  }
  return { fingerprint: value["fingerprint"], cursor: value["cursor"], generation: value["generation"], pending: value["pending"] }
}
