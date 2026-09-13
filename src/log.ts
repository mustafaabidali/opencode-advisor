import { homedir } from "node:os"
import { join } from "node:path"
import { LogBuffer } from "./log/buffer"
import { rotatingLog } from "./log/file"

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
  flush?: () => Promise<void>
  close?: () => Promise<void>
}>

export type LoggerOptions = Readonly<{
  level: LogLevel
  path?: string
  maxBytes?: number
  retention?: number
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
  const buffer = new LogBuffer(rotatingLog(path, options.maxBytes ?? 10 * 1024 * 1024, options.retention ?? 3))

  const write = async (level: LogLevel, fields: LogFields): Promise<void> => {
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[options.level]) return

    try {
      let line = JSON.stringify(
        {
          time: new Date().toISOString(),
          level,
          ...fields,
        },
        serializeLogValue,
      )
      if (Buffer.byteLength(line) > 16 * 1024) {
        line = JSON.stringify({ time: new Date().toISOString(), level, msg: redact(fields.msg).slice(0, 500),
          truncated: true, detail: line.slice(0, 3000) })
      }
      buffer.add(`${line}\n`)
      if (level === "warn" || level === "error") await buffer.flush()
    } catch {
      // Logging is best-effort: a sink failure must never break an opencode session.
    }
  }

  return {
    debug: (fields) => write("debug", fields),
    info: (fields) => write("info", fields),
    warn: (fields) => write("warn", fields),
    error: (fields) => write("error", fields),
    flush: () => buffer.flush(),
    close: () => buffer.close(),
  }
}
