import { describe, expect, test } from "bun:test"
import type { Message, Part, ToolPart, ToolState } from "@opencode-ai/sdk"

import { shouldReview } from "../src/advisor/trigger"
import { sliceDelta, type TranscriptMessage } from "../src/delta"
import type { ReviewTrigger } from "../src/roster"

const DIRECTORY = "/Users/mustafa/memq"

function assistantInfo(id: string, mode = "build"): Message {
  return {
    id,
    sessionID: "root",
    role: "assistant",
    time: { created: 1, completed: 2 },
    parentID: "u-1",
    providerID: "amazon-bedrock",
    modelID: "openai.gpt-5.6-sol",
    mode,
    path: { cwd: DIRECTORY, root: DIRECTORY },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
}

function toolPart(
  tool: string,
  input: Record<string, unknown>,
  status: ToolState["status"] = "completed",
): ToolPart {
  const base = { id: `p-${tool}-${Math.random()}`, sessionID: "root", messageID: "a-1", type: "tool" as const, callID: "c", tool }
  const state: ToolState =
    status === "completed"
      ? { status, input, output: "", title: tool, metadata: {}, time: { start: 1, end: 2 } }
      : status === "error"
        ? { status, input, error: "failed", time: { start: 1, end: 2 } }
        : status === "running"
          ? { status, input, time: { start: 1 } }
          : { status, input, raw: "" }
  return { ...base, state }
}

function message(parts: readonly Part[], info = assistantInfo("a-1")): TranscriptMessage {
  return { info, parts }
}

const textPart: Part = { id: "t-1", sessionID: "root", messageID: "a-1", type: "text", text: "prose only" }

function review(when: ReviewTrigger | undefined, ...parts: Part[]): boolean {
  return shouldReview(when, [message(parts)], DIRECTORY)
}

describe("shouldReview", () => {
  test("no when means every delta reviews, including an empty one", () => {
    // Given / When / Then
    expect(shouldReview(undefined, [], DIRECTORY)).toBeTrue()
    expect(review(undefined, textPart)).toBeTrue()
  })

  test("a when with no triggers never reviews", () => {
    // Given / When / Then
    expect(review({ edits: [], commands: [], tools: [] }, toolPart("edit", { filePath: `${DIRECTORY}/src/a.ts` }))).toBeFalse()
  })

  test("edits match path-bearing tools against globs on the directory-relative path", () => {
    // Given
    const when: ReviewTrigger = { edits: ["**/*.ts", "docs/**"], commands: [], tools: [] }

    // When / Then
    expect(review(when, toolPart("edit", { filePath: `${DIRECTORY}/src/a.ts` }))).toBeTrue()
    expect(review(when, toolPart("write", { filePath: "src/b.ts" }))).toBeTrue()
    expect(review(when, toolPart("edit", { filePath: `${DIRECTORY}/docs/guide.md` }))).toBeTrue()
    expect(review(when, toolPart("edit", { filePath: `${DIRECTORY}/README.md` }))).toBeFalse()
    expect(review(when, toolPart("read", { filePath: `${DIRECTORY}/src/a.ts` }))).toBeFalse()
    expect(review(when, textPart)).toBeFalse()
  })

  test("edits outside the watched directory match extension globs but not prefix globs", () => {
    // Given
    const outside = "/Users/mustafa/.config/opencode/advisor.jsonc"

    // When / Then
    expect(review({ edits: ["**/*.jsonc"], commands: [], tools: [] }, toolPart("edit", { filePath: outside }))).toBeTrue()
    expect(review({ edits: ["src/**"], commands: [], tools: [] }, toolPart("edit", { filePath: outside }))).toBeFalse()
    expect(review({ edits: ["../x.ts"], commands: [], tools: [] }, toolPart("edit", { filePath: "/Users/mustafa/x.ts" }))).toBeTrue()
    expect(review({ edits: ["/Users/mustafa/.config/**"], commands: [], tools: [] }, toolPart("edit", { filePath: outside }))).toBeTrue()
  })

  test("apply_patch paths come from the patchText headers", () => {
    // Given
    const when: ReviewTrigger = { edits: ["src/**"], commands: [], tools: [] }
    const patchText = [
      "*** Begin Patch",
      `*** Update File: ${DIRECTORY}/src/x.ts`,
      "@@",
      "-a",
      "+b",
      "*** End Patch",
    ].join("\n")
    const moveOnly = ["*** Begin Patch", `*** Move to: ${DIRECTORY}/src/y.ts`, "*** End Patch"].join("\n")
    const docsOnly = ["*** Begin Patch", `*** Add File: ${DIRECTORY}/docs/z.md`, "*** End Patch"].join("\n")

    // When / Then
    expect(review(when, toolPart("apply_patch", { patchText }))).toBeTrue()
    expect(review(when, toolPart("apply_patch", { patchText: moveOnly }))).toBeTrue()
    expect(review(when, toolPart("apply_patch", { patchText: docsOnly }))).toBeFalse()
    expect(review(when, toolPart("apply_patch", {}))).toBeFalse()
  })

  test("commands match bash command text as regex; non-string commands never match", () => {
    // Given
    const when: ReviewTrigger = { edits: [], commands: ["\\bsed\\s+-i\\b", "\\bcat\\s*>"], tools: [] }

    // When / Then
    expect(review(when, toolPart("bash", { command: "sed -i '' 's/a/b/' x.ts" }))).toBeTrue()
    expect(review(when, toolPart("bash", { command: "cat > out.txt <<'EOF'\nhi\nEOF" }))).toBeTrue()
    expect(review(when, toolPart("bash", { command: "bun test" }))).toBeFalse()
    expect(review(when, toolPart("bash", {}))).toBeFalse()
    expect(review(when, toolPart("edit", { filePath: "sed -i" }))).toBeFalse()
  })

  test("tools match on the bare tool name", () => {
    // Given
    const when: ReviewTrigger = { edits: [], commands: [], tools: ["task", "todowrite"] }

    // When / Then
    expect(review(when, toolPart("task", { description: "delegate" }))).toBeTrue()
    expect(review(when, toolPart("todowrite", { todos: [] }))).toBeTrue()
    expect(review(when, toolPart("bash", { command: "task" }))).toBeFalse()
  })

  test("only completed tool parts count", () => {
    // Given
    const when: ReviewTrigger = { edits: ["**/*.ts"], commands: [], tools: ["task"] }

    // When / Then
    expect(review(when, toolPart("edit", { filePath: "a.ts" }, "error"))).toBeFalse()
    expect(review(when, toolPart("edit", { filePath: "a.ts" }, "running"))).toBeFalse()
    expect(review(when, toolPart("task", {}, "pending"))).toBeFalse()
  })

  test("delivery-agent messages are ignored even when their parts would match", () => {
    // Given
    const when: ReviewTrigger = { edits: [], commands: ["advisor"], tools: [] }
    const delivery = message([toolPart("bash", { command: "advisor --note 1" })], assistantInfo("a-2", "advisor-delivery"))
    const synthetic: TranscriptMessage = {
      info: {
        id: "adv_note-1",
        sessionID: "root",
        role: "user",
        time: { created: 1 },
        agent: "build",
        model: { providerID: "amazon-bedrock", modelID: "openai.gpt-5.6-sol" },
      },
      parts: [toolPart("bash", { command: "advisor" })],
    }

    // When / Then
    expect(shouldReview(when, [delivery, synthetic], DIRECTORY)).toBeFalse()
    expect(shouldReview(when, [delivery, message([toolPart("bash", { command: "advisor status" })])], DIRECTORY)).toBeTrue()
  })

  test("a native card landing on an already reviewed message does not re-fire the gate", () => {
    // Given
    const when: ReviewTrigger = { edits: ["src/**"], commands: [], tools: [] }
    const reviewed = message([textPart, toolPart("edit", { filePath: `${DIRECTORY}/src/a.ts` })])
    const { next } = sliceDelta([reviewed], {})
    const carded = message([...reviewed.parts, toolPart("advisor", { noteID: "note-1" })])

    // When
    const { delta } = sliceDelta([carded], next)

    // Then
    expect(shouldReview(when, delta, DIRECTORY)).toBeFalse()
    expect(shouldReview(when, [carded], DIRECTORY)).toBeTrue()
  })
})
