# OpenCode Advisor

An asynchronous reviewer watchdog for OpenCode. Independent reviewer models read the primary session's transcript in child sessions, may inspect the repository with explicitly granted tools, and deliver only actionable `nit`, `concern`, or `blocker` notes. The primary model and its routing are untouched.

## Cards

Eligible notes appear as native `advisor` tool-result cards on the latest completed assistant message, delivered only while the session is idle:

```text
◎ Advisor · <model name> (<level>) · concern
reasoning: The error branch silently discards the failure required by the specification.
note: Return the non-ENOENT error and add a regression test for that branch.
evidence: src/config.ts, test/config.test.ts
finding: <note id>
```

The first line opens with a severity glyph (`◉` blocker, `◎` concern, `○` nit) and names the display model and level once; the roster name and long provider id stay out of the card. A card produced by the retry model ends in ` · fallback`. With `toast` on, a toast titled `Advisor · <severity>` accompanies each card.

The primary treats cards as fallible observations and verifies the current code before acting. User questions get a prompt answer; a status question preserves the ongoing objective, while an explicit stop or replacement takes priority. Severity alone does not halt work. Only a verified blocker with a concrete cost of delay can pause its named affected action; unrelated work remains available.

The defaults are `min_severity: "nit"`, `chat_min_severity: "blocker"`, `inject_min_severity: "concern"`, `toast: false`, and `abort_on_blocker: false`. Blockers become cards; concerns reach the primary as observations for its next verification checkpoint; nits remain available in the inbox. Injections last until delivery, disposition, or `note_ttl_turns` user turns. These floors control visibility, not how reviewers grade.

Delivery uses a stable part ID and checks the returned note identity and exact content before recording `delivered_at`. It creates no shell command, user message, or model response. A new user turn pauses the remaining card batch until that turn has completed. Explicit CLI retries remain available for legacy integrations: `advisor --note <id>` renders the same eligible note even after its queue pointer was claimed. An expired card records `expired_at`; HTTP success alone never acknowledges a card.

Each reviewer’s completed result enters delivery immediately, subject to those turn and policy checks. Slower reviewers keep running; their alternative fixes remain available even after an earlier result has been handled. An injection that arrives during a transform’s finding-state read stays queued for the next transform, which rechecks task and disposition rules.

Redundant reports share their finding’s delivery status and retain their reviewer provenance. A genuine reopening with checked evidence makes subsequent reports eligible for injection and card delivery again.

## Findings and checkpoints

The primary keeps working while advisors run. It never waits, sleeps, or polls for their responses, including before completion. At normal verification checkpoints, `advisor_checkpoint` inspects proposals already available and can record several dispositions: `open`, `resolved`, `dismissed`, or `deferred`. An empty inbox requires no further check. Later notes remain available when they arrive. Resolution and reopening require checked evidence. A verified, relevant concern already received still requires an in-scope fix or an explicit, justified disposition before completion; optional improvements can be deferred.

An `issue_id` groups the underlying failure and location within a task. A `finding_id` identifies one proposed remedy and its evidence. Redundant proposals merge with all reviewer provenance retained. Different fixes or new evidence remain separate proposals, even if an earlier reviewer’s remedy was already resolved. The checkpoint presents alternatives together; the primary compares evidence and benefit to the requested task, rather than arrival time or model label.

Dispositions and task context persist in `findings.sqlite`. Closed proposals stay closed across repeated steps, restarts, and duplicate reports. A new proposal does not reopen an older one. Supply the inspected finding’s `reviewed_revision` and `version` with each update. Every disposition or verification advances `version`; a redundant report preserves it. Stale batches are rejected atomically and must be inspected again. Verification records the current observed revision. This uses OpenCode worktree snapshots and observed tool changes, so external edits still require direct verification. A changed revision never counts as a fix.

A missing or corrupt report appears under `unavailable_reports` in the checkpoint result. Other proposals remain readable, but completion stays unapproved while an active proposal has unavailable reports. Current verified evidence of a named action’s cost of delay continues to block that action if its report becomes unavailable. Restore the report or record a justified disposition after checking the underlying issue.

Checkpoint responses use `schema_version: 2`. The default page contains 20 proposals (maximum 50); use `offset` and `limit`, then follow `page.next_offset`. Summaries contain excerpts and provenance counts. Retrieve complete report text with `detail: { finding_id, kind: "report", report_offset, text_offset }`, or full finding/provenance JSON with `kind: "finding"`. Detail JSON is returned in chunks of at most 6,000 characters. Completion and action decisions, omitted counts, and unavailable-report counts cover the whole relevant set, including pages that are not displayed. Inspect the full relevant detail before verifying a proposal.

Use `task: "replace"` only when the user replaces the objective, `stop`/`resume` for explicit stop/resume instructions, and `continue` for ordinary checkpoints. `next_action` names the action under consideration. The tool’s completion and action fields are guidance to the primary, not a global lock on OpenCode tools.

Reviewer reasoning and tool use stay browsable in the `advisor:<slug>` child session: `ctrl+x ↓` enters it, `ctrl+x ←` / `→` moves between related sessions.

## Scheduling, recovery, and context

Each root/reviewer pair has its own cursor, cooldown, and coalesced follow-up. A slow reviewer does not delay the next pass of a fast reviewer. This can produce more fast-reviewer passes, and therefore more model spend, during sustained work. Optional provider admission is fair between roots; `max_concurrent_passes_per_provider: 0` leaves concurrency unlimited. A positive limit applies to plugin instances in the same process sharing the data directory and limit setting. It does not coordinate different processes, machines, or other applications.

`pass_timeout_ms` is one execution budget for preparation, child creation, requests, refreshes, and fallback. Waiting for a provider slot has a separate cumulative `admission_timeout_ms` budget. Upstream throttle/retry events and content-filtered responses (including empty filtered finishes) trigger the configured fallback when time remains. Local cancellation does not prove the upstream request stopped: an unconfirmed remote abort holds its lane and permit until a late result or an explicit reconciliation confirms termination.

Status distinguishes preparation, admission queueing, running, report persistence, uncertain cancellation, and `recovery_required`. Reconciliation backs off on later work notifications and pauses after three unsuccessful probes. `advisor_checkpoint` with `recover: true` requests a background recheck and returns the current inbox without waiting for recovery; it never overrides uncertain execution. Reports returned while persistence is delayed are retained for reconciliation without another provider request. Repeated timeouts back off per reviewer, starting at the greater of one second or `cooldown_ms` and doubling up to five minutes (or `cooldown_ms` when higher). Time spent confirming cancellation counts toward this gap; elapsed time alone never releases an uncertain request. Known provider failures use the fallback policy rather than this timeout delay.

Backoff expiry does not start a review by itself. The reviewer retries on the next work notification after the delay; a completely idle primary does not poll or wait for it.

Reviewed cursors and unfinished pass identities persist in SQLite. A local process owns each root/reviewer lane exclusively; a new process will not take over from a live owner. After a clean release or a confirmed dead owner, unfinished work is reconciled before another prompt. A damaged journal pauses its reviewer with `recovery_required` while other reviewers continue; repair the stored progress before requesting recovery. An idle cursor survives restart; a new child receives current instructions and recorded findings. Existing children remain browsable. A stop persists across restarts and suppresses dispatch and delivery until an explicit resume; replacement invalidates the old delivery generation.

Reviewer children rotate only between completed passes. A soft budget uses 70% of the model catalog's context limit, or `context_budget_tokens` when configured. The latest response's context-token estimate drives rotation; cumulative billed usage is tracked separately. Unknown capacity is reported as unavailable. Open findings and their evidence are carried within `context_carry_chars`. Closed proposals use compact disposition summaries, omitted with a count when space is needed for open work. Missing or oversized required open context pauses with `context_budget_exceeded`.

Ordinary review preparation shares a bounded history projection (2 MiB per root, 16 MiB overall, up to 200 roots). Completed dirty messages use point reads. Compaction, removals, unknown anchors, or reconnects invalidate it; a 30-second refresh catches event gaps. Checkpoints request a fresh server sample. Events arriving during a sample prevent caching it, without forcing repeated reads until the primary stops streaming. Oversized sessions are read without caching; cursors retain at most 2,048 message and 8,192 part fingerprints plus one digest of older content. Unchanged older content is skipped; a changed prefix is conservatively reviewed again.

## Install

```sh
bash scripts/install.sh
```

The installer is idempotent. It runs `bun install` and symlinks `src/plugin.ts` to `~/.config/opencode/plugins/advisor.ts`, `bin/advisor.ts` to `~/.local/bin/advisor`, and `skills/opencode-advisor` to `~/.config/opencode/skills/opencode-advisor`, warning when `~/.local/bin` is outside `PATH`. It creates `~/.config/opencode/advisor.jsonc` and `~/.config/opencode/command/advisor.md` only when absent, so edited copies survive reinstalls. Because the links point at the working tree, a new OpenCode process runs the repository as-is.

```sh
bash scripts/uninstall.sh
```

removes the three symlinks and leaves configuration, notes, transcripts, state, and logs in place.

Everything below is **startup-loaded**: quit and restart OpenCode after editing the roster, `WATCHDOG.md`, `advisor.jsonc`, the command, the skill, or the plugin source.

## Roster: `WATCHDOG.yml`

The first existing file in this order is the roster; files are not merged, so a higher-priority file must carry the whole lineup:

1. `<cwd>/WATCHDOG.yml`, `<cwd>/WATCHDOG.yaml`
2. `<cwd>/.opencode/WATCHDOG.yml`, `<cwd>/.opencode/WATCHDOG.yaml`
3. `~/.config/opencode/WATCHDOG.yml`, `~/.config/opencode/WATCHDOG.yaml`
4. `~/.omp/agent/WATCHDOG.yml`, `~/.omp/agent/WATCHDOG.yaml`

Position 4 lets an existing omp roster work unchanged. With no roster at all, one enabled advisor named `Advisor` runs on `default_model`; the plugin ships no model of its own, so with neither a roster nor `default_model` no advisor runs and the log says so. [`WATCHDOG.example.yml`](WATCHDOG.example.yml) is the annotated schema:

| Location | Key | Default | Meaning |
| --- | --- | --- | --- |
| Top level | `instructions` | none | Text appended to every reviewer's prompt. |
| Top level | `advisors` | required | Independent reviewer entries. |
| Entry | `name` | required, unique | Provenance and status label; never shown on a card. |
| Entry | `enabled` | `true` | `false` keeps the entry without running it. |
| Entry | `model` | `default_model` | `<provider>/<model-id>[:level]`. An entry with neither is skipped with a startup warning. |
| Entry | `fallback` | `default_fallback` | At most one retry model. When omitted and `default_fallback` is the entry's own model, `default_model` is used; when neither applies there is no retry. An explicit self-fallback is dropped with a warning. |
| Entry | `tools` | `[read, grep, glob]` | Granted built-ins. `[]` grants none. `edit`, `write`, `patch`, `multiedit`, `bash`, and `webfetch` keep their OpenCode permission prompts; every other tool, including MCP tools, is denied. |
| Entry | `instructions` | none | Per-reviewer specialization; `prompt` is an alias. |
| Entry | `min_severity` | configured `min_severity` | `nit`, `concern`, or `blocker`. |
| Entry | `chat_min_severity` | configured `chat_min_severity` | Lowest severity this reviewer's notes become chat cards. |
| Entry | `inject_min_severity` | configured `inject_min_severity` | Lowest severity this reviewer's notes are injected into the primary's next step. |
| Entry | `when` | none (every step) | Gate: this reviewer runs only when the transcript delta since its last pass contains a match. `edits`: globs against the path of a completed `edit`, `write`, or `apply_patch` (paths from the `*** Update File:` headers); relative to the watched directory, or absolute when the glob starts with `/`. `commands`: regexes against the command of a completed `bash`. `tools`: bare names of other tools (`task`, `todowrite`). Any match fires. `edit`, `write`, `apply_patch`, and `bash` are rejected in `tools` with a warning. |

A skipped delta carries over: the reviewer's cursor does not move, no child session or prompt is created, and when a later step matches it reviews everything since its last pass, within `max_delta_chars`. The log records `advisor pass skipped` with `reason: no_trigger`. A `when` whose lists are empty or all invalid fails closed: the entry stays in the roster, never runs, and a startup warning says so. An edit outside the watched directory matches extension globs (`**/*.jsonc`) but not prefix globs (`src/**`). Passes are per completed assistant step, batched by `pass_debounce_ms` and `cooldown_ms`, so several edits in one step share one pass.

File- and command-triggered reviewers also skip a pass when file contents and user/task context match that reviewer's last successful review. The first eligible pass establishes this baseline. Later no-op edits, staging, and commits of already-reviewed contents need no new model request; the log records `reason: unchanged_content`. Checks include tracked and untracked file contents, file modes, and explicit edit/patch paths outside the worktree. Skipped transcript evidence carries forward.

Baselines belong to individual reviewers and persist in the review journal. They are captured before a request and accepted only with its successful durable result, including recovery. Failures do not mark code reviewed. A new user request or changed reviewer configuration permits a fresh review, and edits arriving during review remain eligible for the coalesced follow-up. An unrestricted reviewer with no `when`, or an explicit match in `when.tools`, still reviews transcript evidence even when files are unchanged.

Content checks run in the background and share cached file hashes. Each check is limited to two seconds, 10,000 files, 4 MiB per file, and 64 MiB in total. Outside Git, or when paths are unknown, files are unreadable or changing during inspection, symlinks/submodules are encountered, or a limit is exceeded, the check declines deduplication and normal review remains available. The primary never waits for these checks.

A quiet code reviewer and a docs reviewer that also records nits:

```yaml
advisors:
  - name: Oracle advisor
    model: <provider>/<model-id>:<level>
    tools: [read, grep, glob]
    when:
      edits: ["**/*.ts", "**/*.tsx", "src/**", "test/**"]
      commands: ["\\bsed\\s+-i\\b", "\\btee\\b", "\\bcat\\s*>", "\\bgit\\s+(commit|apply)\\b"]
      tools: [task]
    min_severity: concern
    chat_min_severity: blocker
    inject_min_severity: concern
  - name: Docs reviewer
    model: <provider>/<other-model-id>:<level>
    tools: [read, grep, glob]
    when:
      edits: ["**/*.md", "docs/**", "specs/**"]
    min_severity: nit
    chat_min_severity: blocker
    inject_min_severity: concern
```

`commands` is a heuristic: a shell that edits through a program (`python3 - <<EOF`) is not seen. Sub-agent sessions are not watched, so a tool that delegates work (`task`) must be named in `tools` for delegated edits to trigger a pass.

Model references: `provider_aliases` rewrites the prefix (`bedrock-mantle/` → `amazon-bedrock/` by default). The `:level` is passed to OpenCode as the agent variant, and OpenCode maps it to the provider's reasoning option from its own model catalog, so any level a model declares there works and the plugin carries no model-specific logic; `variant_aliases` rewrites a requested level to a variant OpenCode knows while the card still shows the requested level. Tool aliases: `search` → `grep`, `find` → `glob`. Malformed fields and unknown tools produce startup warnings in the log, never a failed start.

The reviewer contract in `src/prompts.ts` defines severities, the `<advice>` output format, and the `<silent/>` reply for a pass with nothing to add; it takes precedence over roster wording on those points.

## Priorities: `WATCHDOG.md`

`<cwd>/WATCHDOG.md` then `~/.config/opencode/WATCHDOG.md` are concatenated into each reviewer's first prompt in a child session, together with AGENTS.md, CONTEXT.md, and the roster and entry instructions; later passes in the same child send only the requests and the delta, and a replacement child receives the static sections again. The primary never sees them.

## Behavior: `advisor.jsonc`

`~/.config/opencode/advisor.jsonc` loads first and `<cwd>/.opencode/advisor.jsonc` overlays it: objects merge, arrays replace. An invalid file is logged and skipped. `OPENCODE_ADVISOR_ENABLED=0|1` and `OPENCODE_ADVISOR_LOG_LEVEL=debug|info|warn|error` override their keys for one process.

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch. |
| `default_model` | unset | Model for entries that omit `model`, as `<provider>/<model-id>[:level]`. |
| `default_fallback` | unset | Retry model for entries that omit `fallback`. |
| `min_severity` | `"nit"` | Lowest severity kept. Notes below it are dropped, not stored. A floor on recording, not a change to how reviewers grade. |
| `chat_min_severity` | `"blocker"` | Lowest severity eligible for a chat card. Other recorded notes stay in the checkpoint inbox and `advisor notes`. |
| `inject_min_severity` | `"concern"` | Lowest severity fed into the primary's next step for checkpoint consideration. |
| `toast` | `false` | Toast per eligible note when enabled, independently of the chat floor. |
| `abort_on_blocker` | `false` | Opt in to aborting the session only when an `advisor_checkpoint` with `phase: "before_action"` finds a verified blocker whose `affected_action` is the named `next_action`, with a concrete cost of delay. Receiving a report never triggers an abort. |
| `fallback_on_content_filter` | `true` | A content-filter match is eligible for the single fallback retry. |
| `fallback_cooldown_ms` | `300000` | How long a failed primary reviewer model stays cooled. |
| `pass_debounce_ms` | `4000` | Delay after a completed assistant step before a pass starts. |
| `cooldown_ms` | `15000` | Minimum gap between non-idle passes. |
| `max_delta_chars` | `30000` | Largest transcript delta sent to a reviewer. |
| `note_ttl_turns` | `2` | User turns for which an undelivered note stays injectable. |
| `pass_timeout_ms` | `180000` | Shared execution deadline, including preparation and fallback. |
| `abort_grace_ms` | `2000` | Bound on waiting for remote cancellation or a recovery probe. |
| `min_fallback_budget_ms` | `30000` | Minimum remaining execution time required to start fallback; otherwise the next pass can use its full budget. |
| `max_concurrent_passes_per_provider` | `0` | Per-process provider limit; zero means unlimited. |
| `admission_timeout_ms` | `180000` | Cumulative wait budget for provider admission. |
| `context_budget_tokens` | `0` | Explicit soft context budget; zero uses the catalog limit. |
| `context_budget_fraction` | `0.7` | Fraction of a known catalog context limit used as the soft budget. |
| `context_carry_chars` | `24000` | Maximum deterministic carry; oversized required evidence pauses the reviewer. |
| `log_max_bytes` | `10485760` | Rotate after reaching this size; a buffered batch may exceed the threshold. |
| `log_retention` | `3` | Number of log archives retained. |
| `pending_ttl_ms` | `600000` | Age at which an undelivered card is marked expired and its queue pointer is removed. |
| `advise_agents` | `{}` | Child agents to review: `true` for the roster, or a model reference. |
| `provider_aliases` | `{"bedrock-mantle":"amazon-bedrock"}` | Provider-prefix rewrites accepted in model references. |
| `variant_aliases` | `{}` | Requested level → agent variant rewrites. |
| `content_filter_patterns` | <code>["content[\\s_-]?filter", "filtering policy", "blocked by", "guardrail", "refusal", "output blocked"]</code> | Case-insensitive classifiers for content filtering. |
| `quarantine_patterns` | <code>["rm\\s+-rf", "git\\s+push\\s+--force", "--no-verify", "DROP\\s+TABLE", "git\\s+reset\\s+--hard", "chmod\\s+777", "curl[^\\n]*\\&#124;\\s*sh", ":\\(\\)\\s*\\{"]</code> | Destructive directives that withhold a note. |
| `log_level` | `"info"` | File-log threshold. |

## Fallback

Each reviewer has one primary model and at most one fallback. A throttle, auth or API error, content-filter match, or errored empty response cools the primary for `fallback_cooldown_ms` and retries the same delta once on the fallback; the card then ends in ` · fallback`. With both unavailable, the pass records `no_model` and the other reviewers continue. Cooldowns are visible as `cooled_until` in `advisor status --json`.

## Data and CLI

Notes live under `~/.local/share/opencode-advisor/notes/`, legacy/final-response attempt transcripts under `transcripts/`, and a per-directory status snapshot under `state/`. `findings.sqlite` holds proposal provenance, dispositions, verification, task context, canonical delivery receipts, note metadata, review journals, and usage. The log is `advisor.log` in the same directory.

`advisor status --json` includes the loaded package version, source fingerprint, instance ID, scheduling scope, execution state, and history counters. Usage is counted once per observed assistant message, including intermediate, failed, fallback, cancelled, and compaction work. Cost remains the provider/OpenCode estimate. Coverage is `complete`, `partial`, or `unknown`; unknown numeric usage, attribution gaps, or a bounded scan that could not cover the attempt cannot be presented as measured zero. Cache tokens and compaction totals are separate fields. Durable usage survives restarts and shared readers; pass/note counters and the roster snapshot identify the last writing instance. Historical transcript totals are not added to the ledger.

Ordinary logs are buffered for up to 100 ms with a 256 KiB queue; warnings/errors flush promptly, with bounded waits on a stalled sink. Individual entries are capped. Log rotation uses unique archive names across processes. Logs are best-effort telemetry: note, finding, receipt, and usage evidence has separate retention and is not pruned by log rotation.

### Upgrading from 0.1 and rollback

Restart **all OpenCode instances** after updating this source-linked plugin. New and old writers must not run together once receipt migration begins. SQLite changes are additive and idempotent; original reports and transcripts remain in place.

`advisor index` backfills up to 128 legacy report metadata entries per call; `advisor index --all` finishes the resumable migration. Note listing reports incomplete or unavailable legacy coverage, selects indexed IDs for the current directory, and pages past missing/corrupt candidates. The backfill bounds file reads, but still enumerates filenames; it is a one-time migration. New reports are indexed transactionally. A completed migration does not watch for files produced by an old writer.

SQLite receipts are authoritative after an exact native-card acknowledgment. JSON `delivered_at` is a compatibility mirror; a mirror-write failure does not make a shown card eligible again. Before rolling back, stop every writer and run `advisor repair-receipts` with the new CLI. Resolve any reported missing files before starting an older build. Keep the added tables; do not delete the ledger or replay uncertain writes to repair a rollback.

SQLite runs in a dedicated worker with persistent connections and startup migrations. Disposing an OpenCode instance releases its connection ownership; the worker stops when its last owner closes. Indexed, batched reads fetch the findings needed for delivery or the checkpoint’s relevant issue groups. Note and status files are replaced atomically so readers never see a partial write. Notes and SQLite still use separate commits; a crash between them can leave an unindexed note file. Restart all OpenCode processes using this plugin after upgrading so every writer uses the new state-version checks.

```sh
advisor status [--json]        # roster, fallbacks, tools, cooldowns, counts, cost, watched sessions
advisor notes [--last N] [--json]
advisor --note <id>            # retry-safe render of one eligible card; does not acknowledge it
advisor                        # print every pending card for this directory
```

The installed `/advisor` command runs `advisor status` followed by `advisor notes --last 5`.

## With Oh My OpenAgent

Both plugins' hooks compose; `opencode.jsonc` and OmO's files are left alone. Reviewer sessions are children of the watched session, which OmO recognizes as subagents and this plugin excludes from its own watcher. The plugin sets no chat parameters: model, variant, and provider options are OpenCode's, resolved from the agent the roster registered. OmO's own child sessions are reviewed only when named in `advise_agents`.

## Limitations

- Cards use OpenCode's generic tool-result rendering and require the message-part update API in the pinned SDK/server version.
- A blocker steers the primary at its next LLM step; it does not rewrite a response already in flight.
- Native cards are scoped to their root session. The manual bare `advisor` command reads directory queues and may include notes from another session in that directory.
- Duplicate matching preserves code spelling and quoting: paraphrased reports can remain separate. Existing archived notes without finding metadata remain readable but are not retroactively grouped.
- A corrupt review journal needs manual inspection or restoration; there is no automatic reset or journal-repair CLI. Only the affected reviewer pauses.
- Configuration is edited in the JSONC, YAML, and Markdown files directly.

## Troubleshooting

- `OPENCODE_ADVISOR_ENABLED=0 opencode` starts one process with every hook off.
- `advisor: command not found`: add `~/.local/bin` to `PATH` and restart the shell and OpenCode.
- `/advisor` missing or an edit ignored: the file is startup-loaded; restart OpenCode.
- `no_model` in status: read `cooled_until` in `advisor status --json`. When no status snapshot exists for the directory, the command prints a plain-text notice even with `--json`.
- `no default_model configured` in the log: a roster entry names no model, or there is no roster file; name the model or set `default_model`.
- `Cache point cannot be inserted after reasoning block` in the log (`failure_kind: poisoned_session`): a reviewer with extended thinking ended a pass with reasoning and no text. The `<silent/>` reply prevents it; when it happens anyway the child session is replaced and the pass retried once on the same model, without a cooldown.

## Skill

[`skills/opencode-advisor`](skills/opencode-advisor/SKILL.md) is the agent-facing guide: reading cards and state, changing the roster and behavior, troubleshooting, and modifying the plugin.

## Architecture

The primary's hooks notify background reviewers and read arrived findings. They never join reviewer execution. Checkpoint gates concern existing findings, not outstanding reviewer requests.

| Owner | Responsibility |
| --- | --- |
| `AdvisorRuntime` | Schedule independent reviewers and route their results to delivery. |
| `ReviewLane` | Own one root/reviewer's cursor, child, active pass, retry policy and pending recovery. A stable pass ID prevents old completions from advancing newer progress. |
| `ReviewJournal` | Own durable lane claims and release them before closing its SQLite handle, including lanes the runtime has forgotten. |
| `NoteStore` and its SQLite worker | Persist findings, dispositions, catalog metadata and canonical receipts. JSON reports retain full evidence; delivery markers in JSON are compatibility mirrors. |
| `Deliverer` | Queue arrived notes, recheck task/turn eligibility, and acknowledge exact native-card rendering. |

Attempt cancellation and permit release stay inside reviewer execution. Recovery publishes through the lane once; the runtime does not independently watch or deduplicate pending promises. History projections, logging and usage accounting support these owners without deciding whether the primary may continue.

## License

[MIT](LICENSE).
