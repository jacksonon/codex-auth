#!/bin/zsh

set -euo pipefail

CODEX_DIR="${CODEX_DIR:-$HOME/.codex}"
CODEX_AUTH_DIR="${CODEX_AUTH_DIR:-$HOME/.codex-auth}"
CONFIG_FILE="$CODEX_DIR/config.toml"
AUTH_FILE="$CODEX_DIR/auth.json"
LEGACY_GPT_AUTH_FILE="$CODEX_DIR/auth_gpt.json"
LEGACY_PACKY_AUTH_FILE="$CODEX_DIR/auth_packy.json"
LEGACY_AUTH_PACKY_FILE="$CODEX_DIR/auth_3rd.json"
OFFICIAL_AUTH_DIR="$CODEX_AUTH_DIR/openai"
OFFICIAL_AUTH_FILE="$OFFICIAL_AUTH_DIR/auth.json"
PROVIDERS_DIR="$CODEX_AUTH_DIR/providers"
DEFAULT_PACKY_BASE_URL="https://codex-api-slb.packycode.com/v1"
DEFAULT_MODEL_PROVIDER="packycode"
DEFAULT_WIRE_API="responses"
typeset -ga CHANGE_LOGS=()

usage() {
  cat <<'EOF'
Usage:
  codex-auth gpt
  codex-auth official
  codex-auth <provider_id>
  codex-auth use <provider_id>
  codex-auth add <provider_id> --url <base_url> --key <api_key> [--name <display_name>] [--model <model>]
  codex-auth update <provider_id> [--name <display_name>] [--url <base_url>] [--key <api_key>] [--model <model>] [--clear-model]
  codex-auth list
  codex-auth status

Behavior:
  gpt / official  Restore official ~/.codex-auth/openai/auth.json when present and disable model_provider
  <provider_id>    Activate a provider stored under ~/.codex-auth/providers/<provider_id>.json
  use             Activate a provider stored under ~/.codex-auth/providers/<provider_id>.json
  add             Save a provider config under ~/.codex-auth/providers and activate it immediately
  update          Update a registered provider; if active, also refresh ~/.codex/config.toml + ~/.codex/auth.json
  list            List registered third-party providers
  status          Print current config/auth/provider status

Notes:
  - Official ChatGPT auth is backed up to ~/.codex-auth/openai/auth.json when detected.
  - Third-party providers are stored under ~/.codex-auth and rendered into ~/.codex/config.toml + ~/.codex/auth.json on activation.
  - The current implementation assumes an OpenAI-compatible provider that accepts an OPENAI_API_KEY-style token.
EOF
}

fail() {
  echo "Error: $*" >&2
  exit 1
}

print_block_title() {
  local title="$1"
  printf '\n%s\n' "$title"
}

print_kv() {
  local key="$1"
  local value="$2"
  printf '%-18s %s\n' "$key" "$value"
}

log_note() {
  local scope="$1"
  local message="$2"
  CHANGE_LOGS+=("${scope}"$'\t'"${message}")
}

reset_change_logs() {
  CHANGE_LOGS=()
}

print_change_logs() {
  local entry
  local scope
  local message

  [[ ${#CHANGE_LOGS[@]} -gt 0 ]] || return 0

  print_block_title "Changes"
  for entry in "${CHANGE_LOGS[@]}"; do
    scope="${entry%%$'\t'*}"
    message="${entry#*$'\t'}"
    print_kv "$scope" "$message"
  done
}

print_provider_header() {
  local title="$1"
  local provider_id="$2"
  local provider_name="$3"
  local base_url="$4"
  local model="${5:-}"

  print_block_title "${title}: ${provider_id}"
  print_kv "provider" "$provider_name"
  print_kv "base_url" "$base_url"
  [[ -n "$model" ]] && print_kv "model" "$model"
}

print_result_summary() {
  local mode="$1"
  local auth_kind_value="$2"

  print_block_title "Result"
  print_kv "mode" "$mode"
  print_kv "auth_kind" "$auth_kind_value"
}

describe_file_state() {
  local file="$1"
  if [[ -f "$file" ]]; then
    echo "present: $file"
  else
    echo "missing: $file"
  fi
}

require_file() {
  local file="$1"
  [[ -f "$file" ]] || fail "missing file: $file"
}

ensure_layout() {
  mkdir -p "$CODEX_AUTH_DIR" "$OFFICIAL_AUTH_DIR" "$PROVIDERS_DIR"
  chmod 700 "$CODEX_AUTH_DIR" "$OFFICIAL_AUTH_DIR" "$PROVIDERS_DIR" 2>/dev/null || true
}

backup_file() {
  local file="$1"
  [[ -f "$file" ]] || return 0
  local backup="${file}.bak"
  if [[ -f "$backup" ]]; then
    log_note "backup" "exists: $backup"
    return 0
  fi
  cp "$file" "$backup"
  log_note "backup" "created: $backup"
}

files_match() {
  local first="$1"
  local second="$2"
  [[ -f "$first" && -f "$second" ]] || return 1
  cmp -s "$first" "$second"
}

validate_provider_id() {
  local provider_id="$1"
  [[ "$provider_id" =~ ^[A-Za-z0-9][A-Za-z0-9_-]*$ ]] || fail "invalid provider_id: $provider_id"
}

provider_file_for() {
  local provider_id="$1"
  echo "$PROVIDERS_DIR/$provider_id.json"
}

provider_exists() {
  local provider_id="$1"
  [[ -f "$(provider_file_for "$provider_id")" ]]
}

auth_kind() {
  local file="$1"
  ruby -rjson -e '
    path = ARGV[0]
    begin
      data = JSON.parse(File.read(path))
    rescue JSON::ParserError
      puts "invalid"
      exit
    end

    if data.is_a?(Hash) && data.keys.sort == ["OPENAI_API_KEY"]
      puts "api_key"
    elsif data.is_a?(Hash)
      puts "official"
    else
      puts "unknown"
    end
  ' "$file"
}

read_openai_api_key() {
  local file="$1"
  ruby -rjson -e '
    path = ARGV[0]
    begin
      data = JSON.parse(File.read(path))
    rescue JSON::ParserError
      exit 1
    end

    value = data.is_a?(Hash) ? data["OPENAI_API_KEY"] : nil
    exit 1 unless value.is_a?(String) && !value.empty?
    puts value
  ' "$file"
}

provider_value() {
  local file="$1"
  local key="$2"
  ruby -rjson -e '
    data = JSON.parse(File.read(ARGV[0]))
    value = data[ARGV[1]]

    case value
    when nil
      exit 1
    when TrueClass, FalseClass
      puts(value ? "true" : "false")
    else
      puts value
    end
  ' "$file" "$key"
}

provider_base_url_from_config() {
  local provider_id="$1"
  local fallback="$2"

  if [[ ! -f "$CONFIG_FILE" ]]; then
    echo "$fallback"
    return 0
  fi

  ruby -e '
    path = ARGV[0]
    provider_id = ARGV[1]
    fallback = ARGV[2]
    lines = File.read(path).lines
    target = "[model_providers.#{provider_id}]"
    start = lines.index { |line| line.strip == target }
    if start.nil?
      puts fallback
      exit
    end

    finish = lines[(start + 1)..].index { |line| line.match?(/^\s*\[[^\]]+\]\s*$/) }
    finish = finish.nil? ? lines.length : start + 1 + finish
    section = lines[start...finish]

    base_line = section.find { |line| line.match?(/^\s*base_url\s*=/) }
    base_line ||= section.find { |line| line.match?(/^\s*#\s*base_url\s*=/) }
    if base_line && (match = base_line.match(/=\s*"([^"]+)"/))
      puts match[1]
    else
      puts fallback
    end
  ' "$CONFIG_FILE" "$provider_id" "$fallback"
}

write_provider_file() {
  local provider_id="$1"
  local name="$2"
  local base_url="$3"
  local api_key="$4"
  local model="$5"
  local file
  file="$(provider_file_for "$provider_id")"
  ensure_layout

  ruby -rjson -rtime -e '
    path = ARGV[0]
    provider_id = ARGV[1]
    name = ARGV[2]
    base_url = ARGV[3]
    api_key = ARGV[4]
    model = ARGV[5]

    payload = {
      "schema_version" => 1,
      "provider_id" => provider_id,
      "name" => name,
      "base_url" => base_url,
      "api_key" => api_key,
      "wire_api" => "responses",
      "requires_openai_auth" => true,
      "updated_at" => Time.now.utc.iso8601
    }
    payload["model"] = model unless model.nil? || model.empty?

    File.write(path, JSON.pretty_generate(payload) + "\n")
  ' "$file" "$provider_id" "$name" "$base_url" "$api_key" "$model"

  chmod 600 "$file"
  log_note "provider" "saved: $file"
}

write_api_key_auth_file() {
  local api_key="$1"
  ensure_layout

  ruby -rjson -e '
    path = ARGV[0]
    api_key = ARGV[1]
    payload = { "OPENAI_API_KEY" => api_key }
    File.write(path, JSON.pretty_generate(payload) + "\n")
  ' "$AUTH_FILE" "$api_key"

  chmod 600 "$AUTH_FILE"
  log_note "auth" "rendered: $AUTH_FILE"
}

copy_if_different() {
  local source="$1"
  local destination="$2"
  mkdir -p "$(dirname "$destination")"
  if files_match "$source" "$destination"; then
    return 0
  fi
  cp "$source" "$destination"
  chmod 600 "$destination" 2>/dev/null || true
  log_note "sync" "updated: $destination"
}

backup_official_auth_if_present() {
  ensure_layout

  if [[ -f "$AUTH_FILE" ]]; then
    case "$(auth_kind "$AUTH_FILE")" in
      official)
        copy_if_different "$AUTH_FILE" "$OFFICIAL_AUTH_FILE"
        ;;
      api_key)
        log_note "official auth" "skip backup: current auth kind is api_key"
        ;;
      invalid)
        log_note "official auth" "skip backup: invalid JSON at $AUTH_FILE"
        ;;
      *)
        log_note "official auth" "skip backup: unknown format at $AUTH_FILE"
        ;;
    esac
    return 0
  fi

  if [[ -f "$LEGACY_GPT_AUTH_FILE" ]] && [[ "$(auth_kind "$LEGACY_GPT_AUTH_FILE")" == "official" ]]; then
    copy_if_different "$LEGACY_GPT_AUTH_FILE" "$OFFICIAL_AUTH_FILE"
  else
    log_note "official auth" "skip backup: no official auth file found"
  fi
}

restore_official_auth_if_present() {
  if [[ -f "$OFFICIAL_AUTH_FILE" ]]; then
    cp "$OFFICIAL_AUTH_FILE" "$AUTH_FILE"
    chmod 600 "$AUTH_FILE" 2>/dev/null || true
    log_note "official auth" "restored: $OFFICIAL_AUTH_FILE"
  else
    log_note "official auth" "skip restore: backup missing at $OFFICIAL_AUTH_FILE"
  fi
}

migrate_legacy_provider_if_needed() {
  local provider_id="$DEFAULT_MODEL_PROVIDER"
  local provider_file
  provider_file="$(provider_file_for "$provider_id")"
  [[ -f "$provider_file" ]] && return 0

  local legacy_auth="$LEGACY_PACKY_AUTH_FILE"
  [[ -f "$legacy_auth" ]] || legacy_auth="$LEGACY_AUTH_PACKY_FILE"
  [[ -f "$legacy_auth" ]] || return 0

  local api_key
  api_key="$(read_openai_api_key "$legacy_auth" 2>/dev/null || true)"
  [[ -n "$api_key" ]] || return 0

  local base_url
  base_url="$(provider_base_url_from_config "$provider_id" "$DEFAULT_PACKY_BASE_URL")"
  write_provider_file "$provider_id" "$provider_id" "$base_url" "$api_key" ""
  log_note "provider" "migrated legacy config: $provider_id"
}

migrate_legacy_layout() {
  ensure_layout
  backup_official_auth_if_present
  migrate_legacy_provider_if_needed
}

set_mode_specific_config() {
  local mode="$1"

  ruby -e '
    path = ARGV[0]
    mode = ARGV[1]
    lines = File.read(path).lines

    def upsert_top_level(lines, key, new_line)
      pattern = /^\s*#?\s*#{Regexp.escape(key)}\s*=/
      replaced = false
      result = []

      lines.each do |line|
        if line.match?(pattern)
          unless replaced
            result << new_line
            replaced = true
          end
        else
          result << line
        end
      end

      result.unshift(new_line) unless replaced
      result
    end

    web_search_line = mode == "provider" ? "web_search = \"live\"\n" : "#web_search = \"live\"\n"
    context_window_line = "model_context_window = 256000\n"
    compact_line = "#model_auto_compact_token_limit = 900000\n"
    status_items = [
      "model-with-reasoning",
      "fast-mode",
      "context-window-size",
      "context-used",
      "context-remaining",
      "used-tokens",
      "total-input-tokens",
      "total-output-tokens",
      "git-branch"
    ]
    status_items += ["five-hour-limit", "weekly-limit"] if mode == "official"
    status_line = "status_line = [#{status_items.map { |item| "\"#{item}\"" }.join(", ")}]\n"

    lines = upsert_top_level(lines, "web_search", web_search_line)
    lines = upsert_top_level(lines, "model_context_window", context_window_line)
    lines = upsert_top_level(lines, "model_auto_compact_token_limit", compact_line)

    tui_start = lines.index { |line| line.match?(/^\s*\[tui\]\s*$/) }

    if tui_start.nil?
      lines << "\n" unless lines.empty? || lines.last == "\n"
      lines << "[tui]\n"
      lines << status_line
    else
      tui_end = lines[(tui_start + 1)..].index { |line| line.match?(/^\s*\[[^\]]+\]\s*$/) }
      tui_end = tui_end.nil? ? lines.length : tui_start + 1 + tui_end
      replaced = false
      result = []

      lines.each_with_index do |line, idx|
        if idx > tui_start && idx < tui_end && line.match?(/^\s*status_line\s*=/)
          unless replaced
            result << status_line
            replaced = true
          end
        else
          result << line
        end
      end

      unless replaced
        insert_at = result.length
        result.each_with_index do |line, idx|
          if idx > tui_start && line.match?(/^\s*\[[^\]]+\]\s*$/)
            insert_at = idx
            break
          end
        end
        result.insert(insert_at, status_line)
      end

      lines = result
    end

    File.write(path, lines.join)
  ' "$CONFIG_FILE" "$mode"

  log_note "config" "mode settings applied: $mode"
}

set_active_provider() {
  local provider_id="${1:-}"
  local mode="$2"

  ruby -e '
    path = ARGV[0]
    provider_id = ARGV[1]
    mode = ARGV[2]
    lines = File.read(path).lines
    pattern = /^\s*#?\s*model_provider\s*=/
    replacement = mode == "official" ? nil : "model_provider = \"#{provider_id}\"\n"
    replaced = false
    result = []

    lines.each do |line|
      if line.match?(pattern)
        unless replaced
          result << replacement if replacement
          replaced = true
        end
      else
        result << line
      end
    end

    result.unshift(replacement) if replacement && !replaced
    File.write(path, result.join)
  ' "$CONFIG_FILE" "$provider_id" "$mode"

  if [[ "$mode" == "official" ]]; then
    log_note "config" "model_provider disabled"
  else
    log_note "config" "model_provider = $provider_id"
  fi
}

upsert_top_level_string() {
  local key="$1"
  local value="$2"

  ruby -e '
    path = ARGV[0]
    key = ARGV[1]
    value = ARGV[2]
    lines = File.read(path).lines
    pattern = /^\s*#?\s*#{Regexp.escape(key)}\s*=/
    new_line = "#{key} = \"#{value}\"\n"
    replaced = false
    result = []

    lines.each do |line|
      if line.match?(pattern)
        unless replaced
          result << new_line
          replaced = true
        end
      else
        result << line
      end
    end

    result.unshift(new_line) unless replaced
    File.write(path, result.join)
  ' "$CONFIG_FILE" "$key" "$value"

  log_note "config" "$key = $value"
}

upsert_provider_section() {
  local provider_id="$1"
  local name="$2"
  local base_url="$3"
  local wire_api="$4"
  local requires_openai_auth="$5"

  ruby -e '
    path = ARGV[0]
    provider_id = ARGV[1]
    name = ARGV[2]
    base_url = ARGV[3]
    wire_api = ARGV[4]
    requires_openai_auth = ARGV[5]
    lines = File.read(path).lines
    header = "[model_providers.#{provider_id}]"
    section = [
      "#{header}\n",
      "name = \"#{name}\"\n",
      "base_url = \"#{base_url}\"\n",
      "wire_api = \"#{wire_api}\"\n",
      "requires_openai_auth = #{requires_openai_auth}\n"
    ]

    start = lines.index { |line| line.strip == header }
    if start.nil?
      lines << "\n" unless lines.empty? || lines.last == "\n"
      lines.concat(section)
    else
      finish = lines[(start + 1)..].index { |line| line.match?(/^\s*\[[^\]]+\]\s*$/) }
      finish = finish.nil? ? lines.length : start + 1 + finish
      lines = lines[0...start] + section + lines[finish..]
    end

    File.write(path, lines.join)
  ' "$CONFIG_FILE" "$provider_id" "$name" "$base_url" "$wire_api" "$requires_openai_auth"

  log_note "config" "provider section refreshed: [model_providers.$provider_id]"
}

config_mode() {
  ruby -e '
    text = File.read(ARGV[0])
    if (match = text.match(/^[[:space:]]*model_provider[[:space:]]*=[[:space:]]*"([^"]+)"/))
      puts match[1]
    else
      puts "official"
    end
  ' "$CONFIG_FILE"
}

activate_provider() {
  local provider_id="$1"
  validate_provider_id "$provider_id"
  migrate_legacy_layout
  require_file "$CONFIG_FILE"

  local provider_file
  provider_file="$(provider_file_for "$provider_id")"
  require_file "$provider_file"

  local name base_url api_key wire_api requires_openai_auth model
  name="$(provider_value "$provider_file" "name")"
  base_url="$(provider_value "$provider_file" "base_url")"
  api_key="$(provider_value "$provider_file" "api_key")"
  wire_api="$(provider_value "$provider_file" "wire_api")"
  requires_openai_auth="$(provider_value "$provider_file" "requires_openai_auth")"
  model="$(provider_value "$provider_file" "model" 2>/dev/null || true)"

  [[ "$requires_openai_auth" == "true" ]] || fail "provider auth mode is not supported yet: $provider_id"

  backup_file "$CONFIG_FILE"
  write_api_key_auth_file "$api_key"
  set_active_provider "$provider_id" "provider"
  upsert_provider_section "$provider_id" "$name" "$base_url" "$wire_api" "$requires_openai_auth"
  if [[ -n "$model" ]]; then
    upsert_top_level_string "model" "$model"
  fi
  set_mode_specific_config "provider"
  print_status
}

switch_to_official() {
  migrate_legacy_layout
  require_file "$CONFIG_FILE"
  backup_file "$CONFIG_FILE"
  restore_official_auth_if_present
  set_active_provider "" "official"
  set_mode_specific_config "official"
  print_status
}

add_provider() {
  local provider_id="$1"
  shift
  validate_provider_id "$provider_id"

  local name="$provider_id"
  local base_url=""
  local api_key=""
  local model=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --name)
        [[ $# -ge 2 ]] || fail "missing value for --name"
        name="$2"
        shift 2
        ;;
      --url|--base-url)
        [[ $# -ge 2 ]] || fail "missing value for --url"
        base_url="$2"
        shift 2
        ;;
      --key|--api-key)
        [[ $# -ge 2 ]] || fail "missing value for --key"
        api_key="$2"
        shift 2
        ;;
      --model)
        [[ $# -ge 2 ]] || fail "missing value for --model"
        model="$2"
        shift 2
        ;;
      *)
        fail "unknown option for add: $1"
        ;;
    esac
  done

  [[ -n "$base_url" ]] || fail "--url is required"
  [[ -n "$api_key" ]] || fail "--key is required"

  write_provider_file "$provider_id" "$name" "$base_url" "$api_key" "$model"
  activate_provider "$provider_id"
}

list_providers() {
  ensure_layout

  local files=("$PROVIDERS_DIR"/*.json(N))
  if [[ ${#files[@]} -eq 0 ]]; then
    print_block_title "Providers"
    echo "(none)"
    return 0
  fi

  ruby -rjson -e '
    headers = ["PROVIDER_ID", "NAME", "BASE_URL", "MODEL", "UPDATED_AT"]
    rows = ARGV.sort.map do |path|
      data = JSON.parse(File.read(path))
      [
        data["provider_id"].to_s,
        data["name"].to_s.empty? ? "-" : data["name"].to_s,
        data["base_url"].to_s.empty? ? "-" : data["base_url"].to_s,
        data["model"].to_s.empty? ? "-" : data["model"].to_s,
        data["updated_at"].to_s.empty? ? "-" : data["updated_at"].to_s
      ]
    end

    widths = headers.each_index.map do |index|
      ([headers[index].length] + rows.map { |row| row[index].length }).max
    end
    format_line = widths.map { |width| "%-#{width}s" }.join("  ")

    puts
    puts "Providers"
    puts(format_line % headers)
    puts(widths.map { |width| "-" * width }.join("  "))
    rows.each do |row|
      puts(format_line % row)
    end
  ' "${files[@]}"
}

print_status() {
  require_file "$CONFIG_FILE"

  local current_auth_kind="missing"
  [[ -f "$AUTH_FILE" ]] && current_auth_kind="$(auth_kind "$AUTH_FILE")"

  print_block_title "Status"
  print_kv "config_mode" "$(config_mode)"
  print_kv "config_file" "$CONFIG_FILE"
  print_kv "auth_file" "$(describe_file_state "$AUTH_FILE")"
  print_kv "auth_kind" "$current_auth_kind"
  print_kv "official_backup" "$(describe_file_state "$OFFICIAL_AUTH_FILE")"
  print_kv "providers_dir" "$PROVIDERS_DIR"
  print_kv "providers" "$(find "$PROVIDERS_DIR" -maxdepth 1 -name '*.json' | wc -l | tr -d ' ')"
}

main() {
  local action="${1:-}"

  case "$action" in
    gpt|official)
      shift
      [[ $# -eq 0 ]] || fail "unexpected arguments for $action"
      switch_to_official
      ;;
    use)
      shift
      [[ $# -ge 1 ]] || fail "provider_id is required for use"
      local provider_id="$1"
      shift
      [[ $# -eq 0 ]] || fail "unexpected arguments for use"
      activate_provider "$provider_id"
      ;;
    add)
      shift
      [[ $# -ge 1 ]] || fail "provider_id is required for add"
      local provider_id="$1"
      shift
      add_provider "$provider_id" "$@"
      ;;
    list)
      shift
      [[ $# -eq 0 ]] || fail "unexpected arguments for list"
      migrate_legacy_layout
      list_providers
      ;;
    status)
      shift
      [[ $# -eq 0 ]] || fail "unexpected arguments for status"
      migrate_legacy_layout
      print_status
      ;;
    packy)
      shift
      [[ $# -eq 0 ]] || fail "unexpected arguments for $action"
      if provider_exists "packy"; then
        activate_provider "packy"
      else
        activate_provider "$DEFAULT_MODEL_PROVIDER"
      fi
      ;;
    third)
      shift
      [[ $# -eq 0 ]] || fail "unexpected arguments for $action"
      activate_provider "$DEFAULT_MODEL_PROVIDER"
      ;;
    *)
      if [[ -n "$action" ]] && provider_exists "$action"; then
        shift
        [[ $# -eq 0 ]] || fail "unexpected arguments for provider $action"
        activate_provider "$action"
      else
        usage
        exit 1
      fi
      ;;
  esac
}

main "$@"
