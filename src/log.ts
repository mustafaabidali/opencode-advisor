import { appendFile, mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export type LogLevel = "debug" | "info" | "warn" | "error"

export type LogFields = Readonly<{
  msg: string
  [field: string]: unknown
}>

export type Logger = Readonly<{
  debug: (fields: LogFields) => Promise<void>
  info: (fields: LogFields) => Promise<void>
  warn: (fields: LogFields) => Promise<void>
  error: (fields: LogFields) => Promise<void>
}>

export type LoggerOptions = Readonly<{
  level: LogLevel
  path?: string
}>

const DEFAULT_LOG_PATH = join(
  homedir(),
  ".local",
  "share",
  "opencode-advisor",
  "advisor.log",
)

const LEVEL_PRIORITY: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
}

const SECRET_PATTERNS: readonly RegExp[] = [
  /AKIA[0-9A-Z]{16}/g,
  /sk-[A-Za-z0-9]{20,}/g,
  /ghp_[A-Za-z0-9]{30,}/g,
  /Bearer\s+[A-Za-z0-9._-]{16,}/g,
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
]

export function redact(value: string): string {
  return SECRET_PATTERNS.reduce(
    (redacted, pattern) => redacted.replace(pattern, "[REDACTED]"),
    value,
  )
}

function serializeLogValue(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    }
  }
  return typeof value === "string" ? redact(value) : value
}

export function createLogger(options: LoggerOptions): Logger {
  const path = options.path ?? DEFAULT_LOG_PATH

  const write = async (level: LogLevel, fields: LogFields): Promise<void> => {
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[options.level]) return

    try {
      const line = JSON.stringify(
        {
          time: new Date().toISOString(),
          level,
          ...fields,
        },
        serializeLogValue,
      )
      await mkdir(dirname(path), { recursive: true })
      await appendFile(path, `${line}\n`, "utf8")
    } catch {
      // Logging is best-effort: a sink failure must never break an opencode session.
    }
  }

  return {
    debug: (fields) => write("debug", fields),
    info: (fields) => write("info", fields),
    warn: (fields) => write("warn", fields),
    error: (fields) => write("error", fields),
  }
}
