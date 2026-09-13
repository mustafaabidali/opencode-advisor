import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createLogger, redact } from "../src/log"
import { safe } from "../src/safe"
import { LogBuffer } from "../src/log/buffer"

const tempDirectories: string[] = []

afterEach(() => {
  for (const directory of tempDirectories) {
    rmSync(directory, { recursive: true, force: true })
  }
  tempDirectories.length = 0
})

function tempLogPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "opencode-advisor-"))
  tempDirectories.push(directory)
  return join(directory, "advisor.log")
}

describe("redact", () => {
  test("redacts a Bearer token", () => {
    // Given
    const token = "Bearer abcdefghijklmnop1234"

    // When
    const result = redact(`authorization: ${token}`)

    // Then
    expect(result).toContain("[REDACTED]")
    expect(result).not.toContain(token)
  })

  test("redacts a UUID-shaped key", () => {
    // Given
    const key = "123e4567-e89b-12d3-a456-426614174000"

    // When
    const result = redact(`key=${key}`)

    // Then
    expect(result).toBe("key=[REDACTED]")
  })

  test("leaves plain text untouched", () => {
    // Given
    const text = "advisor pass completed"

    // When
    const result = redact(text)

    // Then
    expect(result).toBe(text)
  })

  test("redacts an AWS access key", () => {
    // Given
    const key = "AKIA1234567890ABCDEF"

    // When
    const result = redact(`key=${key}`)

    // Then
    expect(result).toBe("key=[REDACTED]")
  })
})

describe("createLogger", () => {
  test("a hung sink keeps one bounded queue and shutdown settles locally", async () => {
    const sink = Promise.withResolvers<void>()
    let writers = 0
    const buffer = new LogBuffer(async () => { writers++; await sink.promise }, 2048, 5)
    buffer.add("first\n")
    await buffer.flush()
    for (let i = 0; i < 1000; i++) buffer.add("x".repeat(100) + "\n")
    await buffer.close()
    expect(writers).toBe(1)
    expect(buffer.metrics.queued_bytes).toBeLessThanOrEqual(2048)
    expect(buffer.metrics.dropped).toBeGreaterThan(900)
    sink.resolve()
  })

  test("concurrent loggers rotate unique archives and retain parseable recent records", async () => {
    const path = tempLogPath()
    const first = createLogger({ level: "info", path, maxBytes: 300, retention: 2 })
    const second = createLogger({ level: "info", path, maxBytes: 300, retention: 2 })
    for (let i = 0; i < 10; i++) {
      await Promise.all([first.warn({ msg: "first", index: i, text: "x".repeat(100) }),
        second.warn({ msg: "second", index: i, text: "x".repeat(100) })])
    }
    await first.warn({ msg: "last", text: "x".repeat(400) })
    await first.warn({ msg: "final" })
    await Promise.all([first.close?.(), second.close?.()])
    const directory = path.slice(0, path.lastIndexOf("/"))
    const files = readdirSync(directory)
    expect(files.length).toBeLessThanOrEqual(3)
    for (const file of files) {
      const lines = (await Bun.file(join(directory, file)).text()).trim().split("\n")
      for (const line of lines) expect(() => JSON.parse(line)).not.toThrow()
    }
    expect(await Bun.file(path).text()).toContain('"msg":"final"')
  })

  test("ordinary writes accumulate until flushed and shutdown drains the last batch", async () => {
    const path = tempLogPath()
    const log = createLogger({ level: "info", path })
    await Promise.all(Array.from({ length: 30 }, (_, index) => log.info({ msg: "batch", index })))
    expect(await Bun.file(path).exists()).toBe(false)
    await log.close?.()
    const lines = (await Bun.file(path).text()).trim().split("\n")
    expect(lines).toHaveLength(30)
    expect(JSON.parse(lines.at(-1) ?? "")).toMatchObject({ index: 29 })
  })

  test("writes one parseable JSON line", async () => {
    // Given
    const path = tempLogPath()
    const log = createLogger({ level: "debug", path })

    // When
    await log.info({ msg: "logger ready", component: "test" })
    await log.flush?.()

    // Then
    const lines = (await Bun.file(path).text()).trimEnd().split("\n")
    expect(lines).toHaveLength(1)
    const record: unknown = JSON.parse(lines[0] ?? "")
    expect(record).toMatchObject({
      time: expect.any(String),
      level: "info",
      msg: "logger ready",
      component: "test",
    })
  })

  test("does not throw when its path is unwritable", async () => {
    // Given
    const log = createLogger({ level: "debug", path: "/dev/null/x/y.log" })

    // When / Then
    await expect(log.error({ msg: "cannot persist" })).resolves.toBeUndefined()
  })
})

describe("safe", () => {
  test("swallows a thrown error and logs the hook failure", async () => {
    // Given
    const path = tempLogPath()
    const log = createLogger({ level: "debug", path })
    const wrapped = safe(log, "session.status", async (code: number) => {
      throw new Error(`boom ${code}`)
    })

    // When
    const result = await wrapped(42)

    // Then
    expect(result).toBeUndefined()
    const record: unknown = JSON.parse((await Bun.file(path).text()).trim())
    expect(record).toMatchObject({
      level: "error",
      msg: "hook failed",
      hook: "session.status",
      error: {
        name: "Error",
        message: "boom 42",
      },
    })
  })
})
