import type { BuildIdentity } from "../identity"
import type { StateSnapshot } from "./types"

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
function build(value: unknown): value is BuildIdentity {
  return record(value) && ["version", "fingerprint", "instance_id", "started_at"].every((key) => typeof value[key] === "string") &&
    value["admission_scope"] === "process" && typeof value["max_concurrent_passes_per_provider"] === "number"
}
type Execution = NonNullable<StateSnapshot["execution"]>[number]
function execution(value: unknown): value is Execution {
  if (!record(value) || !["root_session", "advisor_slug", "state"].every((key) => typeof value[key] === "string")) return false
  if (value["advisor_session"] !== undefined && typeof value["advisor_session"] !== "string") return false
  return ["next_reconcile_at", "next_retry_at", "generation", "context_tokens", "context_budget"].every((key) =>
    value[key] === undefined || (typeof value[key] === "number" && Number.isFinite(value[key]))) &&
    ["context_budget_available", "context_budget_exceeded"].every((key) => value[key] === undefined || typeof value[key] === "boolean")
}
export function stateMetadata(value: Record<string, unknown>): Pick<StateSnapshot, "build" | "execution" | "metrics"> {
  const identity = value["build"]
  const lanes = value["execution"]
  const metrics = value["metrics"]
  return {
    ...(build(identity) ? { build: identity } : {}),
    ...(Array.isArray(lanes) ? { execution: lanes.filter(execution) } : {}),
    ...(record(metrics) ? { metrics: Object.fromEntries(Object.entries(metrics).filter(
      (entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]))) } : {}),
  }
}
