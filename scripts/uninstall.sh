#!/usr/bin/env bash

set -euo pipefail

HOME_DIR="${HOME:?HOME must be set}"
PLUGIN_LINK="$HOME_DIR/.config/opencode/plugins/advisor.ts"
CLI_LINK="$HOME_DIR/.local/bin/advisor"

if [[ -L "$PLUGIN_LINK" ]]; then
  rm "$PLUGIN_LINK"
  printf 'removed %s\n' "$PLUGIN_LINK"
else
  printf 'left non-symlink or absent path untouched: %s\n' "$PLUGIN_LINK"
fi

if [[ -L "$CLI_LINK" ]]; then
  rm "$CLI_LINK"
  printf 'removed %s\n' "$CLI_LINK"
else
  printf 'left non-symlink or absent path untouched: %s\n' "$CLI_LINK"
fi

printf 'configuration and advisor data were left in place\n'
