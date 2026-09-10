const IGNORED_EVENT_TYPES: ReadonlySet<string> = new Set([
  "server.instance.disposed",
  "installation.updated",
  "installation.update-available",
  "lsp.client.diagnostics",
  "lsp.updated",
  "message.removed",
  "message.part.updated",
  "message.part.removed",
  "permission.updated",
  "permission.replied",
  "session.idle",
  "session.compacted",
  "file.edited",
  "todo.updated",
  "command.executed",
  "session.diff",
  "session.error",
  "file.watcher.updated",
  "vcs.branch.updated",
  "tui.prompt.append",
  "tui.command.execute",
  "tui.toast.show",
  "pty.created",
  "pty.updated",
  "pty.exited",
  "pty.deleted",
  "server.connected",
])

export function isIgnoredEventType(eventType: string): boolean {
  return IGNORED_EVENT_TYPES.has(eventType)
}
