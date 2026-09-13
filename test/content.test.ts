import { afterEach, expect, spyOn, test } from "bun:test"
import { execFile } from "node:child_process"
import * as files from "node:fs/promises"
import { chmod, lstat, mkdir, mkdtemp, rename, rm, symlink, truncate, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { WorktreeContents } from "../src/advisor/content"
import type { TranscriptMessage } from "../src/delta"

const exec = promisify(execFile)
const fixtures: string[] = []
afterEach(async () => { await Promise.all(fixtures.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })

async function repository() {
  const directory = await mkdtemp(join(tmpdir(), "advisor contents "))
  fixtures.push(directory)
  const git = (...args: string[]) => exec("git", ["-C", directory, ...args])
  await git("init", "--quiet")
  await writeFile(join(directory, "tracked.ts"), "export const tracked = 1\n")
  await git("add", "--", "tracked.ts")
  return { directory, git, contents: new WorktreeContents(directory) }
}

function mutation(tool: string, input: Record<string, unknown>): TranscriptMessage {
  return {
    info: {
      id: "edit", sessionID: "root", role: "assistant", time: { created: 1, completed: 2 },
      parentID: "request", providerID: "test", modelID: "test", mode: "build",
      path: { cwd: "/project", root: "/project" }, cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [{
      id: "tool", sessionID: "root", messageID: "edit", type: "tool", callID: "call", tool,
      state: { status: "completed", input, output: "", title: tool, metadata: {}, time: { start: 1, end: 2 } },
    }],
  }
}

test("content fingerprints detect edits to existing untracked files", async () => {
  const { directory, contents } = await repository()
  await writeFile(join(directory, "draft.ts"), "export const draft = 1\n")
  const before = await contents.capture()
  expect(before).toBeString()
  expect(await contents.capture()).toBe(before)

  await writeFile(join(directory, "draft.ts"), "export const draft = 2\n")
  expect(await contents.capture()).not.toBe(before)
})

test.each(["edit", "apply_patch"])("content checks include explicit external %s paths", async (tool) => {
  const { contents } = await repository()
  const external = await mkdtemp(join(tmpdir(), "advisor-external-"))
  fixtures.push(external)
  const path = join(external, "settings.jsonc")
  await writeFile(path, '{"enabled": true}\n')
  const messages = [mutation(tool, tool === "edit" ? { filePath: path } : {
    patchText: `*** Begin Patch\n*** Update File: ${path}\n@@\n*** End Patch`,
  })]
  const before = await contents.capture(messages)
  expect(before).toBeString()
  await writeFile(path, '{"enabled": false}\n')
  expect(await contents.capture(messages)).not.toBe(before)
})

test("staging and committing unchanged contents preserve their fingerprint", async () => {
  const { directory, contents, git } = await repository()
  await writeFile(join(directory, "new file.ts"), "export const added = true\n")
  const before = await contents.capture()
  expect(before).toBeString()
  await git("add", "--all")
  expect(await contents.capture()).toBe(before)
  await git("-c", "user.name=Advisor Test", "-c", "user.email=advisor@example.invalid",
    "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "Fixture commit")
  expect(await contents.capture()).toBe(before)
})

test("rename and deletion change fingerprints, and staging those changes does not", async () => {
  const { directory, contents, git } = await repository()
  const before = await contents.capture()
  await rename(join(directory, "tracked.ts"), join(directory, "renamed.ts"))
  const renamed = await contents.capture()
  expect(renamed).toBeString()
  expect(renamed).not.toBe(before)
  await git("add", "--all")
  expect(await contents.capture()).toBe(renamed)
  await rm(join(directory, "renamed.ts"))
  const deleted = await contents.capture()
  expect(deleted).toBeString()
  expect(deleted).not.toBe(renamed)
  await git("add", "--all")
  expect(await contents.capture()).toBe(deleted)
})

test("cached hashes detect same-size edits with restored mtime and executable-mode changes", async () => {
  const { directory, contents } = await repository()
  const path = join(directory, "tracked.ts")
  const stat = await lstat(path)
  const before = await contents.capture()
  await writeFile(path, "export const tracked = 2\n")
  await utimes(path, stat.atime, stat.mtime)
  const changed = await contents.capture()
  expect(changed).toBeString()
  expect(changed).not.toBe(before)
  await chmod(path, 0o755)
  expect(await contents.capture()).not.toBe(changed)
})

test("unknown scopes, oversized files, and symlinks decline deduplication", async () => {
  const { directory, contents } = await repository()
  expect(await contents.capture([mutation("edit", {})])).toBeUndefined()
  const large = join(directory, "large.bin")
  await writeFile(large, "")
  await truncate(large, 5 * 1024 * 1024)
  expect(await contents.capture()).toBeUndefined()
  await rm(large)
  await symlink("tracked.ts", join(directory, "linked.ts"))
  expect(await contents.capture()).toBeUndefined()
  await rm(join(directory, "linked.ts"))
  expect(await contents.capture()).toBeString()
})

test("a directory outside git keeps normal review available", async () => {
  const directory = await mkdtemp(join(tmpdir(), "advisor-no-git-"))
  fixtures.push(directory)
  expect(await new WorktreeContents(directory).capture()).toBeUndefined()
})

test("concurrent checks share file reads and unchanged files reuse their hashes", async () => {
  const { contents } = await repository()
  const reads = spyOn(files, "open")
  try {
    const [first, second] = await Promise.all([contents.capture(), contents.capture()])
    expect(first).toBeString()
    expect(second).toBe(first)
    expect(reads).toHaveBeenCalledTimes(1)
    reads.mockClear()
    expect(await contents.capture()).toBe(first)
    expect(reads).not.toHaveBeenCalled()
  } finally {
    reads.mockRestore()
  }
})

test("a session inside a subdirectory fingerprints its supplied worktree root", async () => {
  const { directory } = await repository()
  const nested = join(directory, "nested")
  await mkdir(nested)
  const contents = new WorktreeContents(nested, directory)
  const before = await contents.capture()
  expect(before).toBeString()
  await writeFile(join(directory, "tracked.ts"), "export const tracked = 2\n")
  expect(await contents.capture()).not.toBe(before)
})
