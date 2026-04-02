# codex-auth

`codex-auth` is a small CLI for switching Codex between official ChatGPT auth and third-party OpenAI-compatible providers.

It manages:
- `~/.codex/config.toml`
- `~/.codex/auth.json`
- `~/.codex-auth/openai/auth.json`
- `~/.codex-auth/providers/*.json`

The repo source is [switch_codex_auth.sh](/Users/os/Downloads/private/easy-pass/switch_codex_auth.sh). In this workspace the global command is typically synced to `/Users/os/.local/bin/codex-auth`.

## Commands

```bash
codex-auth help
codex-auth --help
codex-auth -h

codex-auth official
codex-auth gpt

codex-auth list
codex-auth status

codex-auth <provider_id>
codex-auth use <provider_id>

codex-auth add <provider_id> --url <base_url> --key <api_key> [--name <display_name>] [--model <model>]
codex-auth update <provider_id> [--name <display_name>] [--url <base_url>] [--key <api_key>] [--model <model>]
```

## Behavior

- `official` / `gpt`: restore official auth from `~/.codex-auth/openai/auth.json` and disable `model_provider`.
- `<provider_id>` / `use <provider_id>`: activate a registered provider from `~/.codex-auth/providers/<provider_id>.json`.
- `add`: save a provider config and activate it immediately.
- `update`: update an existing provider config. If that provider is currently active, Codex runtime config is refreshed immediately.
- `list`: print registered providers as a table.
- `status`: print the current mode, auth kind, config path, and provider registry state.

## Common Usage

### Show help

```bash
codex-auth help
```

### List all registered providers

```bash
codex-auth list
```

Example output:

```text
Providers
PROVIDER_ID  NAME       BASE_URL                                MODEL  UPDATED_AT
-----------  ---------  --------------------------------------  -----  --------------------
packy        packy      https://www.packyapi.com/v1             -      2026-04-02T07:53:21Z
packycode    packycode  https://codex-api-slb.packycode.com/v1  -      2026-04-02T07:38:08Z
```

### Check current auth status

```bash
codex-auth status
```

### Switch to official ChatGPT auth

```bash
codex-auth official
```

### Switch to a registered provider

```bash
codex-auth packy
codex-auth packycode
```

Or explicitly:

```bash
codex-auth use packy
codex-auth use packycode
```

### Add a new provider

```bash
codex-auth add cubence \
  --name "Cubence" \
  --url "https://api.cubence.com/v1" \
  --key "sk-xxxx" \
  --model "gpt-5.4"
```

### Update an existing provider

Update display name:

```bash
codex-auth update packy --name "Packy Pro"
```

Update base URL:

```bash
codex-auth update packy --url "https://api.packy.pro/v1"
```

Update API key:

```bash
codex-auth update packy --key "sk-new-key"
```

Update several fields at once:

```bash
codex-auth update packycode \
  --name "Packy Code CN" \
  --url "https://codex-api-slb.packycode.com/v1" \
  --key "sk-xxxx" \
  --model "gpt-5.4"
```

## Output Style

Action commands use a compact summary format:

```text
Activate provider: packy
provider           Packy
base_url           https://www.packyapi.com/v1

Changes
backup             created: /Users/os/.codex/config.toml.bak
auth               rendered: /Users/os/.codex/auth.json
config             model_provider = packy
config             provider section refreshed: [model_providers.packy]
config             mode settings applied: provider

Result
mode               packy
auth_kind          api_key
```

## Notes

- Provider IDs are matched by registered provider file name and `provider_id`, not by fuzzy name matching.
- `packy` and `packycode` are treated as different providers.
- Official auth is backed up when detected and later restored via `official` / `gpt`.
- Current provider configs assume an OpenAI-compatible endpoint that accepts an `OPENAI_API_KEY`-style token.
