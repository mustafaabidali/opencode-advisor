import { expect, test } from "bun:test"
import { createOpencodeClient } from "@opencode-ai/sdk"
import type { Note } from "../src/notes"
import { createNativeRenderer } from "../src/plugin/render"

const note: Note = {
  id: "20260912-200000-000001", time: "2026-09-12T20:00:00.000Z",
  cwd: "/project", root_session: "ses_root", advisor_session: "ses_reviewer",
  advisor_slug: "oracle", roster_name: "Oracle", provider: "test", model: "test/model",
  model_display: "Reviewer", variant: "default", severity: "blocker",
  reasoning: "The command failed", note: "Check the requested render",
  evidence: ["src/deliver/cards.ts"], is_fallback: false, quarantined: false,
}

test("native rendering reuses the SDK's embedded transport and writes a card once without a shell", async () => {
  const paths: string[] = []
  const parts: unknown[] = []
  const info = {
    id: "msg_primary", role: "assistant", sessionID: note.root_session, parentID: "msg_user",
    time: { created: 1, completed: 2 }, agent: "build", mode: "build",
  }
  const client = createOpencodeClient({
    baseUrl: "http://embedded.test",
    headers: { authorization: "Bearer fixture" },
    fetch: async (request) => {
      expect(request.headers.get("authorization")).toBe("Bearer fixture")
      const path = new URL(request.url).pathname
      paths.push(`${request.method} ${path}`)
      if (path === "/session/status") return Response.json({})
      if (request.method === "PATCH") {
        const part: unknown = await request.json()
        parts.push(part)
        return Response.json(part)
      }
      if (path === "/session/ses_root/message") return Response.json([
        { info, parts },
        { info: { ...info, id: "legacy-delivery", mode: "advisor-delivery", agent: undefined }, parts: [] },
      ])
      throw new Error(`Unexpected request ${path}`)
    },
  })
  const render = createNativeRenderer(client)

  expect(await render({ note, directory: "/project", canRender: () => true })).toBe("msg_primary")
  expect(await render({ note, directory: "/project", canRender: () => true })).toBe("msg_primary")
  expect(parts).toHaveLength(1)
  expect(paths.some((path) => path.includes("/shell"))).toBeFalse()
  expect(parts[0]).toMatchObject({
    type: "tool", tool: "advisor", sessionID: "ses_root", messageID: "msg_primary",
    state: { status: "completed", input: { noteID: note.id }, metadata: { noteID: note.id } },
  })
})
