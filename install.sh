#!/bin/zsh

set -euo pipefail

SCRIPT_DIR="${0:A:h}"
SOURCE_FILE="$SCRIPT_DIR/agent-auth"
HELPER_SOURCE_FILE="$SCRIPT_DIR/codex_sessions_list.mjs"
TARGET_DIR="${TARGET_DIR:-$HOME/.local/bin}"
TARGET_FILE="$TARGET_DIR/agent-auth"
HELPER_TARGET_FILE="$TARGET_DIR/codex_sessions_list.mjs"

fail() {
  echo "Error: $*" >&2
  exit 1
}

[[ -f "$SOURCE_FILE" ]] || fail "missing source script: $SOURCE_FILE"
[[ -f "$HELPER_SOURCE_FILE" ]] || fail "missing helper script: $HELPER_SOURCE_FILE"

mkdir -p "$TARGET_DIR"
cp "$SOURCE_FILE" "$TARGET_FILE"
chmod +x "$TARGET_FILE"

cp "$HELPER_SOURCE_FILE" "$HELPER_TARGET_FILE"
chmod +x "$HELPER_TARGET_FILE"

printf 'Installed %s -> %s\n' "$SOURCE_FILE" "$TARGET_FILE"
printf 'Installed %s -> %s\n' "$HELPER_SOURCE_FILE" "$HELPER_TARGET_FILE"
