# Bun Build Notes

## New Node.js Entry

- Source: `./agent-auth-node.js`
- Original zsh entry remains unchanged: `./agent-auth`

## Requirements

- Node.js 18+
- Bun 1.1+

## Build Commands

Build all supported targets:

```bash
bun run build
```

Build only macOS binaries:

```bash
bun run build:macos
```

Build only Windows x64 binary:

```bash
bun run build:windows
```

Build one target only:

```bash
bun run build:macos:x64
bun run build:macos:arm64
bun run build:windows:x64
```

## Output

Artifacts are written to `./dist`:

- `agent-auth-macos-x64`
- `agent-auth-macos-arm64`
- `agent-auth-windows-x64.exe`

## Direct Execution

You can also run the Node.js CLI directly:

```bash
node ./agent-auth-node.js help
node ./agent-auth-node.js codex status
```

## Isolation Test Pattern

To avoid touching real local config during testing, run with an isolated `HOME`:

```bash
TMP_HOME=$(mktemp -d)
mkdir -p "$TMP_HOME/.codex"
printf '[tui]\nstatus_line = ["git-branch"]\n' > "$TMP_HOME/.codex/config.toml"
HOME="$TMP_HOME" node ./agent-auth-node.js codex add demo --url https://example.com/v1 --key sk-demo
```
