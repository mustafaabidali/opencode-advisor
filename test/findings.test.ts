import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { NoteStore, type NoteInput } from "../src/notes"
import type { Logger } from "../src/log"
import type { Part, UserMessage } from "@opencode-ai/sdk"
import { Deliverer, type DelivererOptions, type MessagesTransformOutput } from "../src/deliver"
import { DEFAULTS } from "../src/config"
import { runCheckpoint } from "../src/checkpoint"

const directories: string[] = []
const log: Logger = { debug: async () => {}, info: async () => {}, warn: async () => {}, error: async () => {} }
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), "advisor-findings-"))
  directories.push(dataDir)
  return new NoteStore({ dataDir, log })
}

function input(overrides: Partial<NoteInput> = {}): NoteInput {
  return {
    cwd: "/project", root_session: "root", advisor_session: "reviewer-session",
    advisor_slug: "oracle", roster_name: "Oracle", provider: "test", model: "test/model",
    model_display: "Reviewer", variant: "default", severity: "concern",
    reasoning: "A failing command currently acknowledges the note",
    note: "Validate the render before acknowledging delivery",
    evidence: ["test: unexpected stdout clears pending injection"],
    failure: "HTTP success is treated as successful rendering",
    location: "src/deliver/cards.ts:156",
    review: { task_id: "task-1", revision: "revision-1", user_message_id: "user-1" },
    is_fallback: false, quarantined: false, ...overrides,
  }
}

function delivery(store: NoteStore, render?: () => void, options: Readonly<{
  abortOnBlocker?: boolean
  onAbort?: () => void
  context?: DelivererOptions["context"]
  isWatched?: DelivererOptions["isWatched"]
  log?: Logger
}> = {}) {
  return new Deliverer({
    config: { ...DEFAULTS, abort_on_blocker: options.abortOnBlocker ?? false, toast: false, chat_min_severity: "blocker", inject_min_severity: "concern" },
    store, log: options.log ?? log, directory: "/project", clock: Date.now,
    isWatched: options.isWatched ?? (() => true), suppress: () => {},
    ...(options.context === undefined ? {} : { context: options.context }),
    client: {
      ...(render === undefined ? {} : { renderNote: async () => { render(); return "message-card" } }),
      session: { shell: async () => { throw new Error("unexpected shell") }, abort: async () => {
        if (options.onAbort === undefined) throw new Error("unexpected abort")
        options.onAbort()
        return { data: true, error: undefined, response: { ok: true, status: 200 } }
      } },
      tui: { showToast: async () => ({ data: true, error: undefined, response: { ok: true, status: 200 } }) },
    },
  })
}

function messages(): { messages: Array<{ info: UserMessage; parts: Part[] }> } {
  return { messages: [{
    info: {
      id: "user-1", role: "user", sessionID: "root", time: { created: Date.now() },
      agent: "build", model: { providerID: "test", modelID: "model" },
    },
    parts: [{ id: "part-user", messageID: "user-1", sessionID: "root", type: "text", text: "Implement the fix" }],
  }] }
}

test("equivalent findings from independent reviewers merge while retaining both reports", async () => {
  const store = await fixture()
  const [first, second] = await Promise.all([
    store.writeNote(input()),
    store.writeNote(input({
      advisor_slug: "docs", advisor_session: "docs-session", model: "test/other",
      failure: "HTTP success is treated as successful rendering.",
      location: "src/deliver/cards.ts:160",
    })),
  ])

  const findings = await store.listFindings("/project", "root")
  expect(first.finding_id).toBeDefined()
  expect(second.finding_id).toBe(first.finding_id)
  expect(findings).toHaveLength(1)
  expect(findings[0]).toMatchObject({ state: "open", task_id: "task-1", reviewed_revision: "revision-1" })
  expect(findings[0]?.provenance.map((source) => source.advisor_slug).sort()).toEqual(["docs", "oracle"])
})

test("targeted finding reads preserve lifecycle and provenance without unrelated session history", async () => {
  const store = await fixture()
  const first = await store.writeNote(input())
  const duplicate = await store.writeNote(input({ advisor_slug: "docs" }))
  await store.writeNote(input({ note: "An unrelated proposal" }))
  const outside = await store.writeNote(input({ root_session: "other-session" }))
  await store.recordDispositions("/project", "root", [{
    id: first.id, state: "open", version: 0, reviewed_revision: "revision-1",
    reason: "Verified", evidence: ["checked regression"], verification: { revision: "revision-1", in_scope: true },
  }])

  const selected = await store.listFindings("/project", "root", { ids: [first.id, duplicate.id, outside.id] })

  expect(selected).toHaveLength(1)
  expect(selected[0]).toMatchObject({ id: first.finding_id, state: "open", version: 1 })
  expect(selected[0]?.provenance.map((source) => source.note_id).sort()).toEqual([first.id, duplicate.id].sort())
  expect(selected[0]?.disposition?.reason).toBe("Verified")
  expect(selected[0]?.verification?.evidence).toEqual(["checked regression"])
  expect(await store.listFindings("/project", "root", { ids: [] })).toEqual([])
})

test("checkpoint reads retain closed alternatives but omit unrelated retired issues and tasks", async () => {
  const store = await fixture()
  const open = await store.writeNote(input())
  const alternative = await store.writeNote(input({ note: "An alternative fix" }))
  const retired = await store.writeNote(input({ failure: "Unrelated failure", note: "Retired fix" }))
  if (open.finding_id === undefined || alternative.finding_id === undefined || retired.finding_id === undefined) {
    throw new Error("Missing finding IDs")
  }
  await store.writeNote(input({ review: { task_id: "old-task", revision: "revision-1" } }))
  await store.recordDispositions("/project", "root", [alternative, retired].map((note) => ({
    id: note.id, state: "resolved", version: 0, reviewed_revision: "revision-1",
    reason: "Fixed", evidence: ["checked passing regression"],
  })))

  const findings = await store.listFindings("/project", "root", {
    checkpoint: { task_id: "task-1" }, updated_ids: [],
  })
  expect(findings.map((finding) => finding.id).sort()).toEqual([open.finding_id, alternative.finding_id].sort())
  const stopped = await store.listFindings("/project", "root", {
    checkpoint: { task_id: "task-1", stopped: true }, updated_ids: [retired.id],
  })
  expect(stopped.map((finding) => finding.id)).toEqual([retired.finding_id])
})

test("duplicate reports produce one active injection even when reviewers finish separately", async () => {
  const store = await fixture()
  const deliverer = delivery(store)
  const first = await store.writeNote(input())
  const second = await store.writeNote(input({ advisor_slug: "docs" }))

  await deliverer.deliver("root", [first])
  await deliverer.deliver("root", [second])
  const output = messages()
  await deliverer.messagesTransform(output)

  expect(output.messages.filter((message) => message.info.id.startsWith("adv_"))).toHaveLength(1)
  expect((await store.listFindings("/project", "root"))[0]?.provenance).toHaveLength(2)
})

test("a shown finding is not injected again while busy, but a later alternative remains eligible", async () => {
  const store = await fixture()
  let cards = 0
  const deliverer = delivery(store, () => { cards += 1 })
  await deliverer.onEvent({ type: "session.status", properties: { sessionID: "root", status: { type: "idle" } } })
  const first = await store.writeNote(input({ severity: "blocker" }))
  await deliverer.deliver("root", [first])
  expect(cards).toBe(1)
  await deliverer.onEvent({ type: "session.status", properties: { sessionID: "root", status: { type: "busy" } } })
  const duplicate = await store.writeNote(input({ severity: "blocker", advisor_slug: "docs" }))
  const alternative = await store.writeNote(input({
    severity: "blocker", advisor_slug: "docs", note: "Use a different verified rendering contract",
  }))

  await deliverer.deliver("root", [duplicate, alternative])
  const output = messages()
  await deliverer.messagesTransform(output)

  expect(output.messages.filter(({ info }) => info.id.startsWith("adv_")).map(({ info }) => info.id))
    .toEqual([`adv_${alternative.id}`])
  expect(cards).toBe(1)
  await deliverer.onEvent({ type: "session.status", properties: { sessionID: "root", status: { type: "idle" } } })
  expect(cards).toBe(2)
})

test("concurrent duplicate reviewers leave one pending pointer while preserving an alternative", async () => {
  const store = await fixture()
  let cards = 0
  const deliverer = delivery(store, () => { cards += 1 })
  const first = await store.writeNote(input({ severity: "blocker" }))
  const duplicate = await store.writeNote(input({ severity: "blocker", advisor_slug: "docs" }))
  const alternative = await store.writeNote(input({
    severity: "blocker", advisor_slug: "docs", note: "Use a different verified rendering contract",
  }))

  await Promise.all([first, duplicate, alternative].map((note) => deliverer.deliver("root", [note])))

  const pending = await store.claimPending("/project", { ttlMs: 600_000 })
  expect(pending.map((note) => note.finding_id).sort()).toEqual([first.finding_id, alternative.finding_id].sort())
  expect((await store.listFindings("/project", "root")).find((finding) => finding.id === first.finding_id)?.provenance)
    .toHaveLength(2)
  await deliverer.onEvent({ type: "session.status", properties: { sessionID: "root", status: { type: "idle" } } })
  expect(cards).toBe(2)
})

test("a failed pending write is cleaned up without preventing another reviewer's card", async () => {
  const store = await fixture()
  let cards = 0
  const deliverer = delivery(store, () => { cards += 1 })
  const first = await store.writeNote(input({ severity: "blocker" }))
  const alternative = await store.writeNote(input({
    severity: "blocker", advisor_slug: "docs", note: "An independent alternative",
  }))
  const written = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const enqueue = store.enqueuePending.bind(store)
  store.enqueuePending = async (cwd, ids) => {
    await enqueue(cwd, ids)
    if (ids.includes(first.id)) {
      written.resolve()
      await release.promise
      throw new Error("Injected pending write failure")
    }
  }
  const failed = deliverer.deliver("root", [first]).catch((error: unknown) => error)
  await written.promise
  const next = deliverer.deliver("root", [alternative])
  release.resolve()

  expect(String(await failed)).toContain("Injected pending write failure")
  await next
  expect((await store.claimPending("/project", { ttlMs: 600_000 })).map((note) => note.id)).toEqual([alternative.id])
  await deliverer.onEvent({ type: "session.status", properties: { sessionID: "root", status: { type: "idle" } } })
  expect(cards).toBe(1)
})

test.each(["active", "disposed during logging"] as const)(
  "arrival of a verified blocker cannot abort a session that is %s",
  async (state) => {
    const store = await fixture()
    let watched = true
    const aborts: boolean[] = []
    const deliverer = delivery(store, undefined, {
      abortOnBlocker: true, onAbort: () => { aborts.push(watched) }, isWatched: () => watched,
      context: () => ({ task_id: "task-1", revision: "revision-1", next_action: "publish" }),
      log: { ...log, info: async () => { if (state === "disposed during logging") watched = false } },
    })
    const blocker = await store.writeNote(input({ severity: "blocker" }))
    await store.recordDispositions("/project", "root", [{
      id: blocker.id, state: "open", version: 0, reviewed_revision: "revision-1",
      reason: "Reproduced the publish failure", evidence: ["Checked the failing publish regression"],
      verification: {
        revision: "revision-1", in_scope: true, affected_action: "publish", cost_if_delayed: "A broken release ships",
      },
    }])
    const unsupported = await store.writeNote(input({ evidence: [] }))

    await deliverer.deliver("root", [blocker, unsupported])

    expect(aborts).toEqual([])
    if (!watched) expect(deliverer.pendingBlockers.has("root")).toBeFalse()
  },
)

test.each(["resolved", "dismissed", "deferred"] as const)(
  "%s findings stay out of repeated transforms and later duplicate reports",
  async (state) => {
    const store = await fixture()
    const deliverer = delivery(store)
    const note = await store.writeNote(input())
    await deliverer.deliver("root", [note])
    const output = messages()
    await deliverer.messagesTransform(output)
    expect(output.messages).toHaveLength(2)

    await store.recordDispositions("/project", "root", [{
      id: note.id, state, reviewed_revision: "revision-1", version: 0, reason: "Checked at the verification checkpoint",
      evidence: ["bun test: false-delivery regression passes"],
    }])
    for (let step = 0; step < 25; step += 1) await deliverer.messagesTransform(output)
    const repeated = await store.writeNote(input({
      advisor_slug: "docs",
      review: { task_id: "task-1", revision: "revision-2", user_message_id: "user-1" },
    }))
    await deliverer.deliver("root", [repeated])
    await deliverer.messagesTransform(output)

    expect(output.messages.filter((message) => message.info.id.startsWith("adv_"))).toHaveLength(0)
    expect((await store.listFindings("/project", "root"))[0]?.state).toBe(state)
  },
)

test("resolving a queued finding prevents a later idle card and does not mark it delivered", async () => {
  const store = await fixture()
  let cards = 0
  const deliverer = delivery(store, () => { cards += 1 })
  const note = await store.writeNote(input({ severity: "blocker" }))
  await deliverer.deliver("root", [note])
  await store.recordDispositions("/project", "root", [{
    id: note.id, state: "resolved", reviewed_revision: "revision-1", version: 0,
    reason: "The regression is fixed", evidence: ["behavioral regression passes"],
  }])

  await deliverer.onEvent({ type: "session.status", properties: { sessionID: "root", status: { type: "idle" } } })

  expect(cards).toBe(0)
  expect((await store.listNotes("/project", { last: 1 }))[0]?.delivered_at).toBeUndefined()
})

test("a second reviewer does not repeat a shown card, and delivery leaves the finding open", async () => {
  const store = await fixture()
  let cards = 0
  const deliverer = delivery(store, () => { cards += 1 })
  await deliverer.onEvent({ type: "session.status", properties: { sessionID: "root", status: { type: "idle" } } })
  const first = await store.writeNote(input({ severity: "blocker" }))
  await deliverer.deliver("root", [first])
  const duplicate = await store.writeNote(input({ severity: "blocker", advisor_slug: "docs" }))

  await deliverer.deliver("root", [duplicate])

  expect(cards).toBe(1)
  expect((await store.listFindings("/project", "root"))[0]?.state).toBe("open")
  expect((await store.listNotes("/project", { last: 10 })).find((note) => note.id === duplicate.id)?.delivered_at).toBeUndefined()
})

test("verifying a shown finding is not a reopen: a redundant report afterwards renders no second card", async () => {
  const store = await fixture()
  let cards = 0
  const deliverer = delivery(store, () => { cards += 1 })
  await deliverer.onEvent({ type: "session.status", properties: { sessionID: "root", status: { type: "idle" } } })
  const shown = await store.writeNote(input({ severity: "blocker" }))
  await deliverer.deliver("root", [shown])
  await store.recordDispositions("/project", "root", [{
    id: shown.id, state: "open", reviewed_revision: "revision-1", version: 0, reason: "Reproduced the failure",
    evidence: ["the integration test fails"], verification: { revision: "revision-1", in_scope: true },
  }])
  const redundant = await store.writeNote(input({ severity: "blocker", advisor_slug: "docs" }))

  await deliverer.deliver("root", [redundant])

  expect(cards).toBe(1)
  expect((await store.listFindings("/project", "root"))[0]?.reopened_at).toBeUndefined()
  expect((await store.listNotes("/project", { last: 10 })).find((note) => note.id === redundant.id)?.delivered_at).toBeUndefined()
})

test("a genuine reopen with new evidence lets the next report render again", async () => {
  const store = await fixture()
  let cards = 0
  const deliverer = delivery(store, () => { cards += 1 })
  await deliverer.onEvent({ type: "session.status", properties: { sessionID: "root", status: { type: "idle" } } })
  const shown = await store.writeNote(input({ severity: "blocker" }))
  await deliverer.deliver("root", [shown])
  await store.recordDispositions("/project", "root", [{
    id: shown.id, state: "dismissed", reviewed_revision: "revision-1", version: 0, reason: "Believed unreachable",
  }])
  await store.recordDispositions("/project", "root", [{
    id: shown.id, state: "open", reviewed_revision: "revision-1", version: 1, reason: "The branch is reachable after all",
    evidence: ["new failing input"],
  }])
  await deliverer.onEvent({ type: "session.status", properties: { sessionID: "root", status: { type: "busy" } } })
  const again = await store.writeNote(input({ severity: "blocker", advisor_slug: "docs" }))

  await deliverer.deliver("root", [again])
  const output = messages()
  await deliverer.messagesTransform(output)

  expect((await store.listFindings("/project", "root"))[0]?.reopened_at).toBeDefined()
  expect(output.messages.filter(({ info }) => info.id.startsWith("adv_")).map(({ info }) => info.id))
    .toEqual([`adv_${again.id}`])
  expect(cards).toBe(1)
  await deliverer.onEvent({ type: "session.status", properties: { sessionID: "root", status: { type: "idle" } } })
  expect(cards).toBe(2)
})

test("a redundant report at a newer revision does not invalidate the primary's disposition batch", async () => {
  const store = await fixture()
  const first = await store.writeNote(input())
  const inspected = (await store.listFindings("/project", "root"))[0]
  if (inspected === undefined) throw new Error("finding missing")
  await store.writeNote(input({
    advisor_slug: "docs", review: { task_id: "task-1", revision: "revision-2", user_message_id: "user-1" },
  }))

  await store.recordDispositions("/project", "root", [{
    id: first.id, state: "resolved", reviewed_revision: inspected.reviewed_revision, version: inspected.version,
    reason: "Fixed", evidence: ["regression passes"],
  }])

  const [finding] = await store.listFindings("/project", "root")
  expect(finding?.state).toBe("resolved")
  expect(finding?.reviewed_revision).toBe("revision-1")
  expect(finding?.provenance.map((source) => source.reviewed_revision).sort()).toEqual(["revision-1", "revision-2"])
})

test("a delayed verification cannot reopen a proposal resolved by a newer checkpoint", async () => {
  const store = await fixture()
  const note = await store.writeNote(input())
  const [inspected] = await store.listFindings("/project", "root")
  if (inspected === undefined) throw new Error("finding missing")
  await store.writeNote(input({
    advisor_slug: "docs", review: { task_id: "task-1", revision: "revision-2" },
  }))
  const checkpoint = {
    store, directory: "/project", sessionID: "root", phase: "complete" as const,
    context: { task_id: "task-1", revision: "revision-3" },
  }
  await runCheckpoint({
    ...checkpoint,
    updates: [{
      id: note.id, state: "resolved", reviewed_revision: inspected.reviewed_revision, version: inspected.version,
      reason: "Fixed and checked the current implementation", evidence: ["current regression passes"],
    }],
  })

  await expect(runCheckpoint({
    ...checkpoint,
    updates: [{
      id: note.id, state: "open", reviewed_revision: inspected.reviewed_revision, version: inspected.version,
      reason: "Delayed verification of the old implementation", evidence: ["old regression fails"],
      verification: { in_scope: true, affected_action: "publish", cost_if_delayed: "broken release" },
    }],
  })).rejects.toThrow("Finding changed")
  const [resolved] = await store.listFindings("/project", "root")
  expect(resolved?.state).toBe("resolved")
  expect(resolved?.verification).toBeUndefined()
})

test("a note is never written without its finding row", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "advisor-findings-"))
  directories.push(dataDir)
  await mkdir(join(dataDir, "findings.sqlite"))
  const store = new NoteStore({ dataDir, log })

  await expect(store.writeNote(input())).rejects.toThrow()

  expect(await store.listNotes("/project", { last: 10 })).toEqual([])
})

test("a partial note write leaves no indexed source and unrelated checkpoints still work", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "advisor-partial-note-"))
  directories.push(dataDir)
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/partial-note-write.ts"), dataDir], {
    stdout: "pipe", stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ])
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" })
  const report = JSON.parse(stdout)
  expect(report.writeFailed).toBeTrue()
  expect(report.findings).toBe(1)
  expect(report.reports).toEqual([report.validID])
})

test("an existing corrupt report does not hide unrelated proposals or silently permit completion", async () => {
  const store = await fixture()
  const corrupt = await store.writeNote(input())
  const valid = await store.writeNote(input({ failure: "Independent issue", note: "Independent fix" }))
  if (valid.finding_id === undefined) throw new Error("Missing finding ID")
  const dataDir = directories.at(-1)
  if (dataDir === undefined) throw new Error("Missing test directory")
  await writeFile(join(dataDir, "notes", `${corrupt.id}.json`), '{"partial":')

  const report = await runCheckpoint({
    store, directory: "/project", sessionID: "root", phase: "complete", context: { task_id: "task-1" },
  })

  expect(report.issues.flatMap((issue) => issue.proposals).map((proposal) => proposal.finding.id)).toEqual([valid.finding_id])
  expect(report.unavailable_reports).toMatchObject([{ finding: { id: corrupt.finding_id }, note_ids: [corrupt.id] }])
  expect(report.completion_allowed).toBeFalse()
})

test("a later different fix remains available after the faster reviewer's fix was resolved", async () => {
  const store = await fixture()
  const deliverer = delivery(store)
  const first = await store.writeNote(input({ note: "Retry the command when its exit status is nonzero" }))
  await store.recordDispositions("/project", "root", [{
    id: first.id, state: "resolved", reviewed_revision: "revision-1", version: 0,
    reason: "Implemented the first suggestion", evidence: ["the exit-status test passes"],
  }])
  const later = await store.writeNote(input({
    advisor_slug: "second-reviewer", model: "test/stronger-reviewer",
    note: "Use an idempotent receipt keyed to the note; an exit code alone misses unrelated successful output",
    evidence: ["HTTP 200 and exit zero with unrelated stdout still acknowledges the wrong note"],
  }))

  await deliverer.deliver("root", [later])
  const output = messages()
  await deliverer.messagesTransform(output)

  expect(later.finding_id).not.toBe(first.finding_id)
  expect(later.issue_id).toBe(first.issue_id)
  expect(output.messages.filter((message) => message.info.id.startsWith("adv_"))).toHaveLength(1)
  expect(JSON.stringify(output.messages)).toContain("idempotent receipt")
  expect((await store.listFindings("/project", "root")).map((finding) => finding.state).sort()).toEqual(["open", "resolved"])
})

test("one checkpoint compares alternative fixes and requires disposition of a verified concern before completion", async () => {
  const store = await fixture()
  const first = await store.writeNote(input({ note: "Retry unsuccessful commands" }))
  const second = await store.writeNote(input({ note: "Use an idempotent receipt", advisor_slug: "second-reviewer" }))
  const base = {
    store, directory: "/project", sessionID: "root", phase: "complete" as const,
    context: { task_id: "task-1", revision: "revision-1" },
  }
  const pending = await runCheckpoint({
    ...base,
    updates: [{
      id: first.id, state: "open", reviewed_revision: "revision-1", version: 0,
      reason: "Reproduced the failure", evidence: ["the integration test fails"],
      verification: { in_scope: true },
    }],
  })

  expect(pending.completion_allowed).toBeFalse()
  expect(pending.issues).toHaveLength(1)
  expect(pending.issues[0]?.proposals).toHaveLength(2)
  expect(JSON.stringify(pending.issues)).toContain("idempotent receipt")
  const edited = await runCheckpoint({ ...base, context: { task_id: "task-1", revision: "revision-2" } })
  expect(edited.completion_allowed).toBeFalse()
  expect(edited.issues[0]?.proposals.some((proposal) => proposal.requires_disposition && !proposal.verification_current)).toBeTrue()

  const complete = await runCheckpoint({
    ...base,
    updates: [
      {
        id: first.id, state: "resolved", reviewed_revision: "revision-1", version: 1,
        reason: "Fixed and checked", evidence: ["the regression now passes"],
      },
      {
        id: second.id, state: "deferred", reviewed_revision: "revision-1", version: 0,
        reason: "Compared both approaches; this alternative adds no benefit to the requested fix",
      },
    ],
  })
  expect(complete.completion_allowed).toBeTrue()
  const next = await runCheckpoint(base)
  expect(next.issues).toEqual([])
})

test("a rejected batch cannot partially resolve another proposal, and reopening requires evidence", async () => {
  const store = await fixture()
  const first = await store.writeNote(input())
  const second = await store.writeNote(input({ note: "A separate remedy" }))
  const rejected = await store.recordDispositions("/project", "root", [
    { id: first.id, state: "resolved", reviewed_revision: "revision-1", version: 0, reason: "Checked", evidence: ["passing regression"] },
    { id: second.id, state: "deferred", reviewed_revision: "stale-revision", version: 0, reason: "Not needed" },
  ]).then(() => undefined, (error: unknown) => error)
  expect(rejected).toBeInstanceOf(Error)
  expect(String(rejected)).toContain("Finding changed")
  expect((await store.listFindings("/project", "root")).every((finding) => finding.state === "open")).toBeTrue()
  await store.recordDispositions("/project", "root", [{
    id: first.id, state: "dismissed", reviewed_revision: "revision-1", version: 0, reason: "The reported branch is unreachable",
  }])
  const reopenError = await store.recordDispositions("/project", "root", [{
    id: first.id, state: "open", reviewed_revision: "revision-1", version: 1, reason: "Try again",
  }]).catch((error: unknown) => error)
  expect(String(reopenError)).toContain("checked evidence")
  const scopeError = await store.recordDispositions("/project", "different-session", [{
    id: first.id, state: "open", reviewed_revision: "revision-1", version: 1, reason: "Try again", evidence: ["new failing input"],
  }]).catch((error: unknown) => error)
  expect(String(scopeError)).toContain("Unknown finding")
})

test("a closed native card leaves model context while the primary's answer remains", async () => {
  const store = await fixture()
  const note = await store.writeNote(input())
  const deliverer = delivery(store)
  const output: MessagesTransformOutput = messages()
  output.messages.push({
    info: {
      id: "assistant-1", role: "assistant", sessionID: "root", parentID: "user-1",
      time: { created: 1, completed: 2 }, mode: "build", modelID: "model", providerID: "test",
      path: { cwd: "/project", root: "/project" }, cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [
      { id: "answer", type: "text", text: "The requested change is ready.", sessionID: "root", messageID: "assistant-1" },
      {
        id: `prt_advisor_${note.id}`, type: "tool", tool: "advisor", callID: `advisor_${note.id}`,
        sessionID: "root", messageID: "assistant-1",
        state: {
          status: "completed", input: { noteID: note.id }, output: "earlier advisor card", title: "Advisor",
          time: { start: 2, end: 2 }, metadata: { noteID: note.id },
        },
      },
    ],
  })
  await deliverer.messagesTransform(output)
  expect(output.messages[1]?.parts).toHaveLength(2)
  await store.recordDispositions("/project", "root", [{
    id: note.id, state: "deferred", reviewed_revision: "revision-1", version: 0, reason: "Compared remedies and chose another",
  }])
  await deliverer.messagesTransform(output)
  expect(output.messages[1]?.parts).toHaveLength(1)
  expect(JSON.stringify(output)).toContain("The requested change is ready.")
  expect(JSON.stringify(output)).not.toContain("earlier advisor card")
})

test.each([
  { note: "A different remedy based on the same reproduction" },
  { evidence: ["A newly reproduced case after applying the earlier remedy"] },
])("a changed remedy or new evidence stays independently actionable: %j", async (change) => {
  const store = await fixture()
  const first = await store.writeNote(input())
  await store.recordDispositions("/project", "root", [{
    id: first.id, state: "resolved", reviewed_revision: "revision-1", version: 0, reason: "First remedy implemented",
    evidence: ["previous regression passes"],
  }])
  const next = await store.writeNote(input({ ...change, advisor_slug: "later-reviewer" }))
  expect(next.issue_id).toBe(first.issue_id)
  expect(next.finding_id).not.toBe(first.finding_id)
  const checkpoint = await runCheckpoint({
    store, directory: "/project", sessionID: "root", phase: "inspect",
    context: { task_id: "task-1", revision: "revision-1" },
  })
  expect(checkpoint.issues[0]?.proposals.filter((proposal) => proposal.finding.state === "open")).toHaveLength(1)
})

test.each([
  { note: "Match `noteID` before acknowledging.", evidence: ["receipt field"] },
  { note: "Match `noteId` before acknowledging.", evidence: ["Receipt field"] },
])("case-sensitive remedies or evidence are never merged: %j", async (later) => {
  const store = await fixture()
  const first = await store.writeNote(input({ note: "Match `noteId` before acknowledging.", evidence: ["receipt field"] }))
  await store.recordDispositions("/project", "root", [{
    id: first.id, state: "resolved", reviewed_revision: "revision-1", version: 0,
    reason: "Applied the first suggestion", evidence: ["the earlier fixture passed"],
  }])
  const second = await store.writeNote(input({ ...later, advisor_slug: "later-reviewer" }))
  expect(second.finding_id).not.toBe(first.finding_id)
  expect((await store.listFindings("/project", "root")).filter((finding) => finding.state === "open")).toHaveLength(1)
})
