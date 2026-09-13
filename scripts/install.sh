#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
HOME_DIR="${HOME:?HOME must be set}"
OPENCODE_DIR="$HOME_DIR/.config/opencode"
PLUGIN_LINK="$OPENCODE_DIR/plugins/advisor.ts"
LOCAL_BIN="$HOME_DIR/.local/bin"
CLI_LINK="$LOCAL_BIN/advisor"
CONFIG_FILE="$OPENCODE_DIR/advisor.jsonc"
COMMAND_FILE="$OPENCODE_DIR/command/advisor.md"
SKILLS_DIR="$OPENCODE_DIR/skills"
SKILL_SOURCE="$REPO_ROOT/skills/opencode-advisor"
SKILL_LINK="$SKILLS_DIR/opencode-advisor"

(cd "$REPO_ROOT" && bun install)

mkdir -p "$OPENCODE_DIR/plugins" "$OPENCODE_DIR/command" "$SKILLS_DIR" "$LOCAL_BIN"

if [[ -e "$PLUGIN_LINK" && ! -L "$PLUGIN_LINK" ]]; then
  printf 'refusing to replace non-symlink plugin: %s\n' "$PLUGIN_LINK" >&2
  exit 1
fi
ln -sfn "$REPO_ROOT/src/plugin.ts" "$PLUGIN_LINK"
printf 'installed plugin symlink (src mode)\n'

if [[ -e "$CLI_LINK" && ! -L "$CLI_LINK" ]]; then
  printf 'refusing to replace non-symlink executable: %s\n' "$CLI_LINK" >&2
  exit 1
fi
ln -sfn "$REPO_ROOT/bin/advisor.ts" "$CLI_LINK"
printf 'installed advisor CLI symlink\n'

if [[ -e "$SKILL_LINK" && ! -L "$SKILL_LINK" ]]; then
  printf 'refusing to replace non-symlink skill: %s\n' "$SKILL_LINK" >&2
  exit 1
fi
ln -sfn "$SKILL_SOURCE" "$SKILL_LINK"
printf 'installed skill symlink: %s -> %s\n' "$SKILL_LINK" "$SKILL_SOURCE"

case ":${PATH:-}:" in
  *":$LOCAL_BIN:"*) ;;
  *) printf 'warning: %s is not in PATH; add it to your shell PATH\n' "$LOCAL_BIN" >&2 ;;
esac

if [[ ! -e "$CONFIG_FILE" && ! -L "$CONFIG_FILE" ]]; then
  cat > "$CONFIG_FILE" <<'JSONC'
{
  // Master switch. OPENCODE_ADVISOR_ENABLED=0 temporarily disables the plugin.
  "enabled": true,

  // Reviewer model for roster entries that omit `model`, as `<provider>/<model-id>[:level]`.
  // The plugin ships no model of its own: with this unset, every roster entry must name one.
  // "default_model": "<provider>/<model-id>:<level>",

  // Single retry model for entries that omit `fallback`. Unset means no retry unless the
  // entry sets one; an entry whose inherited fallback is its own model retries on default_model.
  // "default_fallback": "<provider>/<other-model-id>:<level>",

  // Lowest severity kept: "nit", "concern", or "blocker". Notes below it are dropped.
  "min_severity": "nit",

  // Lowest severity shown as a chat card. All recorded notes remain in the checkpoint inbox.
  "chat_min_severity": "blocker",

  // Lowest severity fed to the primary's next step, silently, until it is shown as a card or
  // note_ttl_turns pass. The primary honors user steering and compares proposals at checkpoints.
  "inject_min_severity": "concern",

  // Show an OpenCode toast for each delivered note.
  "toast": false,

  // Opt in to aborting when a before_action checkpoint finds a verified blocker for the named next action with a cost of delay.
  "abort_on_blocker": false,

  // Retry the same delta once on the fallback when content filtering blocks a model.
  "fallback_on_content_filter": true,

  // How long a failed primary advisor model stays cooled down, in milliseconds.
  "fallback_cooldown_ms": 300000,

  // Delay after a completed assistant step before starting an advisor pass.
  "pass_debounce_ms": 4000,

  // Minimum delay between non-idle advisor passes, in milliseconds.
  "cooldown_ms": 15000,

  // Maximum rendered transcript-delta size sent to each advisor.
  "max_delta_chars": 30000,

  // Number of later user turns for which an undelivered note remains injectable.
  "note_ttl_turns": 2,

  // Shared execution deadline: preparation, child creation, requests, refresh, and fallback.
  "pass_timeout_ms": 180000,

  // Remote cancellation grace. An unconfirmed abort keeps the lane blocked for reconciliation.
  "abort_grace_ms": 2000,
  "min_fallback_budget_ms": 30000,

  // Fair per-provider admission in this process/data directory; 0 preserves unlimited concurrency.
  "max_concurrent_passes_per_provider": 0,
  "admission_timeout_ms": 180000,

  // Rotate between passes at this explicit soft token budget, or a fraction of known model capacity.
  "context_budget_tokens": 0,
  "context_budget_fraction": 0.7,
  "context_carry_chars": 24000,

  // Maximum card age before it is marked expired and its pending pointer is removed.
  "pending_ttl_ms": 600000,

  // Optional child-agent names to advise: true uses the roster, a string selects a model.
  "advise_agents": {},

  // Provider prefixes accepted in WATCHDOG.yml model references.
  "provider_aliases": {
    "bedrock-mantle": "amazon-bedrock"
  },

  // Optional rewrites from a requested `:level` to the agent variant OpenCode receives.
  // Empty by default: the level is passed through as the variant unchanged.
  "variant_aliases": {},

  // Case-insensitive patterns that classify a failed response as content filtering.
  "content_filter_patterns": [
    "content[\\s_-]?filter",
    "filtering policy",
    "blocked by",
    "guardrail",
    "refusal",
    "output blocked"
  ],

  // Destructive directives that quarantine a note instead of delivering it.
  "quarantine_patterns": [
    "rm\\s+-rf",
    "git\\s+push\\s+--force",
    "--no-verify",
    "DROP\\s+TABLE",
    "git\\s+reset\\s+--hard",
    "chmod\\s+777",
    "curl[^\\n]*\\|\\s*sh",
    ":\\(\\)\\s*\\{"
  ],

  // File-log threshold: "debug", "info", "warn", or "error".
  "log_level": "info",
  "log_max_bytes": 10485760,
  "log_retention": 3
}

// WATCHDOG.yml is loaded when OpenCode starts. Restart OpenCode after roster edits.
JSONC
  printf 'created %s\n' "$CONFIG_FILE"
else
  printf 'kept existing %s\n' "$CONFIG_FILE"
fi

if [[ ! -e "$COMMAND_FILE" && ! -L "$COMMAND_FILE" ]]; then
  cat > "$COMMAND_FILE" <<'MARKDOWN'
---
description: Show advisor watchdog status (roster, models, cooldowns, notes, cost)
---

Run the shell command `advisor status` in the current directory and show its output verbatim in a code block. Then run `advisor notes --last 5` and show it verbatim. Do not summarize.
MARKDOWN
  printf 'created %s\n' "$COMMAND_FILE"
else
  printf 'kept existing %s\n' "$COMMAND_FILE"
fi

printf 'restart all OpenCode instances to load the plugin and receipt/accounting schemas; use advisor index --all for legacy reports\n'
