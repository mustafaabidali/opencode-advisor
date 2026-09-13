export type Severity = "nit" | "concern" | "blocker"

export type AdviceNote = {
  readonly severity: Severity
  readonly reasoning: string
  readonly note: string
  readonly evidence: string[]
  readonly failure?: string
  readonly location?: string
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
const LABELLED_LINE = /^\s*(reasoning|note|evidence|failure|location)\s*:\s*(.*)$/i

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
    let failure: string | undefined
    let location: string | undefined

    if (hasNoteLabel) {
      const fields: Record<"reasoning" | "note" | "evidence" | "failure" | "location", string[]> = {
        reasoning: [], note: [], evidence: [], failure: [], location: [],
      }
      let activeLabel: keyof typeof fields | undefined

      for (const line of lines) {
        const labelled = line.match(LABELLED_LINE)
        const label = labelled?.[1]?.toLowerCase()
        const value = labelled?.[2] ?? line
        switch (label) {
          case "reasoning":
          case "note":
          case "evidence":
          case "failure":
          case "location":
            activeLabel = label
        }
        if (activeLabel !== undefined) fields[activeLabel].push(value)
      }

      reasoning = fields.reasoning.join("\n").trim()
      note = fields.note.join("\n").trim()
      failure = fields.failure.join("\n").trim() || undefined
      location = fields.location.join("\n").trim() || undefined
      evidence = fields.evidence
        .flatMap((line) => line.split(","))
        .map((path) => path.trim())
        .filter((path) => path.length > 0)
    }

    if (SILENCE_NOTE.test(note)) {
      warnings.push(`Dropped silence advice note: "${note}".`)
      continue
    }

    notes.push({
      severity, reasoning, note, evidence,
      ...(failure === undefined ? {} : { failure }),
      ...(location === undefined ? {} : { location }),
    })
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

export type SeverityFloors = Readonly<{ chat_min_severity: Severity; inject_min_severity: Severity }>

export type Partitioned<T> = Readonly<{ chat: T[]; withheld: T[]; injected: T[] }>

export function partitionBySeverity<T extends Readonly<{ severity: Severity; advisor_slug: string }>>(
  notes: readonly T[],
  floorsFor: (advisorSlug: string) => SeverityFloors,
): Partitioned<T> {
  const chat: T[] = []
  const withheld: T[] = []
  const injected: T[] = []
  for (const note of notes) {
    const floors = floorsFor(note.advisor_slug)
    ;(meetsMinSeverity(note.severity, floors.chat_min_severity) ? chat : withheld).push(note)
    if (meetsMinSeverity(note.severity, floors.inject_min_severity)) injected.push(note)
  }
  return { chat, withheld, injected }
}
