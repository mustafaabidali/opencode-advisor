import { describe, expect, test } from "bun:test"

import type { AssistantMessage, Event, Part, UserMessage } from "@opencode-ai/sdk"

import { Deliverer, type DelivererOptions } from "../src/deliver"
import type { LogFields, Logger } from "../src/log"
import type { Note } from "../src/notes"
import { ROOT_STANDING_RULE } from "../src/prompts"

const NOW = 1_789_000_000_000

function note(id: string, severity: Note["severity"] = "concern"): Note {
  return {
    id,
    time: "2026-09-10T12:00:00.000Z",
    cwd: "/workspace/project",
    root_session: "root-1",
    advisor_session: "advisor-1",
    advisor_slug: "reviewer",
    roster_name: "Hidden reviewer",
    provider: "amazon-bedrock",
    model: "amazon-bedrock/openai.gpt-5.6-sol",
    model_display: "GPT-5.6 Sol",
    variant: "xhigh",
    severity,
    reasoning: `reasoning ${id}`,
    note: `note ${id}`,
    evidence: [],
    is_fallback: false,
    quarantined: false,
  }
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
  store: DelivererOptions["store"]
}>

function makeHarness(
  options: Readonly<{
    abortOnBlocker?: boolean
    toast?: boolean
    ttl?: number
    watched?: boolean
    toastRejects?: boolean
    shellStatuses?: readonly number[]
    shellThrows?: boolean
    shellEnvelope?: boolean
  }> = {},
): Harness {
  const calls: string[] = []
  const shellCalls: Harness["shellCalls"] = []
  const toastBodies: Harness["toastBodies"] = []
  const suppressed: Harness["suppressed"] = []
  const infos: LogFields[] = []
  const pending = new Set<string>()
  const shellStatuses = [...(options.shellStatuses ?? [200])]
  const store = {
    enqueuePending: async (_cwd, ids) => {
      calls.push("enqueue")
      for (const id of ids) pending.add(id)
    },
    markDelivered: async (ids, _at) => {
      calls.push("delivered")
      for (const id of ids) pending.delete(id)
    },
    removePending: async (_cwd, ids) => {
      calls.push("removed")
      for (const id of ids) pending.delete(id)
    },
  } satisfies DelivererOptions["store"]
  const client = {
    session: {
      shell: async (input) => {
        calls.push("shell")
        shellCalls.push(input)
        if (options.shellThrows === true) throw new TypeError("transport failed")
        const status = shellStatuses.shift() ?? 200
        const response = new Response(null, { status })
        if (!response.ok) return { data: undefined, error: { message: "failed" }, response }
        const message = shellMessage()
        return {
          data: options.shellEnvelope === true ? { info: message, parts: [] } : message,
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
    warn: async () => undefined,
    error: async () => undefined,
  }
  return {
    calls,
    shellCalls,
    toastBodies,
    suppressed,
    infos,
    store,
    deliverer: new Deliverer({
      config: {
        toast: options.toast ?? true,
        abort_on_blocker: options.abortOnBlocker ?? false,
        note_ttl_turns: options.ttl ?? 2,
      },
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
        noteIDs: ["block-1", "c-1"],
        messageID: "shell-assistant",
      },
      {
        msg: "blocker cleared after card",
        sessionID: "root-1",
        noteIDs: ["block-1", "c-1"],
      },
    ])
  })

  test("queues blockers, emits severity toasts, and aborts only when opted in", async () => {
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
    expect(optedIn.calls.filter((call) => call === "abort")).toHaveLength(1)
    expect(optedOut.toastBodies.map((input) => input.body.variant)).toEqual(["error", "warning"])
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
        body: { agent: "advisor-delivery", command: "advisor" },
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

  test("never injects concerns", async () => {
    // Given
    const harness = makeHarness()
    await harness.deliverer.deliver("root-1", [note("concern-1")])
    const output = { messages: [userMessage("u-1")] }

    // When
    await harness.deliverer.messagesTransform(output)

    // Then
    expect(output.messages).toHaveLength(1)
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
