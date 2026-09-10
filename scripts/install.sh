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
SKILL_SOURCE="/Users/mustafa/opencode-advisor/skills/opencode-advisor"
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

  // Default reviewer model. Sol at xhigh mirrors the user's omp advisor role.
  "default_model": "amazon-bedrock/openai.gpt-5.6-sol:xhigh",

  // One fallback only. Fable 5.1 at xhigh mirrors the user's omp fallback role.
  "default_fallback": "amazon-bedrock/us.anthropic.claude-fable-5-1:xhigh",

  // Lowest severity delivered: "nit", "concern", or "blocker".
  "min_severity": "nit",

  // Show an OpenCode toast for each delivered note.
  "toast": true,

  // Opt in to aborting the watched turn when an advisor reports a blocker.
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

  // Number of later user turns for which an undelivered blocker remains injectable.
  "note_ttl_turns": 2,

  // Maximum duration of one advisor pass before its child session is aborted.
  "pass_timeout_ms": 180000,

  // Maximum age of a pending card pointer before it is discarded.
  "pending_ttl_ms": 600000,

  // Optional child-agent names to advise: true uses the roster, a string selects a model.
  "advise_agents": {},

  // Provider prefixes accepted in WATCHDOG.yml model references.
  "provider_aliases": {
    "bedrock-mantle": "amazon-bedrock"
  },

  // Reasoning-level suffixes accepted in WATCHDOG.yml model references.
  "variant_aliases": {
    "max": "xhigh"
  },

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
  "log_level": "info"
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

printf 'restart OpenCode to load the advisor plugin, command, or roster changes\n'
