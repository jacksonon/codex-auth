# Repository Guidelines

## Project Structure & Module Organization

- `agent-auth`: primary zsh CLI entrypoint (user-facing command).
- `agent-auth-node.js`: Node.js implementation of the same CLI behavior.
- `scripts/build-binaries.mjs`: Bun build script that compiles `agent-auth-node.js` into platform binaries.
- `.github/workflows/bun-build-artifacts.yml`: CI workflow for building artifacts and publishing GitHub Releases on `v*` tags.
- Docs: `README.md` (usage), `BUILD-BUN.md` (build notes and isolation pattern).
- Build output: `dist/` (ignored via `.gitignore`).

## Build, Test, and Development Commands

- `./install.sh`: installs the zsh entrypoint to `~/.local/bin/agent-auth` (or `TARGET_DIR=/path ./install.sh`).
- `node ./agent-auth-node.js help`: run the Node CLI directly during development.
- `bun run build`: build all supported binaries into `dist/`.
- `bun run build:macos` / `bun run build:windows`: build a subset of targets.

Manual safety test (avoids touching real config):
- `HOME="$(mktemp -d)" node ./agent-auth-node.js codex status`

## Coding Style & Naming Conventions

- JavaScript: Node `>=18`. Keep `agent-auth-node.js` CommonJS (`require(...)`), and keep build tooling in ESM (`*.mjs`). Use 2-space indentation, `const` by default, and small pure helper functions.
- Shell: zsh with `set -euo pipefail`; prefer `snake_case` function names and consistent, readable output formatting.
- CLI identifiers: provider IDs are expected to match `^[A-Za-z0-9][A-Za-z0-9_-]*$`.

## Testing Guidelines

- There is no automated test suite yet. Changes should be validated by running the core flows: `list`, `status`, `add`, `use`, `update`, `delete`, `official`.
- Always test with an isolated `HOME` (or override `AGENT_AUTH_DIR`/`CODEX_DIR`) and use dummy keys; never rely on or modify real local credentials.

## Commit & Pull Request Guidelines

- Commit messages in this repo are short, imperative, and sentence-cased (e.g., “Add Bun packaging workflow”). Keep messages focused on the user-visible change.
- PRs should include: a brief behavior summary, manual verification commands you ran, and doc updates (`README.md` / `BUILD-BUN.md`) if CLI flags or outputs changed.

## Security & Configuration Tips

- Do not log, print, or commit API keys. Redact secrets in examples and debug output.
- Preserve restrictive permissions for local state (the tool creates `~/.agent-auth/**` with `0700`-style intent); avoid widening access in new code.
