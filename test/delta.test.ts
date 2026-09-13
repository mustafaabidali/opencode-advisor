import { describe, expect, test } from "bun:test"

import type {
  AgentPart,
  AssistantMessage,
  FilePart,
  Message,
  Part,
  ReasoningPart,
  TextPart,
  ToolPart,
  UserMessage,
} from "@opencode-ai/sdk"

import {
  renderDelta,
  sliceDelta,
  type RenderableTranscriptMessage,
  type TranscriptMessage,
} from "../src/delta"

const SESSION_ID = "session-1"

function userMessage(id: string, created: number, agent = "build"): UserMessage {
  return {
    id,
    sessionID: SESSION_ID,
    role: "user",
    time: { created },
    agent,
    model: { providerID: "amazon-bedrock", modelID: "openai.gpt-5.6-sol" },
  }
}

function assistantMessage(
  id: string,
  created: number,
  mode = "build",
): AssistantMessage {
  return {
    id,
    sessionID: SESSION_ID,
    role: "assistant",
    time: { created, completed: created + 1 },
    parentID: "user-1",
    modelID: "openai.gpt-5.6-sol",
    providerID: "amazon-bedrock",
    mode,
    path: { cwd: "/repo", root: "/repo" },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  }
}

function textPart(messageID: string, text: string, synthetic = false): TextPart {
  return {
    id: `${messageID}-text-${text.length}`,
    sessionID: SESSION_ID,
    messageID,
    type: "text",
    text,
    synthetic,
  }
}

function reasoningPart(messageID: string, text: string): ReasoningPart {
  return {
    id: `${messageID}-reasoning`,
    sessionID: SESSION_ID,
    messageID,
    type: "reasoning",
    text,
    time: { start: 1, end: 2 },
  }
}

function completedTool(
  messageID: string,
  tool: string,
  input: Readonly<Record<string, unknown>>,
  output: string,
): ToolPart {
  return {
    id: `${messageID}-${tool}-completed`,
    sessionID: SESSION_ID,
    messageID,
    type: "tool",
    callID: `call-${tool}`,
    tool,
    state: {
      status: "completed",
      input,
      output,
      title: tool,
      metadata: {},
      time: { start: 1, end: 2 },
    },
  }
}

function failedTool(messageID: string, error: string): ToolPart {
  return {
    id: `${messageID}-bash-error`,
    sessionID: SESSION_ID,
    messageID,
    type: "tool",
    callID: "call-error",
    tool: "bash",
    state: {
      status: "error",
      input: { command: "false" },
      error,
      time: { start: 1, end: 2 },
    },
  }
}

function transcript(info: Message, parts: readonly Part[]): TranscriptMessage {
  return { info, parts }
}

function runtimeTranscript(
  info: Message,
  parts: readonly unknown[],
): RenderableTranscriptMessage {
  return { info, parts }
}

describe("sliceDelta", () => {
  test("a tool completed in place before the cursor is reviewed once", () => {
    const completed = completedTool("assistant-1", "edit", { filePath: "/repo/src/a.ts" }, "ok")
    const running: ToolPart = { ...completed, state: {
      status: "running", input: completed.state.input, time: { start: 1 },
    } }
    const before = [
      transcript(assistantMessage("assistant-1", 20), [running]),
      transcript(assistantMessage("assistant-2", 30), [textPart("assistant-2", "waiting")]),
    ]
    const cursor = sliceDelta(before, {}).next
    const after = [{ ...before[0]!, parts: [completed] }, before[1]!]
    const updated = sliceDelta(after, cursor)
    expect(updated.delta.map(({ info }) => info.id)).toEqual(["assistant-1"])
    expect(updated.delta[0]?.parts).toEqual([completed])
    expect(sliceDelta(after, updated.next).delta).toEqual([])
  })
  test("returns only messages after the cursor in creation order", () => {
    // Given
    const messages = [
      transcript(assistantMessage("assistant-2", 30), []),
      transcript(userMessage("user-1", 10), []),
      transcript(assistantMessage("assistant-1", 20), []),
    ]

    // When
    const result = sliceDelta(messages, {
      lastMessageID: "assistant-1",
      lastPartCount: 0,
    })

    // Then
    expect(result.delta.map(({ info }) => info.id)).toEqual(["assistant-2"])
    expect(result.next).toMatchObject({
      lastMessageID: "assistant-2",
      lastPartCount: 0,
    })
  })

  test("re-includes the cursor message once when its part count grows", () => {
    // Given
    const messages = [
      transcript(userMessage("user-1", 10), [textPart("user-1", "first"), textPart("user-1", "second")]),
    ]

    // When
    const grown = sliceDelta(messages, { lastMessageID: "user-1", lastPartCount: 1 })
    const unchanged = sliceDelta(messages, grown.next)

    // Then
    expect(grown.delta.map(({ info }) => info.id)).toEqual(["user-1"])
    expect(grown.delta[0]?.parts.map((part) => part.type === "text" ? part.text : part.type)).toEqual(["second"])
    expect(unchanged.delta).toEqual([])
  })

  test("a native card appended to the reviewed message is neither new work nor a reason to re-review its edits", () => {
    // Given
    const reviewed = [
      transcript(assistantMessage("assistant-1", 20), [
        textPart("assistant-1", "edited"),
        completedTool("assistant-1", "edit", { filePath: "/repo/src/a.ts" }, "ok"),
      ]),
    ]
    const cursor = sliceDelta(reviewed, {}).next
    const carded = [
      transcript(assistantMessage("assistant-1", 20), [
        ...(reviewed[0]?.parts ?? []),
        completedTool("assistant-1", "advisor", { noteID: "note-1" }, "◉ Advisor card"),
        completedTool("assistant-1", "bash", { command: "advisor" }, "legacy card"),
      ]),
    ]

    // When
    const afterCard = sliceDelta(carded, cursor)
    const afterNextStep = sliceDelta([
      ...carded,
      transcript(assistantMessage("assistant-2", 30), [textPart("assistant-2", "answer only")]),
    ], afterCard.next)

    // Then
    expect(cursor).toMatchObject({ lastMessageID: "assistant-1", lastPartCount: 2 })
    expect(afterCard.delta).toEqual([])
    expect(afterCard.next).toEqual(cursor)
    expect(afterNextStep.delta.map(({ info }) => info.id)).toEqual(["assistant-2"])
  })
})

describe("renderDelta", () => {
  test("renders transcript sections and supported parts in order", () => {
    // Given
    const file: FilePart = {
      id: "file-1",
      sessionID: SESSION_ID,
      messageID: "assistant-1",
      type: "file",
      mime: "text/plain",
      filename: "report.txt",
      url: "file:///report.txt",
    }
    const subtask: Extract<Part, { type: "subtask" }> = {
      id: "subtask-1",
      sessionID: SESSION_ID,
      messageID: "assistant-1",
      type: "subtask",
      prompt: "inspect",
      description: "check types",
      agent: "explore",
    }
    const agent: AgentPart = {
      id: "agent-1",
      sessionID: SESSION_ID,
      messageID: "assistant-1",
      type: "agent",
      name: "oracle",
    }
    const messages = [
      transcript(userMessage("user-1", 1_000), [textPart("user-1", "please inspect")]),
      transcript(assistantMessage("assistant-1", 2_000), [
        reasoningPart("assistant-1", "checking"),
        textPart("assistant-1", "found it"),
        completedTool("assistant-1", "read", { filePath: "/repo/a.ts" }, "contents"),
        failedTool("assistant-1", "exit 1"),
        file,
        subtask,
        agent,
      ]),
    ]

    // When
    const rendered = renderDelta(messages, { maxChars: 10_000, redact: (value) => value })

    // Then
    expect(rendered).toBe(
      [
        "## user 1970-01-01T00:00:01.000Z",
        "[text] please inspect",
        "",
        "## assistant (build · openai.gpt-5.6-sol) 1970-01-01T00:00:02.000Z",
        "[reasoning] checking",
        "[text] found it",
        '[tool read] input: {"filePath":"/repo/a.ts"} -> completed: contents',
        '[tool bash] input: {"command":"false"} -> error: exit 1',
        "[file report.txt]",
        "[subtask explore: check types]",
        "[agent @oracle]",
      ].join("\n"),
    )
  })

  test("bounds reasoning, tool input, and completed tool output", () => {
    // Given
    const reasoning = "r".repeat(1_300)
    const outputHead = "h".repeat(800)
    const outputMiddle = "m".repeat(200)
    const outputTail = "t".repeat(400)
    const messages = [
      transcript(assistantMessage("assistant-1", 2_000), [
        reasoningPart("assistant-1", reasoning),
        completedTool(
          "assistant-1",
          "read",
          { value: "i".repeat(700) },
          `${outputHead}${outputMiddle}${outputTail}`,
        ),
      ]),
    ]

    // When
    const rendered = renderDelta(messages, { maxChars: 10_000, redact: (value) => value })

    // Then
    expect(rendered).toContain(`[reasoning] ${"r".repeat(1_200)}`)
    expect(rendered).not.toContain("r".repeat(1_201))
    expect(rendered).not.toContain("i".repeat(601))
    expect(rendered).toContain(`${outputHead} … ${outputTail}`)
    expect(rendered).not.toContain(outputMiddle)
  })

  test("excludes delivery messages, advisor shell tools, and synthetic blocker injections", () => {
    // Given
    const messages = [
      transcript(userMessage("delivery-user", 1_000, "advisor-delivery"), [
        textPart("delivery-user", "card request"),
      ]),
      transcript(assistantMessage("delivery-assistant", 2_000, "advisor-delivery"), [
        textPart("delivery-assistant", "card result"),
      ]),
      transcript(assistantMessage("assistant-1", 3_000), [
        completedTool("assistant-1", "bash", { command: "advisor" }, "Advisor card"),
        completedTool("assistant-1", "advisor", { noteID: "stored-note" }, "Native advisor card"),
        textPart("assistant-1", '<advisor severity="blocker">do this</advisor>', true),
        textPart("assistant-1", "visible"),
      ]),
    ]

    // When
    const rendered = renderDelta(messages, { maxChars: 10_000, redact: (value) => value })

    // Then
    expect(rendered).not.toContain("card request")
    expect(rendered).not.toContain("card result")
    expect(rendered).not.toContain("Advisor card")
    expect(rendered).not.toContain("Native advisor card")
    expect(rendered).not.toContain("<advisor severity=")
    expect(rendered).toContain("[text] visible")
  })

  test("ignores lifecycle, patch, and unknown parts without throwing", () => {
    // Given
    const skippedParts: readonly unknown[] = [
      { type: "step-start" },
      { type: "step-finish" },
      { type: "snapshot" },
      { type: "compaction" },
      { type: "retry" },
      { type: "patch" },
      { type: "future-part", payload: "ignored" },
    ]

    // When
    const render = () =>
      renderDelta([runtimeTranscript(assistantMessage("assistant-1", 1_000), skippedParts)], {
        maxChars: 10_000,
        redact: (value) => value,
      })

    // Then
    expect(render).not.toThrow()
    expect(render()).toBe("## assistant (build · openai.gpt-5.6-sol) 1970-01-01T00:00:01.000Z")
  })

  test("applies redaction to tool output", () => {
    // Given
    const key = "AKIA1234567890ABCDEF"
    const messages = [
      transcript(assistantMessage("assistant-1", 1_000), [
        completedTool("assistant-1", "read", {}, `credential=${key}`),
      ]),
    ]

    // When
    const rendered = renderDelta(messages, {
      maxChars: 10_000,
      redact: (value) => value.replace(key, "[REDACTED]"),
    })

    // Then
    expect(rendered).toContain("credential=[REDACTED]")
    expect(rendered).not.toContain(key)
  })

  test("caps the whole transcript while preserving its head and tail", () => {
    // Given
    const messages = [
      transcript(userMessage("user-1", 1_000), [
        textPart("user-1", `HEAD-${"a".repeat(160)}-TAIL`),
      ]),
    ]

    // When
    const rendered = renderDelta(messages, { maxChars: 100, redact: (value) => value })

    // Then
    expect(rendered.length).toBeLessThanOrEqual(100)
    expect(rendered).toStartWith("## user")
    expect(rendered).toContain("[… truncated ")
    expect(rendered).toEndWith("-TAIL")
  })
})
