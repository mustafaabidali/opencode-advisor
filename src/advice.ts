export type Severity = "nit" | "concern" | "blocker"

export type AdviceNote = {
  readonly severity: Severity
  readonly reasoning: string
  readonly note: string
  readonly evidence: string[]
}

export type ParseAdviceResult = {
  readonly notes: AdviceNote[]
  readonly warnings: string[]
}

export type GuardResult =
  | { readonly quarantined: false }
  | { readonly quarantined: true; readonly matched: string }

const SEVERITY_RANK = {
  nit: 0,
  concern: 1,
  blocker: 2,
} as const satisfies Record<Severity, number>

const SILENCE_NOTE = /^(all clear|on track|nothing to add|no issues?)\b/i
const OPEN_ADVICE_TAG = /<advice\b[^>]*>/gi
const CLOSE_ADVICE_TAG = /<\/advice\s*>/gi
const ADVICE_BLOCK = /<advice\b([^>]*)>([\s\S]*?)<\/advice\s*>/gi
const SEVERITY_ATTRIBUTE = /\bseverity\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i
const LABELLED_LINE = /^\s*(reasoning|note|evidence)\s*:\s*(.*)$/i

export function parseAdvice(text: string): ParseAdviceResult {
  const openingTags = text.match(OPEN_ADVICE_TAG)?.length ?? 0
  const closingTags = text.match(CLOSE_ADVICE_TAG)?.length ?? 0
  if (openingTags > closingTags) {
    return {
      notes: [],
      warnings: ["Ignored unterminated <advice> tag."],
    }
  }

  const notes: AdviceNote[] = []
  const warnings: string[] = []

  for (const match of text.matchAll(ADVICE_BLOCK)) {
    const attributes = match[1] ?? ""
    const body = (match[2] ?? "").trim()
    const severityMatch = attributes.match(SEVERITY_ATTRIBUTE)
    const severityText = severityMatch?.[1] ?? severityMatch?.[2] ?? severityMatch?.[3] ?? ""
    const normalizedSeverity = severityText.toLowerCase()
    let severity: Severity
    switch (normalizedSeverity) {
      case "nit":
      case "concern":
      case "blocker":
        severity = normalizedSeverity
        break
      default:
        severity = "concern"
        warnings.push(`Unknown advice severity "${severityText || "missing"}"; using concern.`)
    }

    const lines = body.split(/\r?\n/)
    const hasNoteLabel = lines.some((line) => /^\s*note\s*:/i.test(line))
    let reasoning = ""
    let note = body
    let evidence: string[] = []

    if (hasNoteLabel) {
      const reasoningLines: string[] = []
      const noteLines: string[] = []
      const evidenceLines: string[] = []
      let activeLabel: "reasoning" | "note" | "evidence" | undefined

      for (const line of lines) {
        const labelled = line.match(LABELLED_LINE)
        const label = labelled?.[1]?.toLowerCase()
        const value = labelled?.[2] ?? line
        switch (label) {
          case "reasoning":
            activeLabel = "reasoning"
            reasoningLines.push(value)
            break
          case "note":
            activeLabel = "note"
            noteLines.push(value)
            break
          case "evidence":
            activeLabel = "evidence"
            evidenceLines.push(value)
            break
          default:
            switch (activeLabel) {
              case "reasoning":
                reasoningLines.push(line)
                break
              case "note":
                noteLines.push(line)
                break
              case "evidence":
                evidenceLines.push(line)
                break
              case undefined:
                break
            }
        }
      }

      reasoning = reasoningLines.join("\n").trim()
      note = noteLines.join("\n").trim()
      evidence = evidenceLines
        .flatMap((line) => line.split(","))
        .map((path) => path.trim())
        .filter((path) => path.length > 0)
    }

    if (SILENCE_NOTE.test(note)) {
      warnings.push(`Dropped silence advice note: "${note}".`)
      continue
    }

    notes.push({ severity, reasoning, note, evidence })
  }

  return { notes, warnings }
}

export function guardNote(
  note: Pick<AdviceNote, "reasoning" | "note">,
  patterns: string[],
): GuardResult {
  const content = `${note.reasoning}\n${note.note}`
  for (const pattern of patterns) {
    if (new RegExp(pattern, "i").test(content)) {
      return { quarantined: true, matched: pattern }
    }
  }
  return { quarantined: false }
}

export function severityRank(severity: Severity): number {
  return SEVERITY_RANK[severity]
}

export function meetsMinSeverity(severity: Severity, minimum: Severity): boolean {
  return severityRank(severity) >= severityRank(minimum)
}
