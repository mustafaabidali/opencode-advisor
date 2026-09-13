import { renderCard, type Note } from "../notes"

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Bounded diagnostics stay in the file log, never in an advice card. */
export function receiptDiagnostic(data: unknown): unknown {
  if (!record(data) || !Array.isArray(data["parts"])) return { parts_available: false }
  return data["parts"].filter(record).filter((part) => part["type"] === "tool").slice(0, 3).map((part) => {
    const state = record(part["state"]) ? part["state"] : {}
    const output = typeof state["output"] === "string" ? state["output"] : ""
    const metadata = record(state["metadata"]) ? state["metadata"] : {}
    return {
      tool: part["tool"], status: state["status"], input: state["input"],
      exit: metadata["exit"] ?? metadata["exitCode"] ?? metadata["exit_code"],
      output_chars: output.length, output_sample: output.slice(0, 512),
    }
  })
}

/** A transport acknowledgment is not a rendering acknowledgment. */
export function renderedMessageID(data: unknown, note: Note, command: string): string {
  if (!record(data) || !record(data["info"]) || !Array.isArray(data["parts"])) {
    throw new Error("advisor shell returned no verifiable tool result")
  }
  const info = data["info"]
  if (
    typeof info["id"] !== "string" ||
    info["sessionID"] !== note.root_session ||
    info["error"] !== undefined
  ) {
    throw new Error("advisor shell returned an invalid message")
  }
  const parts: readonly unknown[] = data["parts"]
  const tools = parts.filter((part) => record(part) && part["type"] === "tool")
  if (tools.length !== 1) throw new Error("advisor shell returned an unexpected tool result")
  const part = tools[0]
  const state = record(part) ? part["state"] : undefined
  const input = record(state) ? state["input"] : undefined
  const metadata = record(state) ? state["metadata"] : undefined
  if (
    !record(part) || part["tool"] !== "bash" ||
    part["sessionID"] !== note.root_session || part["messageID"] !== info["id"] ||
    !record(state) || state["status"] !== "completed" ||
    !record(input) || input["command"] !== command ||
    typeof state["output"] !== "string"
  ) {
    throw new Error("advisor render did not complete")
  }
  if (record(metadata) && ["exit", "exitCode", "exit_code"].some(
    (key) => metadata[key] !== undefined && metadata[key] !== 0,
  )) {
    throw new Error("advisor render exited unsuccessfully")
  }
  // Older OpenCode shells omit the exit code. Exact output includes the note identity
  // and is emitted only by the successful CLI render, so a bare message is never enough.
  if (state["output"].replaceAll("\r\n", "\n") !== `${renderCard(note)}\n`) {
    throw new Error("advisor shell output did not acknowledge the requested note")
  }
  return info["id"]
}
