import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createLogger, redact } from "../src/log"
import { safe } from "../src/safe"

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
  test("writes one parseable JSON line", async () => {
    // Given
    const path = tempLogPath()
    const log = createLogger({ level: "debug", path })

    // When
    await log.info({ msg: "logger ready", component: "test" })

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
