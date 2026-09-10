---
name: opencode-advisor
description: >-
  Advisor watchdog: reviewer cards headed `$ advisor`, `/advisor` status and notes, the WATCHDOG.yml roster, WATCHDOG.md priorities, advisor.jsonc behavior, and the opencode-advisor plugin source. Use when a card lands or the user asks what the advisor said, wants to change or disable a reviewer or its model, fallback, or effort, asks why no card appeared, or is editing the plugin.
---

# OpenCode Advisor

Independent reviewer models watch the primary session's transcript in child sessions and deliver notes as `$ advisor` tool-output cards. The primary model and its routing are untouched. A card's first line is `Advisor · <model> (<level>) · nit|concern|blocker`, with ` · fallback` when the retry model wrote it.

**Startup-loaded**: the roster, WATCHDOG.md, advisor.jsonc, the `/advisor` command, this skill, and the plugin source are read once when OpenCode starts. Every edit to any of them lands after a quit and restart.

## Cards

The standing rule the plugin injects into your system prompt governs a card: verify it against the code or output, act on what holds up, and resolve or show unfounded any blocker before continuing. To dig into a card's basis:

- `ctrl+x ↓` enters the `advisor:<slug>` child session where the reviewer reasoned and used tools; `ctrl+x ←` / `→` moves between related sessions. Turn on OpenCode's `display_thinking` to see reviewer reasoning there.
- `advisor notes --last N [--json]` prints persisted notes with reasoning and evidence.

## Read state

- `/advisor` runs `advisor status` and then `advisor notes --last 5`, verbatim.
- `advisor status [--json]`: models, fallbacks, tools, cooldowns (`cooled_until`), pass and note counts, cost, watched sessions.
- `~/.local/share/opencode-advisor/advisor.log`: startup warnings, every pass with its outcome, fallback, and card delivery.

Pass outcomes, as they appear in status, transcripts, and the log:

| Outcome | Meaning |
| --- | --- |
| `ok` | The reviewer wrote at least one note. |
| `silent` | The reviewer replied `<silent/>`: nothing to add, no card expected. |
| `fallback` | The primary model failed and the one retry model produced the note; the card ends in ` · fallback`. |
| `no_model` | Primary and fallback are both unavailable or cooled; the pass was skipped. |
| `error`, `timeout`, `quarantined` | Provider error, `pass_timeout_ms` exceeded, or a note matched `quarantine_patterns` and was withheld. |

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

`~/.config/opencode/advisor.jsonc` is global; `<repo>/.opencode/advisor.jsonc` overlays it. Objects merge, arrays replace. Every key is documented inline in the installed `advisor.jsonc`; the defaults are `DEFAULTS` in `src/config.ts`.

- `min_severity` is a delivery floor. It filters which notes reach the chat; it changes nothing about how reviewers grade. Grading lives in the reviewer contract in `src/prompts.ts`.
- `OPENCODE_ADVISOR_ENABLED=0 opencode` runs one process with every advisor hook off; `OPENCODE_ADVISOR_LOG_LEVEL=debug opencode` overrides logging for one process.

## Troubleshoot

- No advisor runs and the log says `no default_model configured`: the roster has an entry without `model`, or there is no roster file. Name a model on each entry or set `default_model`.
- A card is delivered only when the watched session is idle. Look in the log for `advisor pass end` and `advisor card delivered`.
- `no_model` in status: run `advisor status --json` and read `cooled_until`. A failed primary stays cooled for `fallback_cooldown_ms`. `advisor status` prints a plain-text notice, not JSON, until the first pass has written state for the directory.
- The log shows `Cache point cannot be inserted after reasoning block` (Bedrock 400, transcript `failure_kind: poisoned_session`): a reviewer with extended thinking ended a pass with reasoning and no text, so the next pass's cache point landed after the reasoning block. The `<silent/>` protocol prevents it; when it happens anyway, the plugin replaces the child session and retries once on the same model without cooling it, at the cost of one full cache write.
- A toast is missing but the card and notes exist: the process has no TUI.

## Modify the plugin

Work test-first: make the relevant `bun test` case fail, then make it pass. Done means `bun test` and `bun run typecheck` pass, every touched source file is at or below 250 lines, and the diff adds no `any`, type suppression, or permission bypass. `~/.omp` stays untouched; roster compatibility with omp is read-only. Work plans go in `.omo/plans/`, receipts in `.omo/evidence/`, and `.omo/` stays out of git.

`scripts/install.sh` symlinks `src/plugin.ts`, `bin/advisor.ts`, and this skill into OpenCode's user directories, so the repository is the live source: a new OpenCode process runs the working tree as-is.

Where things live:

- `src/plugin.ts`: loads config and roster, composes hooks, wires watcher, runtime, and delivery.
- `src/watcher.ts`, `src/watcher/scheduler.ts`: track watched sessions; debounce, cool down, and suppress passes.
- `src/advisor/runtime.ts`, `src/advisor/pass.ts`: child sessions, deltas, parallel reviews, fallback retry, transcripts, state.
- `src/deliver/cards.ts`, `src/deliver/transform.ts`: idle-only card delivery, one `advisor --note <id>` shell per note; blocker injection and the standing rule.
- `src/roster/*`: discover and parse rosters, resolve models and fallbacks, register locked-down advisor agents.
- `src/models.ts`: model references, variants and effort, failure classification, cooldowns.
- `src/delta.ts`: redacted transcript deltas that exclude advisor delivery.
- `src/advice.ts`: `<advice>` parsing, severity floor, quarantine.
- `src/notes/store.ts`: notes, pending pointers, transcripts, delivery state, status snapshots.
- `src/prompts.ts`: reviewer contract, pass prompt, standing rule, blocker injection.
- `src/config.ts`: `DEFAULTS`, JSONC precedence, environment overrides, data directory.
- `bin/advisor.ts`: `status`, `notes`, `--note <id>`, pending-card output, `--version`.

Invariants:

- Cards are delivered only at idle; `session.shell` is called on a watched session only when it is idle.
- `session.prompt` targets advisor child sessions only.
- Delivery-agent messages and `$ advisor` output are excluded from deltas and from pass triggers.
- Advisor agents start with every tool and permission denied and unlock only the roster's explicit grants.
