import { describe, expect, test } from "bun:test"

import type { AssistantMessage, Event, Part, UserMessage } from "@opencode-ai/sdk"

import { Deliverer, type DelivererOptions } from "../src/deliver"
import type { LogFields, Logger } from "../src/log"
import { renderCard, type Note } from "../src/notes"
import { ROOT_STANDING_RULE } from "../src/prompts"

const NOW = 1_789_000_000_000
const fixtureNotes = new Map<string, Note>()

test("a later independent proposal arriving during a transform read remains injectable", async () => {
  const harness = makeHarness({ chatMinSeverity: "blocker", injectMinSeverity: "concern" })
  await harness.deliverer.deliver("root-1", [note("first-review")])
  const earlierRead = Promise.withResolvers<[]>()
  const transformRead = Promise.withResolvers<[]>()
  let reads = 0
  harness.store.listFindings = async () => (++reads === 1 ? earlierRead.promise : transformRead.promise)
  const later = harness.deliverer.deliver("root-1", [note("later-alternative")])
  const output = { messages: [userMessage("primary-request")] }
  const transform = harness.deliverer.messagesTransform(output)
  expect(reads).toBe(2)

  // The later review requested its assessment before the transform requested its snapshot.
  earlierRead.resolve([])
  await later
  transformRead.resolve([])
  await transform

  expect(output.messages.filter(({ info }) => info.id.startsWith("adv_")).map(({ info }) => info.id).sort())
    .toEqual(["adv_first-review"])
  expect(harness.deliverer.pendingBlockers.get("root-1")?.map(({ note }) => note.id).sort())
    .toEqual(["first-review", "later-alternative"])
  await harness.deliverer.messagesTransform(output)
  expect(output.messages.filter(({ info }) => info.id.startsWith("adv_")).map(({ info }) => info.id).sort())
    .toEqual(["adv_first-review", "adv_later-alternative"])
})

test.each(["stop", "replace"] as const)("late advice cannot bypass a task %s during a transform read", async (steering) => {
  let context = { task_id: "task-1", revision: "r1", stopped: false }
  const harness = makeHarness({
    chatMinSeverity: "blocker", injectMinSeverity: "concern", context: () => context,
  })
  const review = { task_id: "task-1", revision: "r1" }
  await harness.deliverer.deliver("root-1", [{ ...note("first-review"), review }])
  const earlierRead = Promise.withResolvers<[]>()
  const transformRead = Promise.withResolvers<[]>()
  let reads = 0
  harness.store.listFindings = async () => (++reads === 1 ? earlierRead.promise : transformRead.promise)
  const later = harness.deliverer.deliver("root-1", [{ ...note("later-alternative"), review }])
  const output = { messages: [userMessage("primary-request")] }
  const transform = harness.deliverer.messagesTransform(output)
  expect(reads).toBe(2)
  earlierRead.resolve([])
  await later
  context = steering === "stop" ? { ...context, stopped: true } : { ...context, task_id: "task-2" }
  transformRead.resolve([])
  await transform
  expect(output.messages.filter(({ info }) => info.id.startsWith("adv_"))).toEqual([])
  await harness.deliverer.messagesTransform(output)
  expect(output.messages.filter(({ info }) => info.id.startsWith("adv_"))).toEqual([])
  expect(harness.deliverer.pendingBlockers.has("root-1")).toBeFalse()
})

function note(id: string, severity: Note["severity"] = "concern", advisor_slug = "reviewer"): Note {
  const result: Note = {
    id,
    time: "2026-09-10T12:00:00.000Z",
    cwd: "/workspace/project",
    root_session: "root-1",
    advisor_session: "advisor-1",
    advisor_slug,
    roster_name: "Hidden reviewer",
    provider: "amazon-bedrock",
    model: "amazon-bedrock/openai.gpt-5.6-sol",
    model_display: "GPT-5.6 Sol",
    variant: "xhigh",
    severity,
    reasoning: `reasoning ${id}`,
    note: `note ${id}`,
    evidence: ["Checked the failing fixture"],
    is_fallback: false,
    quarantined: false,
  }
  fixtureNotes.set(id, result)
  return result
}

function userMessage(id: string, agent = "build"): { info: UserMessage; parts: Part[] } {
  return {
    info: {
      id,
      sessionID: "root-1",
      role: "user",
      time: { created: NOW },
      agent,
      model: { providerID: "amazon-bedrock", modelID: "openai.gpt-5.6-sol" },
    },
    parts: [
      {
        id: `part-${id}`,
        sessionID: "root-1",
        messageID: id,
        type: "text",
        text: `user ${id}`,
      },
    ],
  }
}

function shellMessage(): AssistantMessage {
  return {
    id: "shell-assistant",
    sessionID: "root-1",
    role: "assistant",
    time: { created: NOW, completed: NOW + 1 },
    parentID: "shell-user",
    modelID: "openai.gpt-5.6-sol",
    providerID: "amazon-bedrock",
    mode: "advisor-delivery",
    path: { cwd: "/workspace/project", root: "/workspace/project" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
}

type Harness = Readonly<{
  deliverer: Deliverer
  calls: string[]
  shellCalls: DelivererOptions["client"]["session"]["shell"] extends (
    input: infer Input,
  ) => Promise<unknown>
    ? Input[]
    : never
  toastBodies: DelivererOptions["client"]["tui"]["showToast"] extends (
    input: infer Input,
  ) => Promise<unknown>
    ? Input[]
    : never
  suppressed: Array<Readonly<{ sessionID: string; milliseconds: number }>>
  infos: LogFields[]
  warns: LogFields[]
  store: DelivererOptions["store"]
}>

function makeHarness(
  options: Readonly<{
    abortOnBlocker?: boolean
    toast?: boolean
    ttl?: number
    chatMinSeverity?: "nit" | "concern" | "blocker"
    injectMinSeverity?: "nit" | "concern" | "blocker"
    floors?: DelivererOptions["floors"]
    context?: DelivererOptions["context"]
    watched?: boolean
    toastRejects?: boolean
    shellStatuses?: readonly number[]
    shellThrows?: boolean
    shellEnvelope?: boolean
    shellOutput?: string
    shellToolStatus?: "completed" | "error"
    shellExit?: number
    deliveryStatus?: "expired"
    beforeShell?: (index: number) => Promise<void>
    nativeRender?: (input: Readonly<{ note: Note; canRender: () => boolean }>) => Promise<string | undefined>
    markDeliveredThrows?: boolean
    beforeRemovePending?: () => Promise<void>
  }> = {},
): Harness {
  const calls: string[] = []
  const shellCalls: Harness["shellCalls"] = []
  const toastBodies: Harness["toastBodies"] = []
  const suppressed: Harness["suppressed"] = []
  const infos: LogFields[] = []
  const warns: LogFields[] = []
  const pending = new Set<string>()
  const shellStatuses = [...(options.shellStatuses ?? [200])]
  const store = {
    listFindings: async () => [],
    deliveredFindingIDs: async () => new Set<string>(),
    readForDelivery: async (_cwd: string, id: string, _ttl: number) => {
      if (options.deliveryStatus !== undefined) return { status: options.deliveryStatus }
      const entry = fixtureNotes.get(id)
      if (entry === undefined) return { status: "missing" as const }
      return { status: "ready" as const, note: entry }
    },
    enqueuePending: async (_cwd, ids) => {
      calls.push("enqueue")
      for (const id of ids) pending.add(id)
    },
    markDelivered: async (ids, _at) => {
      calls.push("delivered")
      if (options.markDeliveredThrows === true) throw new Error("disk full")
      for (const id of ids) pending.delete(id)
    },
    removePending: async (_cwd, ids) => {
      calls.push("removed")
      await options.beforeRemovePending?.()
      for (const id of ids) pending.delete(id)
    },
  } satisfies DelivererOptions["store"]
  const client = {
    ...(options.nativeRender === undefined ? {} : { renderNote: options.nativeRender }),
    session: {
      shell: async (input) => {
        calls.push("shell")
        shellCalls.push(input)
        await options.beforeShell?.(shellCalls.length)
        if (options.shellThrows === true) throw new TypeError("transport failed")
        const status = shellStatuses.shift() ?? 200
        const response = new Response(null, { status })
        if (!response.ok) return { data: undefined, error: { message: "failed" }, response }
        const message = shellMessage()
        const renderedNote = fixtureNotes.get(input.body.command.split(" ").at(-1) ?? "")
        if (renderedNote === undefined) throw new Error("missing fixture note")
        return {
          data: {
                info: message,
                parts: [{
                  id: "shell-tool", messageID: message.id, sessionID: message.sessionID,
                  type: "tool",
                  tool: "bash",
                  state: {
                    status: options.shellToolStatus ?? "completed",
                    input: { command: input.body.command },
                    output: options.shellOutput ?? `${renderCard(renderedNote)}\n`,
                    metadata: { exit: options.shellExit ?? 0 },
                  },
                }],
              },
          error: undefined,
          response,
        }
      },
      abort: async () => {
        calls.push("abort")
        return { data: true, error: undefined, response: new Response(null, { status: 200 }) }
      },
    },
    tui: {
      showToast: async (input) => {
        toastBodies.push(input)
        calls.push("toast")
        if (options.toastRejects === true) throw new TypeError("no TUI attached")
        return { data: true, error: undefined, response: new Response(null, { status: 200 }) }
      },
    },
  } satisfies DelivererOptions["client"]
  const log: Logger = {
    debug: async () => undefined,
    info: async (fields) => { infos.push(fields) },
    warn: async (fields) => { warns.push(fields) },
    error: async () => undefined,
  }
  return {
    calls,
    shellCalls,
    toastBodies,
    suppressed,
    infos,
    warns,
    store,
    deliverer: new Deliverer({
      config: {
        toast: options.toast ?? true,
        abort_on_blocker: options.abortOnBlocker ?? false,
        note_ttl_turns: options.ttl ?? 2,
        chat_min_severity: options.chatMinSeverity ?? "nit",
        inject_min_severity: options.injectMinSeverity ?? "blocker",
        pending_ttl_ms: 600_000,
      },
      ...(options.floors === undefined ? {} : { floors: options.floors }),
      ...(options.context === undefined ? {} : { context: options.context }),
      store,
      log,
      client,
      directory: "/workspace/project",
      clock: () => NOW,
      isWatched: () => options.watched ?? true,
      suppress: (sessionID, milliseconds) => {
        suppressed.push({ sessionID, milliseconds })
      },
    }),
  }
}

async function status(deliverer: Deliverer, type: "busy" | "idle"): Promise<void> {
  await deliverer.onEvent({
    type: "session.status",
    properties: { sessionID: "root-1", status: { type } },
  } satisfies Event)
}

describe("Deliverer cards and notifications", () => {
  test("reviewer blocker labels cannot abort an unrelated user turn, even with the legacy opt-in", async () => {
    const harness = makeHarness({ toast: false, abortOnBlocker: true })
    await harness.deliverer.deliver("root-1", [note("unverified-blocker", "blocker")])
    expect(harness.calls).not.toContain("abort")
  })

  test("renders through the controlled card client without launching a shell", async () => {
    const rendered: string[] = []
    const harness = makeHarness({
      toast: false,
      nativeRender: async ({ note, canRender }) => {
        expect(canRender()).toBeTrue()
        rendered.push(note.id)
        return "native-card-message"
      },
    })
    await status(harness.deliverer, "idle")
    await harness.deliverer.deliver("root-1", [note("block-1", "blocker")])

    expect(rendered).toEqual(["block-1"])
    expect(harness.shellCalls).toHaveLength(0)
    expect(harness.calls.filter((entry) => entry === "delivered")).toHaveLength(1)
    expect(harness.suppressed).toHaveLength(0)
  })

  test("never renders on an unwatched session even when it is idle", async () => {
    const harness = makeHarness({ watched: false, toast: false })
    await status(harness.deliverer, "idle")
    await harness.deliverer.deliver("root-1", [note("unwatched", "blocker")])
    expect(harness.shellCalls).toHaveLength(0)
    expect(harness.calls).not.toContain("delivered")
  })

  test("native delivery resumes after a real user finishes while the first card is in flight", async () => {
    const rendered: string[] = []
    const harness = makeHarness({
      toast: false,
      nativeRender: async ({ note }) => {
        rendered.push(note.id)
        if (rendered.length === 1) {
          harness.deliverer.onUserMessage(userMessage("fast-user-turn").info)
          await harness.deliverer.onEvent({
            type: "message.updated",
            properties: { info: { ...shellMessage(), id: "primary-answer", mode: "build", parentID: "fast-user-turn" } },
          })
          await status(harness.deliverer, "idle")
        }
        return "native-message"
      },
    })
    await status(harness.deliverer, "idle")
    await harness.deliverer.deliver("root-1", [note("first-native", "blocker"), note("next-native", "blocker")])
    expect(rendered).toEqual(["first-native", "next-native"])
  })

  test("a real user turn interrupts a card batch even when the first card emits its own idle event", async () => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const harness = makeHarness({
      toast: false,
      beforeShell: async (index) => {
        if (index !== 1) return
        entered.resolve()
        await release.promise
      },
    })
    await harness.deliverer.deliver("root-1", [note("a-1"), note("b-2")])
    const flushing = status(harness.deliverer, "idle")
    await entered.promise
    await harness.deliverer.onEvent({
      type: "message.updated", properties: { info: userMessage("u-new").info },
    })
    await status(harness.deliverer, "busy")
    await harness.deliverer.onEvent({
      type: "message.updated", properties: { info: userMessage("delivery-u", "advisor-delivery").info },
    })
    await status(harness.deliverer, "idle")
    release.resolve()
    await flushing

    expect(harness.shellCalls).toHaveLength(1)
    await status(harness.deliverer, "idle")
    expect(harness.shellCalls).toHaveLength(1)

    await harness.deliverer.onEvent({
      type: "message.updated",
      properties: { info: { ...shellMessage(), id: "primary-reply", parentID: "u-new", mode: "build" } },
    })
    await status(harness.deliverer, "idle")
    expect(harness.shellCalls).toHaveLength(2)
  })

  test("expires a stale note without rendering an empty card, acknowledging it, or retrying it", async () => {
    const harness = makeHarness({ toast: false, deliveryStatus: "expired" })
    await harness.deliverer.deliver("root-1", [note("block-1", "blocker")])

    await status(harness.deliverer, "idle")
    await status(harness.deliverer, "idle")

    expect(harness.shellCalls).toHaveLength(0)
    expect(harness.calls).not.toContain("delivered")
    expect(harness.deliverer.pendingBlockers.get("root-1") ?? []).toEqual([])
    expect(harness.infos.some((entry) => entry["msg"] === "advisor card expired")).toBeFalse()
    expect(harness.infos.filter((entry) => entry["msg"] === "advisor card skipped")).toEqual([
      { msg: "advisor card skipped", sessionID: "root-1", noteIDs: ["block-1"], status: "expired" },
    ])
    expect(harness.infos.some((entry) => entry["msg"] === "advisor card delivered")).toBeFalse()
  })

  test("a note the policy withholds is logged with its reason instead of vanishing", async () => {
    const harness = makeHarness({ toast: false })
    await status(harness.deliverer, "idle")
    const unsupported = { ...note("no-evidence", "blocker"), evidence: [] }

    await harness.deliverer.deliver("root-1", [unsupported])

    expect(harness.shellCalls).toHaveLength(0)
    expect(harness.deliverer.pendingBlockers.get("root-1") ?? []).toEqual([])
    expect(harness.infos).toEqual([{
      msg: "advisor note withheld",
      sessionID: "root-1",
      notes: [{ noteID: "no-evidence", reason: "unsupported_observation" }],
    }])
  })

  test("a card waits for the primary's completed reply even when idle arrives before it", async () => {
    const rendered: string[] = []
    const harness = makeHarness({ toast: false, nativeRender: async ({ note }) => { rendered.push(note.id); return "m" } })
    await status(harness.deliverer, "idle")
    harness.deliverer.onUserMessage(userMessage("u-late").info)
    await status(harness.deliverer, "busy")
    await harness.deliverer.deliver("root-1", [note("late-card", "blocker")])
    await status(harness.deliverer, "idle")
    expect(rendered).toEqual([])

    await harness.deliverer.onEvent({
      type: "message.updated",
      properties: { info: { ...shellMessage(), id: "primary-reply", parentID: "u-late", mode: "build" } },
    })

    expect(rendered).toEqual(["late-card"])
  })

  test.each([
    { shellOutput: "Unknown option: u\nUnknown option: u\n" },
    { shellOutput: "Advisor · no pending notes\n" },
    { shellToolStatus: "error" as const },
    { shellExit: 1 },
  ])("HTTP 200 with an invalid render does not acknowledge or clear the note: %j", async (response) => {
    const harness = makeHarness({ toast: false, ...response })
    await harness.deliverer.deliver("root-1", [note("block-1", "blocker")])

    await status(harness.deliverer, "idle")

    expect(harness.calls).not.toContain("delivered")
    expect(harness.deliverer.pendingBlockers.get("root-1")?.map((entry) => entry.note.id)).toEqual(["block-1"])
    expect(harness.infos.some((entry) => entry["msg"] === "advisor card delivered")).toBeFalse()
  })

  test("logs queued, delivered, and blocker-cleared card transitions", async () => {
    // Given
    const harness = makeHarness({ toast: false })
    await status(harness.deliverer, "busy")

    // When
    await harness.deliverer.deliver("root-1", [note("block-1", "blocker"), note("c-1")])
    await status(harness.deliverer, "idle")

    // Then
    expect(harness.infos).toEqual([
      {
        msg: "advisor card queued",
        sessionID: "root-1",
        noteIDs: ["block-1", "c-1"],
        status: "busy",
      },
      {
        msg: "advisor card delivered",
        sessionID: "root-1",
        noteIDs: ["block-1"],
        messageID: "shell-assistant",
      },
      {
        msg: "advisor injection cleared after card",
        sessionID: "root-1",
        noteIDs: ["block-1"],
        severity: "blocker",
      },
      {
        msg: "advisor card delivered",
        sessionID: "root-1",
        noteIDs: ["c-1"],
        messageID: "shell-assistant",
      },
    ])
  })

  test("ships each note as its own shell block, sequentially, suppressing before each shell", async () => {
    // Given
    const harness = makeHarness({ toast: false })
    await status(harness.deliverer, "idle")

    // When
    await harness.deliverer.deliver("root-1", [note("a-1"), note("b-2", "nit")])

    // Then
    expect(harness.shellCalls.map((call) => call.body.command)).toEqual([
      "advisor --note a-1",
      "advisor --note b-2",
    ])
    expect(harness.calls.filter((call) => call === "shell" || call === "delivered")).toEqual([
      "shell",
      "delivered",
      "shell",
      "delivered",
    ])
    expect(harness.suppressed).toEqual([
      { sessionID: "root-1", milliseconds: 3000 },
      { sessionID: "root-1", milliseconds: 3000 },
    ])
  })

  test("never re-shells a shown card when bookkeeping fails after a successful shell", async () => {
    // Given
    const harness = makeHarness({ toast: false, markDeliveredThrows: true })
    await status(harness.deliverer, "idle")

    // When
    await harness.deliverer.deliver("root-1", [note("block-1", "blocker"), note("n-2")])
    await status(harness.deliverer, "idle")
    await status(harness.deliverer, "idle")

    // Then
    expect(harness.shellCalls.map((call) => call.body.command)).toEqual([
      "advisor --note block-1",
      "advisor --note n-2",
    ])
    expect(harness.calls.filter((call) => call === "removed")).toHaveLength(0)
    expect(harness.deliverer.pendingBlockers.get("root-1") ?? []).toEqual([])
    expect(harness.warns.map((warn) => warn["msg"])).toEqual([
      "advisor card bookkeeping failed",
      "advisor card bookkeeping failed",
    ])
  })

  test("keeps only the unshipped notes queued when a later shell in the batch fails", async () => {
    // Given
    const harness = makeHarness({ toast: false, shellStatuses: [200, 500, 200] })
    await status(harness.deliverer, "idle")

    // When
    await harness.deliverer.deliver("root-1", [note("a-1"), note("b-2")])

    // Then
    expect(harness.shellCalls.map((call) => call.body.command)).toEqual([
      "advisor --note a-1",
      "advisor --note b-2",
    ])
    expect(harness.infos.filter((info) => info["msg"] === "advisor card delivered")).toEqual([
      { msg: "advisor card delivered", sessionID: "root-1", noteIDs: ["a-1"], messageID: "shell-assistant" },
    ])

    // When
    await status(harness.deliverer, "idle")

    // Then
    expect(harness.shellCalls.map((call) => call.body.command)).toEqual([
      "advisor --note a-1",
      "advisor --note b-2",
      "advisor --note b-2",
    ])
    expect(harness.calls.filter((call) => call === "removed")).toHaveLength(0)
  })

  test("queues blockers and emits opted-in severity toasts without trusting the severity label", async () => {
    // Given
    const optedOut = makeHarness()
    const optedIn = makeHarness({ abortOnBlocker: true })

    // When
    await optedOut.deliverer.deliver("root-1", [note("block-1", "blocker"), note("c-1")])
    await optedIn.deliverer.deliver("root-1", [note("block-2", "blocker")])

    // Then
    expect(optedOut.deliverer.pendingBlockers.get("root-1")?.map((entry) => entry.note.id)).toEqual([
      "block-1",
    ])
    expect(optedOut.calls).not.toContain("abort")
    expect(optedIn.calls.filter((call) => call === "abort")).toHaveLength(0)
    expect(optedOut.toastBodies.map((input) => input.body.variant)).toEqual(["error", "warning"])
  })

  test("keeps notes below chat_min_severity out of the chat while still toasting and injecting blockers", async () => {
    // Given
    const harness = makeHarness({ chatMinSeverity: "blocker" })
    await status(harness.deliverer, "busy")

    // When
    await harness.deliverer.deliver("root-1", [note("block-1", "blocker"), note("c-1"), note("n-1", "nit")])

    // Then
    expect(harness.deliverer.pendingBlockers.get("root-1")?.map((entry) => entry.note.id)).toEqual(["block-1"])
    expect(harness.toastBodies.map((input) => input.body.variant)).toEqual(["error", "warning", "info"])
    expect(harness.calls.filter((call) => call === "enqueue")).toHaveLength(1)
    expect(harness.infos.find((fields) => fields["msg"] === "advisor card withheld")).toEqual({
      msg: "advisor card withheld",
      sessionID: "root-1",
      noteIDs: ["c-1", "n-1"],
    })

    // When
    await status(harness.deliverer, "idle")

    // Then
    expect(harness.shellCalls.map((call) => call.body.command)).toEqual(["advisor --note block-1"])
    expect(harness.infos.filter((fields) => fields["msg"] === "advisor card queued")).toHaveLength(1)
  })

  test("applies each advisor's own floors when a floors resolver is given, falling back to config", async () => {
    // Given
    const floors: DelivererOptions["floors"] = (slug) =>
      slug === "oracle" ? { chat_min_severity: "blocker", inject_min_severity: "concern" }
      : slug === "docs" ? { chat_min_severity: "nit", inject_min_severity: "blocker" }
      : undefined
    const harness = makeHarness({ floors, chatMinSeverity: "blocker", injectMinSeverity: "blocker" })
    await status(harness.deliverer, "busy")

    // When
    await harness.deliverer.deliver("root-1", [
      note("o-concern", "concern", "oracle"),
      note("d-nit", "nit", "docs"),
      note("x-concern", "concern", "unknown"),
    ])

    // Then
    expect(harness.deliverer.pendingBlockers.get("root-1")?.map((entry) => entry.note.id)).toEqual(["o-concern"])
    expect(harness.toastBodies).toHaveLength(3)
    expect(harness.infos.find((fields) => fields["msg"] === "advisor card withheld")?.["noteIDs"]).toEqual(["o-concern", "x-concern"])

    // When
    await status(harness.deliverer, "idle")

    // Then
    expect(harness.shellCalls.map((call) => call.body.command)).toEqual(["advisor --note d-nit"])
  })

  test("never shells while busy and flushes the queued card on the next idle", async () => {
    // Given
    const harness = makeHarness()
    await status(harness.deliverer, "busy")

    // When
    await harness.deliverer.deliver("root-1", [note("n-1", "nit")])

    // Then
    expect(harness.shellCalls).toHaveLength(0)

    // When
    await status(harness.deliverer, "idle")

    // Then
    expect(harness.shellCalls).toEqual([
      {
        path: { id: "root-1" },
        query: { directory: "/workspace/project" },
        body: { agent: "advisor-delivery", command: "advisor --note n-1" },
      },
    ])
    expect(harness.calls.indexOf("enqueue")).toBeLessThan(harness.calls.indexOf("shell"))
    expect(harness.calls.indexOf("shell")).toBeLessThan(harness.calls.indexOf("delivered"))
    expect(harness.suppressed).toEqual([{ sessionID: "root-1", milliseconds: 3000 }])
  })

  test("flushes immediately when delivery arrives after the session became idle", async () => {
    // Given
    const harness = makeHarness()
    await status(harness.deliverer, "idle")

    // When
    await harness.deliverer.deliver("root-1", [note("n-1")])

    // Then
    expect(harness.shellCalls).toHaveLength(1)
  })

  test("retries only on later idle events and removes pending after three failures", async () => {
    // Given
    const harness = makeHarness({ shellStatuses: [500, 500, 500] })
    await harness.deliverer.deliver("root-1", [note("n-1")])

    // When
    await status(harness.deliverer, "idle")
    await status(harness.deliverer, "idle")
    await status(harness.deliverer, "idle")

    // Then
    expect(harness.shellCalls).toHaveLength(3)
    expect(harness.calls.filter((call) => call === "removed")).toHaveLength(1)
    expect(harness.toastBodies.at(-1)?.body).toMatchObject({
      title: "Advisor · warning",
      message: "Advisor card delivery failed - see advisor notes",
      variant: "warning",
    })
  })

  test("a different proposal appended during third-failure cleanup remains deliverable", async () => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const harness = makeHarness({
      shellStatuses: [500, 500, 500],
      beforeRemovePending: async () => {
        entered.resolve()
        await release.promise
      },
    })
    await harness.deliverer.deliver("root-1", [note("failed-proposal")])
    await status(harness.deliverer, "idle")
    await status(harness.deliverer, "idle")
    const cleanup = status(harness.deliverer, "idle")
    await entered.promise
    await harness.deliverer.deliver("root-1", [note("better-proposal")])
    release.resolve()
    await cleanup
    await status(harness.deliverer, "idle")
    expect(harness.shellCalls.map((call) => call.body.command)).toEqual([
      "advisor --note failed-proposal",
      "advisor --note failed-proposal",
      "advisor --note failed-proposal",
      "advisor --note better-proposal",
    ])
  })

  test("a rejected toast never prevents idle card delivery", async () => {
    // Given
    const harness = makeHarness({ toastRejects: true })
    await status(harness.deliverer, "idle")

    // When
    await harness.deliverer.deliver("root-1", [note("n-1")])

    // Then
    expect(harness.shellCalls).toHaveLength(1)
    expect(harness.calls).toContain("delivered")
  })

  test("accepts the runtime shell envelope and retries thrown transport failures", async () => {
    // Given
    const enveloped = makeHarness({ shellEnvelope: true })
    const thrown = makeHarness({ shellThrows: true })
    await enveloped.deliverer.deliver("root-1", [note("n-1")])
    await thrown.deliverer.deliver("root-1", [note("n-2")])

    // When
    await status(enveloped.deliverer, "idle")
    await status(thrown.deliverer, "idle")
    await status(thrown.deliverer, "idle")

    // Then
    expect(enveloped.calls).toContain("delivered")
    expect(thrown.shellCalls).toHaveLength(2)
    expect(thrown.calls).not.toContain("removed")
  })
})

describe("Deliverer blocker transform", () => {
  test("splices one typed synthetic blocker before the last real user and stays idempotent", async () => {
    // Given
    const harness = makeHarness()
    await harness.deliverer.deliver("root-1", [note("block-1", "blocker")])
    const output = { messages: [userMessage("u-1"), userMessage("shell-u", "advisor-delivery"), userMessage("u-2")] }

    // When
    await harness.deliverer.messagesTransform(output)
    await harness.deliverer.messagesTransform(output)
    await harness.deliverer.messagesTransform(output)

    // Then
    const injected = output.messages.filter((message) => message.info.id === "adv_block-1")
    expect(injected).toHaveLength(1)
    expect(output.messages.findIndex((message) => message.info.id === "adv_block-1")).toBe(
      output.messages.findIndex((message) => message.info.id === "u-2") - 1,
    )
    expect(injected[0]).toMatchObject({
      info: {
        sessionID: "root-1",
        role: "user",
        agent: "build",
        model: { providerID: "amazon-bedrock", modelID: "openai.gpt-5.6-sol" },
      },
      parts: [{ id: "advp_block-1", messageID: "adv_block-1", synthetic: true }],
    })
  })

  test("reuses a present anchor, re-anchors when it disappears, and expires at the turn ttl", async () => {
    // Given
    const harness = makeHarness({ ttl: 2 })
    await harness.deliverer.deliver("root-1", [note("block-1", "blocker")])
    const first = { messages: [userMessage("u-1")] }
    await harness.deliverer.messagesTransform(first)
    const second = { messages: [userMessage("u-1"), userMessage("u-2")] }

    // When
    await harness.deliverer.messagesTransform(second)

    // Then
    expect(second.messages.findIndex((message) => message.info.id === "adv_block-1")).toBe(0)

    // When
    const third = { messages: [userMessage("u-3")] }
    await harness.deliverer.messagesTransform(third)

    // Then
    expect(third.messages.some((message) => message.info.id === "adv_block-1")).toBeFalse()
    expect(harness.deliverer.pendingBlockers.has("root-1")).toBeFalse()
  })

  test("removes blocker injection after successful card delivery", async () => {
    // Given
    const harness = makeHarness()
    await status(harness.deliverer, "idle")

    // When
    await harness.deliverer.deliver("root-1", [note("block-1", "blocker")])
    const output = { messages: [userMessage("u-1")] }
    await harness.deliverer.messagesTransform(output)

    // Then
    expect(output.messages.some((message) => message.info.id === "adv_block-1")).toBeFalse()
  })

  test("skips unwatched sessions and compaction, then clears blockers on compacted", async () => {
    // Given
    const unwatched = makeHarness({ watched: false })
    await unwatched.deliverer.deliver("root-1", [note("block-1", "blocker")])
    const unwatchedOutput = { messages: [userMessage("u-1")] }
    const compacting = makeHarness()
    await compacting.deliverer.deliver("root-1", [note("block-2", "blocker")])
    compacting.deliverer.markCompacting("root-1")
    const compactingOutput = { messages: [userMessage("u-1")] }

    // When
    await unwatched.deliverer.messagesTransform(unwatchedOutput)
    await compacting.deliverer.messagesTransform(compactingOutput)
    await compacting.deliverer.onEvent({
      type: "session.compacted",
      properties: { sessionID: "root-1" },
    } satisfies Event)

    // Then
    expect(unwatchedOutput.messages).toHaveLength(1)
    expect(compactingOutput.messages).toHaveLength(1)
    expect(compacting.deliverer.pendingBlockers.has("root-1")).toBeFalse()
    expect(compacting.deliverer.compacting.has("root-1")).toBeFalse()
  })

  test("does not inject concerns when the injection floor is blocker", async () => {
    // Given
    const harness = makeHarness()
    await harness.deliverer.deliver("root-1", [note("concern-1")])
    const output = { messages: [userMessage("u-1")] }

    // When
    await harness.deliverer.messagesTransform(output)

    // Then
    expect(output.messages).toHaveLength(1)
  })

  test("injects concerns but never nits when inject_min_severity is concern, even with no chat card", async () => {
    // Given
    const harness = makeHarness({ injectMinSeverity: "concern", chatMinSeverity: "blocker" })
    await status(harness.deliverer, "idle")
    await harness.deliverer.deliver("root-1", [note("concern-1"), note("nit-1", "nit")])
    const output = { messages: [userMessage("u-1")] }
    // OpenCode retains this array and converts it for the model after the hook returns.
    const modelMessages = output.messages

    // When
    await harness.deliverer.messagesTransform(output)

    // Then
    expect(harness.shellCalls).toHaveLength(0)
    expect(output.messages).toBe(modelMessages)
    expect(modelMessages.map((message) => message.info.id)).toEqual(["adv_concern-1", "u-1"])
    const text = modelMessages[0]?.parts[0]
    expect(text?.type === "text" ? text.text : "").toContain('<advisor severity="concern"')
    expect(text?.type === "text" ? text.text : "").toContain("Honor the user's latest steering first")
  })

  test("removes stale synthetic notes from the caller's array in place without injecting", async () => {
    // Given
    const harness = makeHarness({ watched: false })
    const output = { messages: [userMessage("adv_old-note"), userMessage("u-1"), userMessage("adv_other")] }
    const modelMessages = output.messages

    // When
    await harness.deliverer.messagesTransform(output)

    // Then
    expect(output.messages).toBe(modelMessages)
    expect(modelMessages.map((message) => message.info.id)).toEqual(["u-1"])
  })
})

describe("Deliverer standing rule", () => {
  test("adds the standing rule once only for a defined watched session", async () => {
    // Given
    const watched = makeHarness()
    const unwatched = makeHarness({ watched: false })
    const watchedOutput: { system: string[] } = { system: [] }
    const unwatchedOutput: { system: string[] } = { system: [] }
    const undefinedOutput: { system: string[] } = { system: [] }

    // When
    await watched.deliverer.systemTransform({ sessionID: "root-1" }, watchedOutput)
    await watched.deliverer.systemTransform({ sessionID: "root-1" }, watchedOutput)
    await unwatched.deliverer.systemTransform({ sessionID: "root-1" }, unwatchedOutput)
    await watched.deliverer.systemTransform({}, undefinedOutput)

    // Then
    expect(watchedOutput.system).toEqual([ROOT_STANDING_RULE])
    expect(unwatchedOutput.system).toEqual([])
    expect(undefinedOutput.system).toEqual([])
  })
})
