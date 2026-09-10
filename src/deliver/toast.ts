import type { Logger } from "../log"
import type { Note } from "../notes"

type ToastResult = Readonly<{
  data: unknown
  error: unknown
  response: Pick<Response, "ok" | "status">
}>

export type ToastRequest = Readonly<{
  body: Readonly<{
    title: string
    message: string
    variant: "info" | "warning" | "error"
    duration: number
  }>
}>

export type ToastClient = Readonly<{
  showToast: (request: ToastRequest) => Promise<ToastResult>
}>

export async function showNoteToast(client: ToastClient, log: Logger, note: Note): Promise<void> {
  await showToast(client, log, {
    title: `Advisor · ${note.severity}`,
    message: note.note.slice(0, 240),
    variant: note.severity === "nit" ? "info" : note.severity === "concern" ? "warning" : "error",
    duration: 8000,
  })
}

export async function showToast(
  client: ToastClient,
  log: Logger,
  body: ToastRequest["body"],
): Promise<void> {
  try {
    const result = await client.showToast({ body })
    if (!result.response.ok || result.error !== undefined) {
      await log.debug({ msg: "advisor toast unavailable", status: result.response.status })
    }
  } catch (error) {
    await log.debug({ msg: "advisor toast unavailable", error })
  }
}
