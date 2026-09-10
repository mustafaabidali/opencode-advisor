# OpenCode Advisor

OpenCode Advisor is an asynchronous reviewer watchdog for OpenCode. It brings the advisor workflow from [oh-my-pi](https://github.com/can1357/oh-my-pi) to OpenCode: independent models review transcript deltas, can inspect the repository with explicitly granted tools, and surface only actionable `nit`, `concern`, or `blocker` notes. The plugin keeps the primary model and its routing unchanged.

## How notes appear

Reviews run in child sessions and cards are written into the watched chat only when it is idle. OpenCode renders the delivery as a `$ advisor` shell result whose output has this exact shape:

```text
Advisor · GPT-5.6 Sol (xhigh) · concern
reasoning: The error branch silently discards the failure required by the specification.
note: Return the non-ENOENT error and add a regression test for that branch.
evidence: src/config.ts, test/config.test.ts
```

The card title contains one model mention and never shows the roster name or long provider/model id. A fallback card adds ` · fallback` to the first line. The plugin also shows a toast titled `Advisor · <severity>` when `toast` is enabled.

A blocker is queued as untrusted reviewer evidence for the primary's next LLM step. The primary must apply it or explicitly decline it; delivery never calls `session.shell` while the watched session is busy. `abort_on_blocker` can additionally stop the current turn, but is off by default.

Advisor reasoning and tool work remain browsable in the linked `advisor:<slug>` child session. Use OpenCode's leader sequence `ctrl+x ↓` to enter a child and `ctrl+x ←` / `ctrl+x →` to move between related sessions.

## Install and uninstall

From this repository:

```sh
bash scripts/install.sh
```

The installer is idempotent. It runs `bun install`, links `src/plugin.ts` directly to `~/.config/opencode/plugins/advisor.ts`, links `bin/advisor.ts` to `~/.local/bin/advisor`, and warns when `~/.local/bin` is not in the current `PATH`. It does not create an `/opt/homebrew/bin` link. It creates these files only when absent:

- `~/.config/opencode/advisor.jsonc`
- `~/.config/opencode/command/advisor.md`

Existing user-edited copies are left untouched. Quit and restart OpenCode after installation so it loads the plugin and `/advisor` command.

To remove only the two symlinks:

```sh
bash scripts/uninstall.sh
```

Uninstall leaves configuration, notes, transcripts, state, and logs in place.

## `advisor.jsonc` reference

The plugin loads `~/.config/opencode/advisor.jsonc`, then overlays `<cwd>/.opencode/advisor.jsonc`. Object values merge and array values replace the earlier array. Invalid or unreadable files are logged and do not stop OpenCode. `OPENCODE_ADVISOR_ENABLED=0|1` and `OPENCODE_ADVISOR_LOG_LEVEL=debug|info|warn|error` override their matching settings for the process.

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master plugin switch. |
| `default_model` | `"amazon-bedrock/openai.gpt-5.6-sol:xhigh"` | Reviewer model used when a roster entry omits `model`; mirrors the user's omp Sol role. |
| `default_fallback` | `"amazon-bedrock/us.anthropic.claude-fable-5-1:xhigh"` | The one retry model used when an entry omits `fallback`; mirrors the user's omp Fable 5.1 role. |
| `min_severity` | `"nit"` | Lowest note severity delivered: `nit`, `concern`, or `blocker`. |
| `toast` | `true` | Show an OpenCode toast for each delivered note. |
| `abort_on_blocker` | `false` | Abort the watched turn when a blocker arrives; steering still occurs when false. |
| `fallback_on_content_filter` | `true` | Treat content-filter failures as eligible for the single fallback retry. |
| `fallback_cooldown_ms` | `300000` | How long a failed primary advisor model remains cooled down. |
| `pass_debounce_ms` | `4000` | Delay after a completed assistant step before a pass starts. |
| `cooldown_ms` | `15000` | Minimum delay between non-idle passes. |
| `max_delta_chars` | `30000` | Maximum rendered transcript-delta length sent to an advisor. |
| `note_ttl_turns` | `2` | User-turn lifetime of a blocker that has not yet been delivered as a card. |
| `pass_timeout_ms` | `180000` | Maximum pass duration before the advisor child session is aborted. |
| `pending_ttl_ms` | `600000` | Maximum pending-card age before its pointer is discarded. |
| `advise_agents` | `{}` | Child-agent opt-ins. Map an agent name to `true` for the roster or to a model reference. |
| `provider_aliases` | `{"bedrock-mantle":"amazon-bedrock"}` | Provider-prefix rewrites accepted in roster model references. |
| `variant_aliases` | `{"max":"xhigh"}` | Model-suffix rewrites accepted in roster model references. |
| `content_filter_patterns` | <code>["content[\\s_-]?filter", "filtering policy", "blocked by", "guardrail", "refusal", "output blocked"]</code> | Case-insensitive patterns used to classify content filtering. |
| `quarantine_patterns` | <code>["rm\\s+-rf", "git\\s+push\\s+--force", "--no-verify", "DROP\\s+TABLE", "git\\s+reset\\s+--hard", "chmod\\s+777", "curl[^\\n]*\\&#124;\\s*sh", ":\\(\\)\\s*\\{"]</code> | Destructive directives that quarantine a note instead of delivering it. |
| `log_level` | `"info"` | File-log threshold: `debug`, `info`, `warn`, or `error`. |

## `WATCHDOG.yml` roster

Copy [`WATCHDOG.example.yml`](WATCHDOG.example.yml) and edit it by hand. The first existing `WATCHDOG.yml` or `WATCHDOG.yaml` wins in this order:

1. `<cwd>/WATCHDOG.yml` or `<cwd>/WATCHDOG.yaml`
2. `<cwd>/.opencode/WATCHDOG.yml` or `<cwd>/.opencode/WATCHDOG.yaml`
3. `~/.config/opencode/WATCHDOG.yml` or `~/.config/opencode/WATCHDOG.yaml`
4. `~/.omp/agent/WATCHDOG.yml` or `~/.omp/agent/WATCHDOG.yaml`

The `~/.omp/agent/WATCHDOG.yml` location is a read-only last fallback, so an existing omp roster works without being copied or changed. If no roster exists, one enabled advisor named `Advisor` uses the configured defaults.

The omp-compatible schema is:

| Location | Key | Required/default | Meaning |
| --- | --- | --- | --- |
| Top level | `instructions` | Optional | Shared instructions appended to every advisor prompt. |
| Top level | `advisors` | Required list | Independent advisor entries. |
| Entry | `name` | Required, unique | Human-readable provenance/status name; never rendered on a card. |
| Entry | `enabled` | `true` | Whether this entry runs. |
| Entry | `model` | `default_model` | `<provider>/<model-id>[:variant]`. |
| Entry | `fallback` | `default_fallback` | Exactly one retry model; lists and chains are unsupported. |
| Entry | `tools` | `[read, grep, glob]` | Granted built-ins. `[]` grants none; mutating grants retain OpenCode permission prompts. |
| Entry | `instructions` | Optional | Per-advisor specialization. `prompt` is accepted as an alias. |
| Entry | `min_severity` | Configured `min_severity` | `nit`, `concern`, or `blocker`. |

Compatibility aliases make the user's omp roster portable: provider prefix `bedrock-mantle/` becomes `amazon-bedrock/`, model suffix `:max` becomes variant `xhigh`, tool `search` becomes `grep`, and tool `find` becomes `glob`. Unknown tools and malformed fields produce warnings rather than killing the session. Restart OpenCode after editing the roster because agents are registered at startup.

## `WATCHDOG.md` priorities

Advisor-only review priorities can live in `<cwd>/WATCHDOG.md` and `~/.config/opencode/WATCHDOG.md`. Existing files are concatenated in that order and added to each advisor's prompt; they are not injected into the primary agent. Restart OpenCode after changing startup-loaded watchdog files.

## Fallback and content filtering

Each advisor has one primary model and at most one fallback. A throttle, authentication/API error, configured content-filter match, or errored empty response cools the failed primary for `fallback_cooldown_ms` and retries the same delta once with the fallback. There are no fallback chains and this plugin never changes routing for the primary coding agent. After the cooldown expires, the primary advisor model is eligible again.

When `fallback_on_content_filter` is true, matches from `content_filter_patterns` take priority over other error classes. If both models are unavailable or cooled, the pass records `no_model` without interrupting other advisors.

## Cost recorder and CLI

The plugin persists long-form notes under `~/.local/share/opencode-advisor/notes/`, one JSONL transcript record per advisor attempt under `transcripts/`, and a live per-directory snapshot under `state/`. Transcript records include model, variant, token counts, cache counts, cost, duration, outcome, and failure kind when applicable.

Use:

```sh
advisor status
advisor status --json
advisor notes --last 5
advisor notes --last 5 --json
```

`advisor status` reports the current directory's roster slugs, display models and variants, fallback, tools, enablement, cooldowns, pass/note counts, cost, watched sessions, and snapshot time. The installed `/advisor` command shows `advisor status` followed by the five newest notes verbatim.

## Coexistence with Oh My OpenAgent

OpenCode auto-discovers the advisor source symlink; `opencode.jsonc` and Oh My OpenAgent (OmO) files are not modified. Both plugins' hooks compose. Advisor review sessions are created as child sessions with `parentID` set to the watched session, which lets OmO recognize them as subagents and lets this plugin exclude them from its own watcher. Delivery-agent messages are excluded too, preventing cards from reviewing themselves.

Ordinary OmO/task child sessions remain unadvised by default. Add an agent name to `advise_agents` only when that child should receive its own advisor passes.

## Limitations compared with omp

- OpenCode plugins cannot supply omp's custom card renderer, so a card is a completed `$ advisor` shell-output box.
- A blocker steers the primary at its next LLM step; it does not rewrite an already-running response. Optional abort is explicit.
- Roster edits require an OpenCode restart.
- Pending cards are keyed by directory because `session.shell` exposes no session id in its environment. Two sessions in the same directory can therefore print each other's notes.
- There is no `/advisor configure` UI; edit the JSONC, YAML, and Markdown files directly.

## Troubleshooting

- Log file: `~/.local/share/opencode-advisor/advisor.log`.
- Temporarily disable all hooks with `OPENCODE_ADVISOR_ENABLED=0 opencode`.
- If `advisor` is not found, add `~/.local/bin` to `PATH` and restart the shell/OpenCode process.
- If `/advisor` is missing or a roster edit is ignored, quit and restart OpenCode; configuration is loaded once at startup.
- Run `advisor status --json` to inspect the current directory's registered roster, cooldowns, counters, and cost.
- Invalid config/roster files are logged and skipped so they do not prevent OpenCode from starting.
