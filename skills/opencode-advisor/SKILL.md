---
name: opencode-advisor
description: >-
  Advisor watchdog: reviewer cards, advisor_checkpoint, /advisor status and notes, the WATCHDOG.yml roster, WATCHDOG.md priorities, advisor.jsonc behavior, and the opencode-advisor plugin source. Use when a card lands or the user asks what the advisor said, wants to change or disable a reviewer or its model, fallback, or effort, asks why no card appeared, or is editing the plugin.
---

# OpenCode Advisor

Independent reviewer models watch the primary session's transcript in child sessions and deliver native `advisor` tool-result cards. The primary model and its routing are untouched. A card's first line is `<glyph> Advisor · <model> (<level>) · nit|concern|blocker`, where the glyph is `◉` for blocker, `◎` for concern, `○` for nit, with ` · fallback` when the retry model wrote it.

**Startup-loaded**: the roster, WATCHDOG.md, advisor.jsonc, the `/advisor` command, this skill, and the plugin source are read once when OpenCode starts. Every edit to any of them lands after a quit and restart.

## Cards

The standing rule governs a card: verify current evidence and scope, honor user steering, and compare proposals at normal checkpoints. A severity label alone never interrupts all work. Pause only an affected next action with verified cost of delay; a status question preserves the ongoing objective. To dig into a card's basis:

- `ctrl+x ↓` enters the `advisor:<slug>` child session where the reviewer reasoned and used tools; `ctrl+x ←` / `→` moves between related sessions. Turn on OpenCode's `display_thinking` to see reviewer reasoning there.
- `advisor notes --last N --json` returns full persisted notes with reasoning and evidence; without `--json`, it prints summaries.

Keep working while advisors run. Never wait, sleep, or poll for an advisor response, including before claiming completion. Use `advisor_checkpoint` at existing verification checkpoints to inspect proposals already available, then batch-record `open`, `resolved`, `dismissed`, or `deferred` dispositions with reasons. An empty inbox requires no repeated check; consider later notes when they arrive. Resolution and reopening require checked evidence. A verified, relevant concern or blocker already received needs an in-scope fix or an explicit justified disposition; optional improvements can be deferred. This is not a per-note or per-tool-call ritual.

Each underlying issue can have several independent proposed remedies. Resolving the faster reviewer's proposal does not suppress a later different fix or new evidence. Compare merit and task benefit regardless of arrival time or model label. Closed proposals stay closed unless explicitly reopened with new evidence. Supply each finding's `reviewed_revision` and `version` when updating it; inspect again if either changed. Equivalent new reports preserve the version, but every disposition or verification update advances it.

Use `task=continue` normally, `task=replace` for an explicit replacement objective, and `task=stop/resume` for the user's stop/resume instruction. A routine checkpoint never clears a stop. Verification uses observed worktree snapshots/tool changes, not a guarantee that external files are unchanged; inspect the actual code and output.

Checkpoint schema v2 returns at most 20 proposals by default (50 maximum). Follow `page.next_offset`; global completion/action gates and unavailable counts include every page. Summary text is an excerpt. Use `detail: { finding_id, kind: "report", report_offset, text_offset }` for full report JSON chunks, or `kind: "finding"` for full provenance/disposition data. Read relevant complete details before recording verification. Chunks are at most 6,000 characters.

Completed reviewers enter delivery independently; slower reviewers continue. Redundant reports retain provenance and share the finding's delivery status; a genuine reopening with checked evidence makes subsequent reports eligible for injection and cards again. Checkpoints list missing or corrupt reports under `unavailable_reports`, alongside readable proposals. Restore unavailable reports or record a justified disposition after checking the issue before claiming completion.

## Read state

- `/advisor` runs `advisor status` and then `advisor notes --last 5`, verbatim.
- `advisor status [--json]`: models, fallbacks, tools, cooldowns, per-instance pass/note counts, durable usage and coverage, execution state, build fingerprint/instance, watched sessions.
- `advisor index [--all]`: resumable legacy metadata/receipt migration; listing warns until coverage is complete.
- `advisor repair-receipts`: restore canonical SQLite delivery markers to JSON before rollback, with every writer stopped.
- `~/.local/share/opencode-advisor/advisor.log`: startup warnings, every pass with its outcome, fallback, and card delivery.

Pass outcomes, as they appear in status, transcripts, and the log:

| Outcome | Meaning |
| --- | --- |
| `ok` | The reviewer wrote at least one note. |
| `silent` | The reviewer completed without recorded advice; `<silent/>` is the expected reply, and no card is expected. |
| `fallback` | The configured fallback completed the pass, possibly silently. Cards it produces end in ` · fallback`. |
| `no_model` | Primary and fallback are both unavailable or cooled; the pass was skipped. |
| `error`, `timeout`, `quarantined` | Local or provider failure, execution deadline reached, or a note matched `quarantine_patterns` and was withheld. |
| `context_budget_exceeded` | Required findings/evidence cannot safely fit the rollover carry. Inspect findings or increase the configured carry budget. |

Each reviewer progresses independently. Optional provider admission defaults to unlimited (`0`) and coordinates the same process/data directory/limit configuration, not every application or machine. Throttle/retry events and empty content-filtered responses can use the configured fallback when at least `min_fallback_budget_ms` remains (30 seconds by default); otherwise a later pass can use its full budget. An unconfirmed remote cancellation cannot start another overlapping request. `recover: true` on a checkpoint requests a background recheck of uncertain requests or report commits, including those marked `recovery_required`; the checkpoint returns without waiting for recovery. Never poll it while waiting for a reviewer.

Repeated timeouts back off only the affected reviewer. Expiry does not schedule a review by itself; retry happens on the next work notification after the delay. A completely idle primary does not wait or poll to trigger it.

Cursors and unfinished pass identities persist. A live local process keeps exclusive ownership of its reviewer lane; `owned_elsewhere` is not permission to abort it. After release or confirmed owner exit, reconcile pending work before retrying. Restarts and context rollover prime a fresh child from open findings and compact closed dispositions; unknown model capacity is disclosed, and required open evidence is never silently discarded. Stop remains in effect across restart, while resume releases retained findings for normal delivery checks.

A corrupt review journal pauses only its reviewer with `recovery_required` and needs manual inspection or restoration. There is no journal-repair command or automatic reset; `repair-receipts` repairs delivery mirrors only. The primary and other reviewers keep working.

Usage coverage can be partial or unknown. Counts include observed intermediate, fallback, failure, and compaction messages; cost is still an upstream estimate. Legacy transcript totals are excluded. Restart all OpenCode instances when updating the plugin so every writer understands authoritative SQLite receipts. Before rollback, stop all writers and repair JSON receipt mirrors using the new CLI.

## Change who reviews

The first existing file in this order is the roster; files are not merged:

1. `<repo>/WATCHDOG.yml`, `<repo>/WATCHDOG.yaml`
2. `<repo>/.opencode/WATCHDOG.yml`, `<repo>/.opencode/WATCHDOG.yaml`
3. `~/.config/opencode/WATCHDOG.yml`, `~/.config/opencode/WATCHDOG.yaml`
4. `~/.omp/agent/WATCHDOG.yml`, `~/.omp/agent/WATCHDOG.yaml`

`~/.omp/agent/WATCHDOG.yml` belongs to omp and is read as-is. To run a different lineup, create a higher-priority file carrying the whole roster, because the first match shadows everything below it. `advisor status` shows which roster is live.

The annotated schema is `WATCHDOG.example.yml` in the plugin repository. The rules the file does not spell out:

- A model reference is `<provider>/<model-id>[:level]`. `provider_aliases` rewrites the prefix (`bedrock-mantle/` → `amazon-bedrock/` by default). The level is passed to OpenCode as the agent variant; OpenCode maps it to the provider's reasoning option using its own model catalog, so any level the model declares there works and the plugin adds nothing model-specific. `variant_aliases` rewrites a requested level to a variant OpenCode does know; the card still shows the requested level.
- The plugin ships no model. An entry without `model` uses `default_model`; with neither, the entry is skipped with a startup warning, and with no roster file at all, no advisor runs until `default_model` is set.
- Each advisor has at most one fallback. An entry that omits `fallback` uses `default_fallback`, or `default_model` when `default_fallback` is the entry's own model, or none. An explicit `fallback` equal to the entry's model is dropped with a startup warning.
- `tools` defaults to `[read, grep, glob]`; `list` is also investigative and prompt-free. `edit`, `write`, `patch`, `multiedit`, `bash`, and `webfetch` keep their OpenCode permission prompts. Everything else, including every MCP tool, is denied. `search` means `grep`; `find` means `glob`.
- `when` on an entry gates that reviewer: it runs only when the delta since its last pass has a completed `edit`/`write`/`apply_patch` whose path matches an `edits` glob, a completed `bash` whose command matches a `commands` regex, or a tool named in `tools`. Skipped deltas carry over. No `when` means every step. An empty or all-invalid `when` never runs and warns at startup. Name `task` in `tools` if delegated edits should trigger a pass; sub-agent sessions are not watched. Per-entry `chat_min_severity` and `inject_min_severity` override the global floors.
- `instructions` on an entry specializes that reviewer; top-level `instructions` reach every reviewer. Severity definitions and the `<silent/>` protocol come from the plugin's own reviewer contract, which wins over roster wording.

Add a reviewer:

```yaml
advisors:
  - name: Security reviewer
    model: <provider>/<model-id>:<level>
    fallback: <provider>/<other-model-id>:<level>
    tools: [read, grep, glob]
    min_severity: concern
    instructions: |
      Check authentication, permissions, secret handling, and unsafe commands.
```

Set `enabled: false` to keep an entry without running it. Review priorities for every reviewer, without touching the primary, go in `<repo>/WATCHDOG.md` (project, first) and `~/.config/opencode/WATCHDOG.md` (global, appended).

## Change how it behaves

`~/.config/opencode/advisor.jsonc` is global; `<repo>/.opencode/advisor.jsonc` overlays it. Objects merge, arrays replace. Current defaults are in `src/config/defaults.ts`, re-exported as `DEFAULTS` by `src/config.ts`; the README describes every key. Reinstallation preserves existing configuration files, so older installed copies may omit newer keys and inherit their defaults.

- `min_severity` is a recording floor; `chat_min_severity` is a card floor; `inject_min_severity` feeds eligible observations into the next step for checkpoint consideration. All recorded notes remain in the inbox. Defaults are `nit` / `blocker` / `concern`, with `toast: false` and `abort_on_blocker: false`. Grading stays in the reviewer contract. The optional abort fires only from an `advisor_checkpoint` with `phase: "before_action"` whose `next_action` matches a verified blocker's `affected_action` with a cost of delay. Receiving a report never triggers an abort.
- `OPENCODE_ADVISOR_ENABLED=0 opencode` runs one process with every advisor hook off; `OPENCODE_ADVISOR_LOG_LEVEL=debug opencode` overrides logging for one process.

## Troubleshoot

- No advisor runs and the log says `no default_model configured`: the roster has an entry without `model`, or there is no roster file. Name a model on each entry or set `default_model`.
- A card is delivered only when the watched session is idle and the latest real user turn has completed. Look for `advisor pass end` and `advisor card delivered`; `advisor card skipped` carries the `status` (`duplicate`, `expired`, `inactive`, `delivered`) of a queued note that no longer needs a card, and `advisor note withheld` names the policy `reason` (for example `unsupported_observation` for a note without evidence) when nothing reached the queue. Native rendering uses no shell or model request; a retry updates the same part. `delivered_at` requires a matching rendered note; expiry records `expired_at` separately.
- `no_model` in status: run `advisor status --json` and read `cooled_until`. A failed primary stays cooled for `fallback_cooldown_ms`. When no status snapshot exists, the command prints a plain-text notice even with `--json`.
- The log shows `Cache point cannot be inserted after reasoning block` (Bedrock 400, transcript `failure_kind: poisoned_session`): a reviewer with extended thinking ended a pass with reasoning and no text, so the next pass's cache point landed after the reasoning block. The `<silent/>` protocol prevents it; when it happens anyway, the plugin replaces the child session and retries once on the same model without cooling it, at the cost of one full cache write.
- A toast is missing but the card and notes exist: toasts default off, or the process has no TUI.

## Modify the plugin

Work test-first: make the relevant `bun test` case fail, then make it pass. Done means `bun test` and `bun run typecheck` pass, every touched source file is at or below 250 lines, and the diff adds no `any`, type suppression, or permission bypass. `~/.omp` stays untouched; roster compatibility with omp is read-only. Work plans go in `.omo/plans/`, receipts in `.omo/evidence/`, and `.omo/` stays out of git.

`scripts/install.sh` symlinks `src/plugin.ts`, `bin/advisor.ts`, and this skill into OpenCode's user directories, so the repository is the live source: a new OpenCode process runs the working tree as-is.

Where things live:

- `src/plugin.ts`: loads config and roster, composes hooks, wires watcher, runtime, and delivery.
- `src/watcher.ts`, `src/watcher/scheduler.ts`: track watched sessions; debounce, cool down, and suppress passes.
- `src/advisor/runtime.ts`: schedules independent reviewers and routes arrived results to delivery.
- `src/advisor/lane.ts`, `src/advisor/recovery.ts`, `src/advisor/child.ts`: one reviewer's cursor, active pass, child context and pending recovery. Stable pass IDs prevent older completions from advancing newer progress.
- `src/advisor/pass.ts`, `src/advisor/attempt.ts`: provider calls, cancellation, fallback and permit release.
- `src/deliver/*`, `src/plugin/render.ts`: idle-only native cards, retry acknowledgment, turn gating, injection, and the standing rule.
- `src/policy.ts`, `src/checkpoint.ts`, `src/notes/findings.ts`: advice eligibility, independent proposals, batch dispositions, and persisted task context.
- `src/notes/database*.ts`, `src/notes/schema.ts`, `src/notes/queries.ts`: worker ownership, persistent SQLite connections, migrations, state versions, and scoped batch reads.
- `src/roster/*`: discover and parse rosters, resolve models and fallbacks, register locked-down advisor agents.
- `src/models.ts`: model references, variants and effort, failure classification, cooldowns.
- `src/delta.ts`: redacted transcript deltas that exclude advisor delivery.
- `src/advice.ts`: `<advice>` parsing, severity floor, quarantine.
- `src/notes/store.ts`, `src/notes/catalog.ts`: notes, pending pointers, transcripts, indexed delivery receipts, status snapshots.
- `src/usage/*`: durable per-message accounting through the shared SQLite worker.
- `src/advisor/journal.ts`: durable reviewer ownership and restart progress; retains outstanding lane closures until ownership release before closing its database handle.
- `src/history/*`, `src/log/*`: bounded history projections, batched logs, and rotation.
- `src/prompts.ts`: reviewer contract, pass prompt, standing rule, blocker injection.
- `src/config.ts`, `src/config/defaults.ts`: JSONC precedence, environment overrides, data directory and defaults.
- `bin/advisor.ts`: `status`, `notes`, `index`, `repair-receipts`, `--note <id>`, pending-card output and `--version`.

Invariants:

- The primary never waits for reviewer execution or recovery, even before completion. Checkpoints inspect arrived findings.
- Pending result publication belongs to the reviewer lane; durable lane release belongs to the journal. Keep completion watchers and ownership registries with their owner.
- Cards are delivered only at idle on a watched session; real user turns pause the remaining batch. Native delivery never creates a user message or prompts the primary.
- `session.prompt` targets advisor child sessions only.
- Delivery-agent messages and native advisor output are excluded from deltas and pass triggers.
- Only redundant proposals deduplicate; a different remedy or new evidence remains independently reviewable.
- Advisor agents start with every tool and permission denied and unlock only the roster's explicit grants.
