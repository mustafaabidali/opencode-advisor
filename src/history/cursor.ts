import { createHash } from "node:crypto"
import type { Part } from "@opencode-ai/sdk"
import type { TranscriptMessage } from "../delta"

type Observation = Readonly<{ digest: string; parts?: Readonly<Record<string, string>> }>
export type Cursor = Readonly<{
  lastMessageID?: string
  lastPartCount?: number
  observed?: Readonly<Record<string, Observation>>
  prefix?: Readonly<{ before: string; digest: string }>
}>

const digest = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 24)

/** Bounded fingerprints detect in-place completion and changes to earlier messages. */
export function observeCursor(messages: readonly TranscriptMessage[], parts: (items: readonly Part[]) => readonly Part[]): NonNullable<Cursor["observed"]> {
  const entries: [string, Observation][] = []
  let remainingParts = 8192
  for (const message of messages.slice(-2048).toReversed()) {
    const observed = parts(message.parts).map((part) => [part.id, digest(JSON.stringify(part))] as const)
    const canRetain = observed.length <= remainingParts
    entries.push([message.info.id, { digest: digest(JSON.stringify(observed)),
      ...(canRetain ? { parts: Object.fromEntries(observed) } : {}) }])
    if (canRetain) remainingParts -= observed.length
  }
  return Object.fromEntries(entries)
}

export function changedParts(message: TranscriptMessage, before: Observation | undefined, after: Observation | undefined): readonly Part[] {
  if (after === undefined) return []
  if (before !== undefined && before.digest === after?.digest) return []
  if (before?.parts === undefined || after?.parts === undefined) return message.parts
  const removed = Object.keys(before.parts).some((id) => after.parts?.[id] === undefined)
  return removed ? message.parts : message.parts.filter((part) => before.parts?.[part.id] !== after.parts?.[part.id])
}

/** One digest detects older changes without retaining every old part fingerprint. */
export function observePrefix(messages: readonly TranscriptMessage[], parts: (items: readonly Part[]) => readonly Part[],
  before?: string): Cursor["prefix"] {
  const end = before === undefined ? messages.length - 2048 : messages.findIndex((message) => message.info.id === before)
  const boundary = messages[end]?.info.id
  if (end < 0 || boundary === undefined || (end === 0 && before === undefined)) return undefined
  const hash = createHash("sha256")
  for (let index = 0; index < end; index++) {
    const message = messages[index]
    if (message !== undefined) hash.update(JSON.stringify([message.info.id, parts(message.parts)]))
  }
  return { before: boundary, digest: hash.digest("hex").slice(0, 24) }
}
