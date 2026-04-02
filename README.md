# agent-auth

`agent-auth` is a unified CLI for switching third-party auth/config across multiple coding agents.

Current built-in renderers:
- `codex`
- `claude`
- `gemini`

The command model is standardized:

```bash
agent-auth <agent> <command> ...
```

Provider registry is stored under `~/.agent-auth/providers/<agent>/<provider_id>.json`, and runtime state is stored under `~/.agent-auth/state/<agent>.json`.

## Managed Runtime Targets

- `codex`: `~/.codex/config.toml` + `~/.codex/auth.json`
- `claude`: `~/.claude/settings.json`
- `gemini`: `~/.gemini/.env`

`agent-auth` keeps one renderer per agent, so adding another agent later only requires a new renderer branch and its runtime file mapping.

## Install

```bash
./install.sh
```

If `~/.local/bin` is not already in `PATH`:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

Install to a custom target directory:

```bash
TARGET_DIR=/tmp/agent-auth-bin ./install.sh
```

## Global Commands

```bash
agent-auth help
agent-auth agents
```

## Standard Commands

```bash
agent-auth <agent> help
agent-auth <agent> list
agent-auth <agent> status
agent-auth <agent> official
agent-auth <agent> use <provider_id>
agent-auth <agent> add <provider_id> --url <base_url> --key <api_key> [--name <display_name>] [--model <model>] [--env KEY=VALUE ...]
agent-auth <agent> update <provider_id> [--name <display_name>] [--url <base_url>] [--key <api_key>] [--model <model>] [--env KEY=VALUE ...] [--unset-env KEY ...]
```

Notes:
- `--url` and `--key` are the standard input fields for all built-in agents.
- `--env KEY=VALUE` can be repeated for agent-specific extensions.
- `--unset-env KEY` is available on `update` to remove a previously stored env override.

## Examples

### Codex

```bash
agent-auth codex add packycode \
  --name "Packy Code CN" \
  --url "https://codex-api-slb.packycode.com/v1" \
  --key "sk-xxxx" \
  --model "gpt-5.4"
```

```bash
agent-auth codex use packycode
agent-auth codex status
agent-auth codex official
```

### Claude

This command renders the provider into `~/.claude/settings.json` under `env`.

```bash
agent-auth claude add packy \
  --name "Packy Claude" \
  --url "https://www.packyapi.com" \
  --key "xxx"
```

Rendered shape:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://www.packyapi.com",
    "ANTHROPIC_AUTH_TOKEN": "xxx",
    "CLAUDE_CODE_ATTRIBUTION_HEADER": "0",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
    "CLAUDE_CODE_DISABLE_TERMINAL_TITLE": "1"
  }
}
```

Extra env example:

```bash
agent-auth claude update packy \
  --env CLAUDE_CODE_MAX_OUTPUT_TOKENS=64000
```

### Gemini

This command renders the provider into `~/.gemini/.env`.

```bash
agent-auth gemini add packy \
  --name "Packy Gemini" \
  --url "https://www.packyapi.com" \
  --key "xxx"
```

Rendered shape:

```dotenv
GOOGLE_GEMINI_BASE_URL=https://www.packyapi.com
GEMINI_API_KEY=xxx
```

Extra env example:

```bash
agent-auth gemini update packy \
  --env GEMINI_MODEL=gemini-2.5-pro
```

## Status And List

```bash
agent-auth claude list
agent-auth gemini status
```

Example list output:

```text
Providers: claude
PROVIDER_ID  NAME           BASE_URL                   MODEL  ENV_KEYS                                   UPDATED_AT
-----------  -------------  -------------------------  -----  -----------------------------------------  --------------------
packy        Packy Claude   https://www.packyapi.com   -      -                                          2026-04-02T12:00:00Z
```

## Official Mode

- `agent-auth codex official`: restore backed-up official auth when available; otherwise remove managed API-key auth and disable `model_provider`.
- `agent-auth claude official`: restore backed-up `settings.json` when available; otherwise clear managed Claude env keys.
- `agent-auth gemini official`: restore backed-up `.env` when available; otherwise clear managed Gemini env keys.

## Notes

- The old `codex-auth` entrypoint is intentionally removed. Use `agent-auth <agent> ...`.
- Existing legacy `~/.codex-auth/providers/*.json` and official Codex backup are migrated into the new registry on first `agent-auth codex ...` run.
- `codex` still uses OpenAI-compatible provider rendering and writes `OPENAI_API_KEY` into `~/.codex/auth.json`.
