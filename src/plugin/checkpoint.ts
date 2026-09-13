import { tool } from "@opencode-ai/plugin"
import type { TaskContexts } from "../advisor/context"
import { runCheckpoint } from "../checkpoint"
import type { AdvisorConfig } from "../config"
import type { Logger } from "../log"
import type { NoteStore } from "../notes"
import type { AdvisorPluginClient } from "./client"
import type { SessionHistory } from "../history/session"

export function checkpointTool(options: Readonly<{
  client: AdvisorPluginClient
  config: Pick<AdvisorConfig, "abort_on_blocker">
  contexts: TaskContexts
  log: Logger
  store: NoteStore
  directory: string
  isWatched: (sessionID: string) => boolean
  history?: SessionHistory
  recover?: (sessionID: string) => Promise<void>
  onTask?: (sessionID: string, task: "continue" | "replace" | "stop" | "resume", stopped: boolean) => Promise<void>
}>) {
  return tool({
    description: "Inspect advisor proposals already available and batch-record checked findings at a normal verification checkpoint. " +
      "Different remedies have separate finding IDs under one issue; resolving one does not dismiss alternatives. " +
      "Keep working while advisors run. Never wait or poll for outstanding reviews, including before completion. " +
      "Use task=replace only for an explicit replacement objective, stop/resume only for the user's instruction. " +
      "Inspect before updating. Use reviewed_revision and version from each finding; verification records evidence checked now. " +
      "Summaries are excerpts. Page with offset/limit; detail retrieves report or finding JSON chunks using report_offset/text_offset. " +
      "Action and completion gates cover all pages. Read full relevant details before verifying. " +
      "Status questions and optional improvements do not require a checkpoint before answering.",
    args: {
      phase: tool.schema.enum(["inspect", "before_action", "complete"]).default("inspect"),
      task: tool.schema.enum(["continue", "replace", "stop", "resume"]).default("continue"),
      next_action: tool.schema.string().optional().describe("The concrete action being considered, e.g. publish"),
      recover: tool.schema.boolean().optional().describe("Request a background recheck of paused advisors; returns immediately without waiting for recovery"),
      offset: tool.schema.number().int().nonnegative().optional().describe("First proposal, default 0"),
      limit: tool.schema.number().int().min(1).max(50).optional().describe("Proposals per page, default 20"),
      detail: tool.schema.object({
        finding_id: tool.schema.string(),
        kind: tool.schema.enum(["report", "finding"]).optional(),
        report_offset: tool.schema.number().int().nonnegative().default(0),
        text_offset: tool.schema.number().int().nonnegative().default(0),
      }).optional(),
      updates: tool.schema.array(tool.schema.object({
        id: tool.schema.string(),
        state: tool.schema.enum(["open", "resolved", "dismissed", "deferred"]),
        reviewed_revision: tool.schema.string(),
        version: tool.schema.number().int().nonnegative(),
        reason: tool.schema.string().min(1),
        evidence: tool.schema.array(tool.schema.string()).optional(),
        verification: tool.schema.object({
          in_scope: tool.schema.boolean(),
          affected_action: tool.schema.string().optional(),
          cost_if_delayed: tool.schema.string().optional(),
        }).optional(),
      })).default([]),
    },
    async execute(args, context) {
      const unavailable = "Advisor checkpoints are available only in a watched primary session."
      if (context.agent.startsWith("advisor-") || !options.isWatched(context.sessionID)) {
        return unavailable
      }
      if (args.recover) void Promise.resolve().then(() => options.recover?.(context.sessionID))
        .catch((error: unknown) => options.log.warn({ msg: "advisor background recovery failed", sessionID: context.sessionID, error }))
        .catch(() => {})
      const result = options.history === undefined ? await options.client.session.messages({
        path: { id: context.sessionID }, query: { directory: options.directory },
      }) : { data: await options.history.read(context.sessionID, true), error: undefined, response: { ok: true } }
      if (!options.isWatched(context.sessionID)) return unavailable
      if (!result.response.ok || result.error !== undefined || result.data === undefined) {
        throw new Error("Could not read the current session for the advisor checkpoint")
      }
      await options.contexts.capture(context.sessionID, result.data)
      if (!options.isWatched(context.sessionID)) return unavailable
      const current = await options.contexts.checkpoint(context.sessionID, args.task, args.next_action)
      await options.onTask?.(context.sessionID, args.task, current.stopped)
      if (!options.isWatched(context.sessionID)) return unavailable
      const report = await runCheckpoint({
        store: options.store, directory: options.directory, sessionID: context.sessionID,
        phase: args.phase, context: current,
        ...(args.offset === undefined ? {} : { offset: args.offset }),
        ...(args.limit === undefined ? {} : { limit: args.limit }),
        ...(args.detail === undefined ? {} : { detail: { ...args.detail, kind: args.detail.kind ?? "report" } }),
        updates: args.updates.map(({ evidence, verification, ...update }) => ({
          ...update,
          ...(evidence === undefined ? {} : { evidence }),
          ...(verification === undefined ? {} : { verification: {
            in_scope: verification.in_scope,
            ...(verification.affected_action === undefined ? {} : { affected_action: verification.affected_action }),
            ...(verification.cost_if_delayed === undefined ? {} : { cost_if_delayed: verification.cost_if_delayed }),
          } }),
        })),
      })
      if (!options.isWatched(context.sessionID)) return unavailable
      const paused = [...report.issues.flatMap((issue) => issue.proposals), ...report.unavailable_reports]
        .filter((proposal) => proposal.decision.action === "pause_affected_action")
      if (options.config.abort_on_blocker && args.phase === "before_action" && report.pause_required) {
        const findingIDs = paused.map((proposal) => proposal.finding.id)
        const result = await options.client.session.abort({ path: { id: context.sessionID } })
        const ok = result.response.ok && result.error === undefined
        await options.log[ok ? "info" : "warn"]({
          msg: ok ? "advisor blocker paused the named action" : "advisor blocker abort failed",
          sessionID: context.sessionID, next_action: args.next_action, findingIDs,
          paused_finding_count: report.paused_finding_count,
        })
      }
      return JSON.stringify({ ...report, ...(args.recover ? { recovery_requested: options.recover !== undefined } : {}) })
    },
  })
}
