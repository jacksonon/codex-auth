#!/bin/zsh

set -euo pipefail

SCRIPT_DIR="${0:A:h}"
SOURCE_FILE="$SCRIPT_DIR/agent-auth"
TARGET_DIR="${TARGET_DIR:-$HOME/.local/bin}"
TARGET_FILE="$TARGET_DIR/agent-auth"

fail() {
  echo "Error: $*" >&2
  exit 1
}

[[ -f "$SOURCE_FILE" ]] || fail "missing source script: $SOURCE_FILE"

mkdir -p "$TARGET_DIR"
cp "$SOURCE_FILE" "$TARGET_FILE"
chmod +x "$TARGET_FILE"

printf 'Installed %s -> %s\n' "$SOURCE_FILE" "$TARGET_FILE"
