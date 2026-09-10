# OpenCode Advisor

An asynchronous reviewer watchdog for OpenCode, ported from the advisor workflow in [oh-my-pi](https://github.com/can1357/oh-my-pi). Independent reviewer models read the primary session's transcript in child sessions, may inspect the repository with explicitly granted tools, and deliver only actionable `nit`, `concern`, or `blocker` notes. The primary model and its routing are untouched.

## Cards

Each note arrives as a `$ advisor` shell result in the watched chat, one card per note, delivered only while the session is idle:

```text
Advisor · <model name> (<level>) · concern
reasoning: The error branch silently discards the failure required by the specification.
note: Return the non-ENOENT error and add a regression test for that branch.
evidence: src/config.ts, test/config.test.ts
```

The first line names the display model and level once; the roster name and long provider id stay out of the card. A card produced by the retry model ends in ` · fallback`. With `toast` on, a toast titled `Advisor · <severity>` accompanies each card.

The primary treats cards as fallible evidence: a standing rule in its system prompt tells it to verify a note against the code before acting, act on what holds up, and resolve or show unfounded any blocker before continuing. A blocker is additionally injected into the primary's next LLM step until it is delivered as a card; `abort_on_blocker` can also stop the current turn.

Reviewer reasoning and tool use stay browsable in the `advisor:<slug>` child session: `ctrl+x ↓` enters it, `ctrl+x ←` / `→` moves between related sessions.

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

Model references: `provider_aliases` rewrites the prefix (`bedrock-mantle/` → `amazon-bedrock/` by default). The `:level` is passed to OpenCode as the agent variant, and OpenCode maps it to the provider's reasoning option from its own model catalog, so any level a model declares there works and the plugin carries no model-specific logic; `variant_aliases` rewrites a requested level to a variant OpenCode knows while the card still shows the requested level. Tool aliases: `search` → `grep`, `find` → `glob`. Malformed fields and unknown tools produce startup warnings in the log, never a failed start.

The reviewer contract in `src/prompts.ts` defines severities, the `<advice>` output format, and the `<silent/>` reply for a pass with nothing to add; it takes precedence over roster wording on those points.

## Priorities: `WATCHDOG.md`

`<cwd>/WATCHDOG.md` then `~/.config/opencode/WATCHDOG.md` are concatenated into every reviewer's prompt. The primary never sees them.

## Behavior: `advisor.jsonc`

`~/.config/opencode/advisor.jsonc` loads first and `<cwd>/.opencode/advisor.jsonc` overlays it: objects merge, arrays replace. An invalid file is logged and skipped. `OPENCODE_ADVISOR_ENABLED=0|1` and `OPENCODE_ADVISOR_LOG_LEVEL=debug|info|warn|error` override their keys for one process.

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch. |
| `default_model` | unset | Model for entries that omit `model`, as `<provider>/<model-id>[:level]`. |
| `default_fallback` | unset | Retry model for entries that omit `fallback`. |
| `min_severity` | `"nit"` | Lowest severity delivered. A floor on delivery, not a change to how reviewers grade. |
| `toast` | `true` | Toast per delivered note. |
| `abort_on_blocker` | `false` | Abort the watched turn when a blocker arrives. |
| `fallback_on_content_filter` | `true` | A content-filter match is eligible for the single fallback retry. |
| `fallback_cooldown_ms` | `300000` | How long a failed primary reviewer model stays cooled. |
| `pass_debounce_ms` | `4000` | Delay after a completed assistant step before a pass starts. |
| `cooldown_ms` | `15000` | Minimum gap between non-idle passes. |
| `max_delta_chars` | `30000` | Largest transcript delta sent to a reviewer. |
| `note_ttl_turns` | `2` | User turns for which an undelivered blocker stays injectable. |
| `pass_timeout_ms` | `180000` | Pass duration before the child session is aborted. |
| `pending_ttl_ms` | `600000` | Age at which an undelivered card pointer is discarded. |
| `advise_agents` | `{}` | Child agents to review: `true` for the roster, or a model reference. |
| `provider_aliases` | `{"bedrock-mantle":"amazon-bedrock"}` | Provider-prefix rewrites accepted in model references. |
| `variant_aliases` | `{}` | Requested level → agent variant rewrites. |
| `content_filter_patterns` | <code>["content[\\s_-]?filter", "filtering policy", "blocked by", "guardrail", "refusal", "output blocked"]</code> | Case-insensitive classifiers for content filtering. |
| `quarantine_patterns` | <code>["rm\\s+-rf", "git\\s+push\\s+--force", "--no-verify", "DROP\\s+TABLE", "git\\s+reset\\s+--hard", "chmod\\s+777", "curl[^\\n]*\\&#124;\\s*sh", ":\\(\\)\\s*\\{"]</code> | Destructive directives that withhold a note. |
| `log_level` | `"info"` | File-log threshold. |

## Fallback

Each reviewer has one primary model and at most one fallback. A throttle, auth or API error, content-filter match, or errored empty response cools the primary for `fallback_cooldown_ms` and retries the same delta once on the fallback; the card then ends in ` · fallback`. With both unavailable, the pass records `no_model` and the other reviewers continue. Cooldowns are visible as `cooled_until` in `advisor status --json`.

## Data and CLI

Notes live under `~/.local/share/opencode-advisor/notes/`, one transcript record per reviewer attempt under `transcripts/` (model, level, tokens, cache reads and writes, cost, duration, outcome, failure kind), and a per-directory status snapshot under `state/`. The log is `advisor.log` in the same directory.

```sh
advisor status [--json]        # roster, fallbacks, tools, cooldowns, counts, cost, watched sessions
advisor notes [--last N] [--json]
advisor --note <id>            # print one pending card; used by delivery
advisor                        # print every pending card for this directory
```

The installed `/advisor` command runs `advisor status` followed by `advisor notes --last 5`.

## With Oh My OpenAgent

Both plugins' hooks compose; `opencode.jsonc` and OmO's files are left alone. Reviewer sessions are children of the watched session, which OmO recognizes as subagents and this plugin excludes from its own watcher. The plugin sets no chat parameters: model, variant, and provider options are OpenCode's, resolved from the agent the roster registered. OmO's own child sessions are reviewed only when named in `advise_agents`.

## Limitations

- A card is a completed `$ advisor` shell-output box; plugins cannot supply omp's custom renderer.
- A blocker steers the primary at its next LLM step; it does not rewrite a response already in flight.
- Pending cards are keyed by directory because `session.shell` exposes no session id, so two sessions in one directory can print each other's cards.
- Configuration is edited in the JSONC, YAML, and Markdown files directly.

## Troubleshooting

- `OPENCODE_ADVISOR_ENABLED=0 opencode` starts one process with every hook off.
- `advisor: command not found`: add `~/.local/bin` to `PATH` and restart the shell and OpenCode.
- `/advisor` missing or an edit ignored: the file is startup-loaded; restart OpenCode.
- `no_model` in status: read `cooled_until` in `advisor status --json`. Until the first pass writes state for a directory, `advisor status` prints a plain-text notice rather than JSON.
- `no default_model configured` in the log: a roster entry names no model, or there is no roster file; name the model or set `default_model`.
- `Cache point cannot be inserted after reasoning block` in the log (`failure_kind: poisoned_session`): a reviewer with extended thinking ended a pass with reasoning and no text. The `<silent/>` reply prevents it; when it happens anyway the child session is replaced and the pass retried once on the same model, without a cooldown.

## Skill

[`skills/opencode-advisor`](skills/opencode-advisor/SKILL.md) is the agent-facing guide: reading cards and state, changing the roster and behavior, troubleshooting, and modifying the plugin.
