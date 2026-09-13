import { expect, test } from "bun:test"
import type { Part, UserMessage } from "@opencode-ai/sdk"
import { SessionHistory } from "../src/history/session"
import { sliceDelta, type TranscriptMessage } from "../src/delta"

function message(id: string, text: string): TranscriptMessage {
  const info: UserMessage = { id, sessionID: "root", role: "user", time: { created: 1 },
    agent: "build", model: { providerID: "test", modelID: "test" } }
  const part: Part = { id: `part-${id}`, sessionID: "root", messageID: id, type: "text", text }
  return { info, parts: [part] }
}

test("reviewers share one hydration and unchanged warm views do no history requests", async () => {
  let reads = 0
  const history = new SessionHistory({ read: async () => { reads++; return [message("user", "first")] } })
  const [first, second] = await Promise.all([history.read("root"), history.read("root")])
  expect(first).toBe(second)
  for (let i = 0; i < 10; i++) expect(await history.read("root")).toBe(first)
  expect(reads).toBe(1)
  expect(history.metrics.cache_hits).toBeGreaterThanOrEqual(10)
  await history.read("root", true)
  expect(reads).toBe(2)
})

test("in-place part events update a fresh immutable view and removal invalidates stale evidence", async () => {
  const original = message("user", "before")
  let current = [original]
  const history = new SessionHistory({ read: async () => current })
  const first = await history.read("root")
  const changed: Part = { id: "part-user", sessionID: "root", messageID: "user", type: "text", text: "after" }
  history.observe({ type: "message.part.updated", properties: { part: changed } })
  const second = await history.read("root")
  expect(first[0]?.parts[0]).toMatchObject({ text: "before" })
  expect(second[0]?.parts[0]).toMatchObject({ text: "after" })
  expect(sliceDelta(second, sliceDelta(first, {}).next).delta).toHaveLength(1)
  current = []
  history.observe({ type: "message.removed", properties: { sessionID: "root", messageID: "user" } })
  expect(await history.read("root")).toEqual([])
})

test("events arriving during hydration prevent the response from becoming a stale cached view", async () => {
  const delayed = Promise.withResolvers<readonly TranscriptMessage[]>()
  let reads = 0
  const history = new SessionHistory({ read: () => ++reads === 1 ? delayed.promise : Promise.resolve([message("user", "new")]) })
  const reading = history.read("root")
  history.observe({ type: "message.part.updated", properties: { part: message("user", "new").parts[0]! } })
  delayed.resolve([message("user", "old")])
  expect((await reading)[0]?.parts[0]).toMatchObject({ text: "old" })
  expect((await history.read("root"))[0]?.parts[0]).toMatchObject({ text: "new" })
  expect(reads).toBe(2)
})

test("continuous streaming returns each fresh server snapshot once without retrying or caching it", async () => {
  let reads = 0
  const history = new SessionHistory({ read: async () => {
    reads++
    const snapshot = [message("user", `snapshot-${reads}`)]
    history.observe({ type: "message.part.updated", properties: { part: message("user", "streaming").parts[0]! } })
    return snapshot
  } })
  expect((await history.read("root"))[0]?.parts[0]).toMatchObject({ text: "snapshot-1" })
  expect(reads).toBe(1)
  expect((await history.read("root", true))[0]?.parts[0]).toMatchObject({ text: "snapshot-2" })
  expect(reads).toBe(2)
  expect(history.metrics.retained_bytes).toBe(0)
})

test("a checkpoint refresh waits for an older shared read and then samples the server again", async () => {
  const delayed = Promise.withResolvers<readonly TranscriptMessage[]>()
  let reads = 0
  const history = new SessionHistory({ read: () => ++reads === 1 ? delayed.promise : Promise.resolve([message("user", "current")]) })
  const ordinary = history.read("root")
  const checkpoint = history.read("root", true)
  delayed.resolve([message("user", "old")])
  expect((await ordinary)[0]?.parts[0]).toMatchObject({ text: "old" })
  expect((await checkpoint)[0]?.parts[0]).toMatchObject({ text: "current" })
  expect(reads).toBe(2)
})

test("oversized roots fall back to fresh reads and retained roots stay bounded", async () => {
  let reads = 0
  const history = new SessionHistory({ read: async () => { reads++; return [message("user", "large".repeat(1000))] },
    maxSessionBytes: 1000, maxRoots: 3, maxBytes: 3000 })
  await history.read("root")
  await history.read("root")
  expect(reads).toBe(2)
  for (let i = 0; i < 10; i++) await history.read(`root-${i}`)
  expect(history.metrics.roots).toBeLessThanOrEqual(3)
  expect(history.metrics.retained_bytes).toBeLessThanOrEqual(3000)
})

test("long-session cursors skip unchanged old history while retaining older edits and large new bursts", () => {
  const make = (index: number) => {
    const value = message(`message-${index}`, `body-${index}`)
    return { ...value, info: { ...value.info, time: { created: index } } }
  }
  const original = Array.from({ length: 2200 }, (_, index) => make(index))
  const first = sliceDelta(original, {}).next
  const appended = [...original, make(2200)]
  const second = sliceDelta(appended, first)
  expect(second.delta.map(({ info }) => info.id)).toEqual(["message-2200"])
  const changed = appended.map((value, index) => index === 0
    ? { ...value, parts: message(value.info.id, "old message edited").parts } : value)
  const edited = sliceDelta(changed, second.next)
  expect(edited.delta.some(({ info }) => info.id === "message-0")).toBe(true)
  expect(sliceDelta(changed, edited.next).delta).toEqual([])
  const burst = [...changed, ...Array.from({ length: 3000 }, (_, index) => make(index + 2201))]
  const last = sliceDelta(burst, edited.next)
  expect(last.delta).toHaveLength(3000)
  expect(sliceDelta(burst, last.next).delta).toEqual([])
})
