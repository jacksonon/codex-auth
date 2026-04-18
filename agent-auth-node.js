#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOME = os.homedir();
const AGENT_AUTH_DIR = process.env.AGENT_AUTH_DIR || path.join(HOME, '.agent-auth');
const LEGACY_CODEX_AUTH_DIR = process.env.LEGACY_CODEX_AUTH_DIR || path.join(HOME, '.codex-auth');

const PROVIDERS_ROOT = path.join(AGENT_AUTH_DIR, 'providers');
const STATE_DIR = path.join(AGENT_AUTH_DIR, 'state');
const MIGRATIONS_DIR = path.join(AGENT_AUTH_DIR, 'migrations');

const CODEX_DIR = process.env.CODEX_DIR || path.join(HOME, '.codex');
const CODEX_CONFIG_FILE = path.join(CODEX_DIR, 'config.toml');
const CODEX_AUTH_FILE = path.join(CODEX_DIR, 'auth.json');

const CLAUDE_DIR = process.env.CLAUDE_DIR || path.join(HOME, '.claude');
const CLAUDE_SETTINGS_FILE = path.join(CLAUDE_DIR, 'settings.json');

const GEMINI_DIR = process.env.GEMINI_DIR || path.join(HOME, '.gemini');
const GEMINI_ENV_FILE = path.join(GEMINI_DIR, '.env');

const DEFAULT_WIRE_API = 'responses';
const SUPPORTED_AGENTS = ['codex', 'claude', 'gemini'];
const CHANGE_LOGS = [];

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function usage() {
  process.stdout.write(`Usage:\n  agent-auth help\n  agent-auth agents\n\n  agent-auth <agent> help\n  agent-auth <agent> list\n  agent-auth <agent> status\n  agent-auth <agent> official\n  agent-auth <agent> use <provider_id>\n  agent-auth <agent> add <provider_id> --url <base_url> --key <api_key> [--name <display_name>] [--model <model>] [--env KEY=VALUE ...]\n  agent-auth <agent> update <provider_id> [--name <display_name>] [--url <base_url>] [--key <api_key>] [--model <model>] [--env KEY=VALUE ...] [--unset-env KEY ...]\n  agent-auth <agent> delete <provider_id>\n  agent-auth codex sessions [YYYY|YYYYMM|YYYYMMDD] [--table|--tsv|--json] [--full] [--short-id] [--limit N]\n\nAgents:\n  codex   Render provider config into ~/.codex/config.toml + ~/.codex/auth.json\n  claude  Render provider env into ~/.claude/settings.json\n  gemini  Render provider env into ~/.gemini/.env\n\nNotes:\n  - Provider registry is stored under ~/.agent-auth/providers/<agent>/<provider_id>.json\n  - agent-auth keeps per-agent state in ~/.agent-auth/state/<agent>.json\n  - claude / gemini use common --url and --key flags, then map them to their runtime env names\n  - Extra provider-specific env vars can be supplied with repeated --env KEY=VALUE flags\n`);
}

function usageForAgent(agent) {
  process.stdout.write(`Usage:\n  agent-auth ${agent} list\n  agent-auth ${agent} status\n  agent-auth ${agent} official\n  agent-auth ${agent} use <provider_id>\n  agent-auth ${agent} add <provider_id> --url <base_url> --key <api_key> [--name <display_name>] [--model <model>] [--env KEY=VALUE ...]\n  agent-auth ${agent} update <provider_id> [--name <display_name>] [--url <base_url>] [--key <api_key>] [--model <model>] [--env KEY=VALUE ...] [--unset-env KEY ...]\n  agent-auth ${agent} delete <provider_id>\n`);
  if (agent === 'codex') {
    process.stdout.write('  agent-auth codex sessions [YYYY|YYYYMM|YYYYMMDD] [--table|--tsv|--json] [--full] [--short-id] [--limit N]\\n');
  }
}

function printBlockTitle(title) {
  process.stdout.write(`\n${title}\n`);
}

function printKv(key, value) {
  process.stdout.write(`${String(key).padEnd(18)} ${value}\n`);
}

function resetChangeLogs() {
  CHANGE_LOGS.length = 0;
}

function logNote(scope, message) {
  CHANGE_LOGS.push([scope, message]);
}

function printChangeLogs() {
  if (CHANGE_LOGS.length === 0) return;
  printBlockTitle('Changes');
  for (const [scope, message] of CHANGE_LOGS) {
    printKv(scope, message);
  }
}

function printProviderHeader(title, agent, providerId, providerName, baseUrl = '', model = '') {
  printBlockTitle(`${title}: ${agent}/${providerId}`);
  printKv('agent', agent);
  printKv('provider', providerName);
  if (baseUrl) printKv('base_url', baseUrl);
  if (model) printKv('model', model);
}

function printResultSummary(agent, mode, authKindValue = 'n/a') {
  printBlockTitle('Result');
  printKv('agent', agent);
  printKv('mode', mode);
  printKv('auth_kind', authKindValue);
}

function describeFileState(file) {
  return fs.existsSync(file) ? `present: ${file}` : `missing: ${file}`;
}

function requireFile(file) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    fail(`missing file: ${file}`);
  }
}

function nearestExistingDir(targetPath) {
  let current = targetPath;
  if (fs.existsSync(current) && fs.statSync(current).isDirectory()) return current;
  current = path.dirname(current);
  while (current !== path.dirname(current) && !fs.existsSync(current)) {
    current = path.dirname(current);
  }
  return fs.existsSync(current) ? current : path.parse(targetPath).root;
}

function canWrite(targetPath) {
  try {
    fs.accessSync(targetPath, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function requireWritablePath(targetPath, label = 'path') {
  if (fs.existsSync(targetPath)) {
    if (!canWrite(targetPath)) {
      fail(`cannot write ${label}: ${targetPath} (check filesystem permissions or the current Codex sandbox)`);
    }
    return;
  }
  const existingDir = nearestExistingDir(targetPath);
  if (!canWrite(existingDir)) {
    fail(`cannot create ${label}: ${targetPath} (parent directory is not writable; check filesystem permissions or the current Codex sandbox)`);
  }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function tryChmod(file, mode) {
  try {
    fs.chmodSync(file, mode);
  } catch {}
}

function ensureRootLayout() {
  ensureDir(AGENT_AUTH_DIR);
  ensureDir(PROVIDERS_ROOT);
  ensureDir(STATE_DIR);
  ensureDir(MIGRATIONS_DIR);
}

function ensureAgentLayout(agent) {
  ensureRootLayout();
  ensureDir(providerDirFor(agent));
  ensureDir(path.join(AGENT_AUTH_DIR, agent, 'official'));
}

function validateAgent(agent) {
  if (!SUPPORTED_AGENTS.includes(agent)) {
    fail(`unsupported agent: ${agent}`);
  }
}

function listAgents() {
  printBlockTitle('Agents');
  process.stdout.write(`${SUPPORTED_AGENTS.join('\n')}\n`);
}

function validateProviderId(providerId) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(providerId)) {
    fail(`invalid provider_id: ${providerId}`);
  }
}

function providerDirFor(agent) {
  return path.join(PROVIDERS_ROOT, agent);
}

function providerFileFor(agent, providerId) {
  return path.join(providerDirFor(agent), `${providerId}.json`);
}

function stateFileFor(agent) {
  return path.join(STATE_DIR, `${agent}.json`);
}

function migrationMarkerFor(name) {
  return path.join(MIGRATIONS_DIR, `${name}.done`);
}

function officialBackupFor(agent) {
  if (agent === 'codex') return path.join(AGENT_AUTH_DIR, agent, 'official', 'auth.json');
  if (agent === 'claude') return path.join(AGENT_AUTH_DIR, agent, 'official', 'settings.json');
  return path.join(AGENT_AUTH_DIR, agent, 'official', '.env');
}

function runtimeTargetFor(agent) {
  if (agent === 'codex') return `${CODEX_CONFIG_FILE} + ${CODEX_AUTH_FILE}`;
  if (agent === 'claude') return CLAUDE_SETTINGS_FILE;
  return GEMINI_ENV_FILE;
}

function filesMatch(first, second) {
  if (!fs.existsSync(first) || !fs.existsSync(second)) return false;
  return fs.readFileSync(first).equals(fs.readFileSync(second));
}

function backupFile(file) {
  if (!fs.existsSync(file)) return;
  const backup = `${file}.bak`;
  if (fs.existsSync(backup)) return;
  fs.copyFileSync(file, backup);
  logNote('backup', `created: ${backup}`);
}

function copyIfDifferent(source, destination) {
  ensureDir(path.dirname(destination));
  if (filesMatch(source, destination)) return;
  fs.copyFileSync(source, destination);
  tryChmod(destination, 0o600);
  logNote('sync', `updated: ${destination}`);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`invalid json: ${file}${error && error.message ? ` (${error.message})` : ''}`);
  }
}

function authKind(file) {
  const data = readJson(file);
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const keys = Object.keys(data).sort();
    if (keys.length === 1 && keys[0] === 'OPENAI_API_KEY') return 'api_key';
    return 'official';
  }
  return 'unknown';
}

function providerValue(file, key) {
  const data = readJson(file);
  const value = data[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

function providerEnvEntries(file) {
  const data = readJson(file);
  const env = data.env && typeof data.env === 'object' && !Array.isArray(data.env) ? data.env : {};
  return Object.keys(env).sort().map((key) => `${key}=${env[key]}`);
}

function mergedEnvEntriesForUpdate(file, addEntries, unsetKeys) {
  const data = readJson(file);
  const env = data.env && typeof data.env === 'object' && !Array.isArray(data.env) ? { ...data.env } : {};
  for (const entry of addEntries) {
    const index = entry.indexOf('=');
    if (index <= 0) continue;
    env[entry.slice(0, index)] = entry.slice(index + 1);
  }
  for (const key of unsetKeys) {
    delete env[key];
  }
  return Object.keys(env).sort().map((key) => `${key}=${env[key]}`);
}

function writeJson(file, data) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

function writeStateFile(agent, mode, providerId = '') {
  ensureRootLayout();
  const file = stateFileFor(agent);
  requireWritablePath(file, 'state file');
  const payload = {
    schema_version: 1,
    agent,
    mode,
    updated_at: new Date().toISOString(),
  };
  if (providerId) payload.provider_id = providerId;
  writeJson(file, payload);
  tryChmod(file, 0o600);
  logNote('state', `updated: ${file}`);
}

function stateValue(agent, key) {
  const file = stateFileFor(agent);
  if (!fs.existsSync(file)) return undefined;
  const data = readJson(file);
  return data[key];
}

function migrateLegacyCodexStorageIfNeeded() {
  ensureAgentLayout('codex');
  const marker = migrationMarkerFor('codex_legacy_storage_v1');
  if (fs.existsSync(marker)) return;
  if (!fs.existsSync(LEGACY_CODEX_AUTH_DIR) || !fs.statSync(LEGACY_CODEX_AUTH_DIR).isDirectory()) return;

  const legacyOfficial = path.join(LEGACY_CODEX_AUTH_DIR, 'openai', 'auth.json');
  const newOfficial = officialBackupFor('codex');
  if (fs.existsSync(legacyOfficial) && !fs.existsSync(newOfficial)) {
    ensureDir(path.dirname(newOfficial));
    fs.copyFileSync(legacyOfficial, newOfficial);
    tryChmod(newOfficial, 0o600);
  }

  const legacyProvidersDir = path.join(LEGACY_CODEX_AUTH_DIR, 'providers');
  if (fs.existsSync(legacyProvidersDir)) {
    for (const entry of fs.readdirSync(legacyProvidersDir)) {
      if (!entry.endsWith('.json')) continue;
      const providerId = entry.replace(/\.json$/, '');
      const source = path.join(legacyProvidersDir, entry);
      const target = providerFileFor('codex', providerId);
      if (fs.existsSync(target)) continue;
      const payload = readJson(source);
      const out = {
        schema_version: 2,
        agent: 'codex',
        provider_id: providerId,
        name: payload.name || providerId,
        base_url: payload.base_url,
        api_key: payload.api_key,
        model: payload.model,
        wire_api: payload.wire_api || DEFAULT_WIRE_API,
        requires_openai_auth: Object.prototype.hasOwnProperty.call(payload, 'requires_openai_auth') ? payload.requires_openai_auth : true,
        env: payload.env && typeof payload.env === 'object' && !Array.isArray(payload.env) ? payload.env : {},
        updated_at: payload.updated_at || new Date().toISOString(),
      };
      for (const [key, value] of Object.entries(out)) {
        if (value === '' || value === null || value === undefined) delete out[key];
        if (key === 'env' && Object.keys(value || {}).length === 0) delete out[key];
      }
      writeJson(target, out);
      tryChmod(target, 0o600);
    }
  }

  fs.writeFileSync(marker, '');
  tryChmod(marker, 0o600);
}

function removeLegacyCodexProviderIfPresent(providerId) {
  const legacyProviderFile = path.join(LEGACY_CODEX_AUTH_DIR, 'providers', `${providerId}.json`);
  if (!fs.existsSync(legacyProviderFile)) return;
  fs.rmSync(legacyProviderFile, { force: true });
  logNote('legacy provider', `deleted: ${legacyProviderFile}`);
}

function writeProviderFile(agent, providerId, name, baseUrl, apiKey, model, envEntries) {
  const file = providerFileFor(agent, providerId);
  ensureAgentLayout(agent);
  requireWritablePath(file, 'provider file');

  const env = {};
  for (const entry of envEntries) {
    const index = entry.indexOf('=');
    if (index <= 0) continue;
    env[entry.slice(0, index)] = entry.slice(index + 1);
  }

  const payload = {
    schema_version: 2,
    agent,
    provider_id: providerId,
    name,
    updated_at: new Date().toISOString(),
  };
  if (baseUrl) payload.base_url = baseUrl;
  if (apiKey) payload.api_key = apiKey;
  if (model) payload.model = model;
  if (Object.keys(env).length > 0) payload.env = env;
  if (agent === 'codex') {
    payload.wire_api = DEFAULT_WIRE_API;
    payload.requires_openai_auth = true;
  }

  writeJson(file, payload);
  tryChmod(file, 0o600);
  logNote('provider', `saved: ${file}`);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readText(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

function writeText(file, text) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, text);
}

function upsertOrRemoveTopLevelString(filePath, key, value) {
  const lines = readText(filePath).split(/(?<=\n)/);
  const pattern = new RegExp(`^\\s*#?\\s*${escapeRegExp(key)}\\s*=`);
  const replacement = value ? `${key} = "${value}"\n` : null;
  const result = [];
  let replaced = false;

  for (const line of lines) {
    if (pattern.test(line)) {
      if (!replaced && replacement) result.push(replacement);
      replaced = true;
    } else if (line !== '') {
      result.push(line);
    }
  }

  if (replacement && !replaced) result.unshift(replacement);
  writeText(filePath, result.join(''));
  logNote('config', value ? `${key} = ${value}` : `${key} removed`);
}

function findSection(lines, header) {
  const start = lines.findIndex((line) => line.trim() === header);
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s*\[[^\]]+\]\s*$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return { start, end };
}

function setCodexModeSpecificConfig(mode) {
  let lines = readText(CODEX_CONFIG_FILE).split(/(?<=\n)/).filter((line, index, arr) => !(line === '' && index === arr.length - 1));

  function upsertTopLevel(key, newLine) {
    const pattern = new RegExp(`^\\s*#?\\s*${escapeRegExp(key)}\\s*=`);
    const result = [];
    let replaced = false;
    for (const line of lines) {
      if (pattern.test(line)) {
        if (!replaced) result.push(newLine);
        replaced = true;
      } else {
        result.push(line);
      }
    }
    if (!replaced) result.unshift(newLine);
    lines = result;
  }

  const webSearchLine = mode === 'provider' ? 'web_search = "live"\n' : '#web_search = "live"\n';
  const contextWindowLine = 'model_context_window = 256000\n';
  const compactLine = '#model_auto_compact_token_limit = 900000\n';
  const statusItems = [
    'model-with-reasoning',
    'fast-mode',
    'context-window-size',
    'context-used',
    'context-remaining',
    'used-tokens',
    'total-input-tokens',
    'total-output-tokens',
    'git-branch',
  ];
  if (mode === 'official') statusItems.push('five-hour-limit', 'weekly-limit');
  const statusLine = `status_line = [${statusItems.map((item) => `"${item}"`).join(', ')}]\n`;

  upsertTopLevel('web_search', webSearchLine);
  upsertTopLevel('model_context_window', contextWindowLine);
  upsertTopLevel('model_auto_compact_token_limit', compactLine);

  const tuiSection = findSection(lines, '[tui]');
  if (!tuiSection) {
    if (lines.length > 0 && lines[lines.length - 1] !== '\n') lines.push('\n');
    if (lines.length > 0 && lines[lines.length - 1] !== '\n' && !String(lines[lines.length - 1]).endsWith('\n')) lines[lines.length - 1] += '\n';
    lines.push('[tui]\n', statusLine);
  } else {
    const result = [];
    let replaced = false;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (i > tuiSection.start && i < tuiSection.end && /^\s*status_line\s*=/.test(line)) {
        if (!replaced) result.push(statusLine);
        replaced = true;
      } else {
        result.push(line);
      }
    }
    lines = result;
    if (!replaced) {
      let insertAt = lines.length;
      for (let i = tuiSection.start + 1; i < lines.length; i += 1) {
        if (/^\s*\[[^\]]+\]\s*$/.test(lines[i])) {
          insertAt = i;
          break;
        }
      }
      lines.splice(insertAt, 0, statusLine);
    }
  }

  writeText(CODEX_CONFIG_FILE, lines.join(''));
  logNote('config', `mode settings applied: ${mode}`);
}

function setCodexActiveProvider(providerId, mode) {
  const lines = readText(CODEX_CONFIG_FILE).split(/(?<=\n)/);
  const pattern = /^\s*#?\s*model_provider\s*=/;
  const replacement = mode === 'official' ? null : `model_provider = "${providerId}"\n`;
  const result = [];
  let replaced = false;

  for (const line of lines) {
    if (pattern.test(line)) {
      if (!replaced && replacement) result.push(replacement);
      replaced = true;
    } else if (line !== '') {
      result.push(line);
    }
  }
  if (replacement && !replaced) result.unshift(replacement);
  writeText(CODEX_CONFIG_FILE, result.join(''));
  logNote('config', mode === 'official' ? 'model_provider disabled' : `model_provider = ${providerId}`);
}

function upsertCodexProviderSection(providerId, name, baseUrl, wireApi, requiresOpenaiAuth) {
  let lines = readText(CODEX_CONFIG_FILE).split(/(?<=\n)/).filter((line, index, arr) => !(line === '' && index === arr.length - 1));
  const header = `[model_providers.${providerId}]`;
  const section = [
    `${header}\n`,
    `name = "${name}"\n`,
    `base_url = "${baseUrl}"\n`,
    `wire_api = "${wireApi}"\n`,
    `requires_openai_auth = ${requiresOpenaiAuth}\n`,
  ];
  const match = findSection(lines, header);
  if (!match) {
    if (lines.length > 0 && !String(lines[lines.length - 1]).endsWith('\n')) lines[lines.length - 1] += '\n';
    if (lines.length > 0) lines.push('\n');
    lines = lines.concat(section);
  } else {
    lines = [...lines.slice(0, match.start), ...section, ...lines.slice(match.end)];
  }
  writeText(CODEX_CONFIG_FILE, lines.join(''));
  logNote('config', `provider section refreshed: [model_providers.${providerId}]`);
}

function removeCodexProviderSection(providerId) {
  if (!fs.existsSync(CODEX_CONFIG_FILE)) return;
  let lines = readText(CODEX_CONFIG_FILE).split(/(?<=\n)/);
  const header = `[model_providers.${providerId}]`;
  const match = findSection(lines, header);
  if (!match) return;
  lines = [...lines.slice(0, match.start), ...lines.slice(match.end)];
  writeText(CODEX_CONFIG_FILE, lines.join(''));
  logNote('config', `provider section removed: [model_providers.${providerId}]`);
}

function codexConfigMode() {
  const text = readText(CODEX_CONFIG_FILE);
  const match = text.match(/^[\t ]*model_provider[\t ]*=[\t ]*"([^"]+)"/m);
  return match ? match[1] : 'official';
}

function writeCodexAuthFile(apiKey) {
  writeJson(CODEX_AUTH_FILE, { OPENAI_API_KEY: apiKey });
  tryChmod(CODEX_AUTH_FILE, 0o600);
  logNote('auth', `rendered: ${CODEX_AUTH_FILE}`);
}

function backupCodexOfficialIfPresent() {
  ensureAgentLayout('codex');
  if (fs.existsSync(CODEX_AUTH_FILE) && authKind(CODEX_AUTH_FILE) === 'official') {
    copyIfDifferent(CODEX_AUTH_FILE, officialBackupFor('codex'));
  }
}

function restoreCodexOfficialOrClear() {
  const backup = officialBackupFor('codex');
  if (fs.existsSync(backup)) {
    fs.copyFileSync(backup, CODEX_AUTH_FILE);
    tryChmod(CODEX_AUTH_FILE, 0o600);
    logNote('official auth', `restored: ${backup}`);
  } else if (fs.existsSync(CODEX_AUTH_FILE) && authKind(CODEX_AUTH_FILE) === 'api_key') {
    fs.rmSync(CODEX_AUTH_FILE, { force: true });
    logNote('official auth', `removed managed auth: ${CODEX_AUTH_FILE}`);
  } else {
    logNote('official auth', 'restore skipped: backup missing');
  }
}

function syncCodexProvider(providerId) {
  const providerFile = providerFileFor('codex', providerId);
  requireFile(providerFile);

  ensureDir(CODEX_DIR);
  requireWritablePath(CODEX_CONFIG_FILE, 'codex config');
  requireWritablePath(CODEX_AUTH_FILE, 'codex auth');
  if (!fs.existsSync(`${CODEX_CONFIG_FILE}.bak`)) requireWritablePath(`${CODEX_CONFIG_FILE}.bak`, 'codex config backup');
  if (!fs.existsSync(officialBackupFor('codex'))) requireWritablePath(officialBackupFor('codex'), 'codex official backup');
  requireFile(CODEX_CONFIG_FILE);
  backupFile(CODEX_CONFIG_FILE);
  backupCodexOfficialIfPresent();

  const name = providerValue(providerFile, 'name');
  const baseUrl = providerValue(providerFile, 'base_url');
  const apiKey = providerValue(providerFile, 'api_key');
  const wireApi = providerValue(providerFile, 'wire_api') || DEFAULT_WIRE_API;
  const requiresOpenaiAuth = providerValue(providerFile, 'requires_openai_auth') || 'true';
  const model = providerValue(providerFile, 'model') || '';

  if (requiresOpenaiAuth !== 'true') {
    fail(`provider auth mode is not supported yet: codex/${providerId}`);
  }

  writeCodexAuthFile(apiKey);
  setCodexActiveProvider(providerId, 'provider');
  upsertCodexProviderSection(providerId, name, baseUrl, wireApi, requiresOpenaiAuth);
  upsertOrRemoveTopLevelString(CODEX_CONFIG_FILE, 'model', model);
  setCodexModeSpecificConfig('provider');
  writeStateFile('codex', providerId, providerId);
}

function switchCodexToOfficial() {
  ensureDir(CODEX_DIR);
  requireWritablePath(CODEX_CONFIG_FILE, 'codex config');
  requireWritablePath(CODEX_AUTH_FILE, 'codex auth');
  if (!fs.existsSync(`${CODEX_CONFIG_FILE}.bak`)) requireWritablePath(`${CODEX_CONFIG_FILE}.bak`, 'codex config backup');
  if (!fs.existsSync(officialBackupFor('codex'))) requireWritablePath(officialBackupFor('codex'), 'codex official backup');
  requireFile(CODEX_CONFIG_FILE);
  backupFile(CODEX_CONFIG_FILE);
  backupCodexOfficialIfPresent();
  restoreCodexOfficialOrClear();
  setCodexActiveProvider('', 'official');
  upsertOrRemoveTopLevelString(CODEX_CONFIG_FILE, 'model', '');
  setCodexModeSpecificConfig('official');
  writeStateFile('codex', 'official', '');
}

function syncClaudeProvider(providerId) {
  const providerFile = providerFileFor('claude', providerId);
  requireFile(providerFile);

  ensureDir(CLAUDE_DIR);
  requireWritablePath(CLAUDE_SETTINGS_FILE, 'claude settings');
  if (!fs.existsSync(officialBackupFor('claude'))) requireWritablePath(officialBackupFor('claude'), 'claude official backup');

  const backup = officialBackupFor('claude');
  if (fs.existsSync(CLAUDE_SETTINGS_FILE) && !fs.existsSync(backup)) {
    ensureDir(path.dirname(backup));
    fs.copyFileSync(CLAUDE_SETTINGS_FILE, backup);
    tryChmod(backup, 0o600);
    logNote('backup', `created: ${backup}`);
  }

  const provider = readJson(providerFile);
  let settings = {};
  if (fs.existsSync(CLAUDE_SETTINGS_FILE) && fs.statSync(CLAUDE_SETTINGS_FILE).size > 0) {
    settings = readJson(CLAUDE_SETTINGS_FILE);
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) settings = {};

  const env = settings.env && typeof settings.env === 'object' && !Array.isArray(settings.env) ? settings.env : {};
  for (const key of Object.keys(env)) {
    if (/^(ANTHROPIC_|CLAUDE_CODE_)/.test(key)) delete env[key];
  }

  const managed = {};
  if (provider.base_url) managed.ANTHROPIC_BASE_URL = String(provider.base_url);
  if (provider.api_key) managed.ANTHROPIC_AUTH_TOKEN = String(provider.api_key);
  managed.CLAUDE_CODE_ATTRIBUTION_HEADER = '0';
  managed.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  managed.CLAUDE_CODE_DISABLE_TERMINAL_TITLE = '1';

  const extraEnv = provider.env && typeof provider.env === 'object' && !Array.isArray(provider.env) ? provider.env : {};
  for (const [key, value] of Object.entries(extraEnv)) managed[key] = String(value);

  settings.env = { ...env, ...managed };
  writeJson(CLAUDE_SETTINGS_FILE, settings);
  tryChmod(CLAUDE_SETTINGS_FILE, 0o600);
  logNote('settings', `rendered: ${CLAUDE_SETTINGS_FILE}`);
  writeStateFile('claude', providerId, providerId);
}

function switchClaudeToOfficial() {
  ensureDir(CLAUDE_DIR);
  requireWritablePath(CLAUDE_SETTINGS_FILE, 'claude settings');
  if (!fs.existsSync(officialBackupFor('claude'))) requireWritablePath(officialBackupFor('claude'), 'claude official backup');

  const backup = officialBackupFor('claude');
  if (fs.existsSync(backup)) {
    fs.copyFileSync(backup, CLAUDE_SETTINGS_FILE);
    tryChmod(CLAUDE_SETTINGS_FILE, 0o600);
    logNote('official', `restored: ${backup}`);
  } else {
    let settings = {};
    if (fs.existsSync(CLAUDE_SETTINGS_FILE) && fs.statSync(CLAUDE_SETTINGS_FILE).size > 0) {
      settings = readJson(CLAUDE_SETTINGS_FILE);
    }
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) settings = {};
    const env = settings.env && typeof settings.env === 'object' && !Array.isArray(settings.env) ? settings.env : {};
    for (const key of Object.keys(env)) {
      if (/^(ANTHROPIC_|CLAUDE_CODE_)/.test(key)) delete env[key];
    }
    if (Object.keys(env).length === 0) delete settings.env;
    else settings.env = env;
    writeJson(CLAUDE_SETTINGS_FILE, settings);
    tryChmod(CLAUDE_SETTINGS_FILE, 0o600);
    logNote('official', `cleared managed env: ${CLAUDE_SETTINGS_FILE}`);
  }
  writeStateFile('claude', 'official', '');
}

function parseDotEnv(file) {
  const env = {};
  if (!fs.existsSync(file)) return env;
  for (const rawLine of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const text = rawLine.trim();
    if (!text || text.startsWith('#')) continue;
    const index = text.indexOf('=');
    if (index <= 0) continue;
    env[text.slice(0, index)] = text.slice(index + 1);
  }
  return env;
}

function writeDotEnv(file, env) {
  const body = Object.keys(env).sort().map((key) => `${key}=${env[key]}`).join('\n');
  writeText(file, body ? `${body}\n` : '');
}

function syncGeminiProvider(providerId) {
  const providerFile = providerFileFor('gemini', providerId);
  requireFile(providerFile);

  ensureDir(GEMINI_DIR);
  requireWritablePath(GEMINI_ENV_FILE, 'gemini env file');
  if (!fs.existsSync(officialBackupFor('gemini'))) requireWritablePath(officialBackupFor('gemini'), 'gemini official backup');

  const backup = officialBackupFor('gemini');
  if (fs.existsSync(GEMINI_ENV_FILE) && !fs.existsSync(backup)) {
    ensureDir(path.dirname(backup));
    fs.copyFileSync(GEMINI_ENV_FILE, backup);
    tryChmod(backup, 0o600);
    logNote('backup', `created: ${backup}`);
  }

  const provider = readJson(providerFile);
  const env = parseDotEnv(GEMINI_ENV_FILE);
  for (const key of Object.keys(env)) {
    if (/^(?:GOOGLE_GEMINI_|GEMINI_)/.test(key)) delete env[key];
  }

  if (provider.base_url) env.GOOGLE_GEMINI_BASE_URL = String(provider.base_url);
  if (provider.api_key) env.GEMINI_API_KEY = String(provider.api_key);
  const extraEnv = provider.env && typeof provider.env === 'object' && !Array.isArray(provider.env) ? provider.env : {};
  for (const [key, value] of Object.entries(extraEnv)) env[key] = String(value);

  writeDotEnv(GEMINI_ENV_FILE, env);
  tryChmod(GEMINI_ENV_FILE, 0o600);
  logNote('env', `rendered: ${GEMINI_ENV_FILE}`);
  writeStateFile('gemini', providerId, providerId);
}

function switchGeminiToOfficial() {
  ensureDir(GEMINI_DIR);
  requireWritablePath(GEMINI_ENV_FILE, 'gemini env file');
  if (!fs.existsSync(officialBackupFor('gemini'))) requireWritablePath(officialBackupFor('gemini'), 'gemini official backup');

  const backup = officialBackupFor('gemini');
  if (fs.existsSync(backup)) {
    fs.copyFileSync(backup, GEMINI_ENV_FILE);
    tryChmod(GEMINI_ENV_FILE, 0o600);
    logNote('official', `restored: ${backup}`);
  } else {
    const env = parseDotEnv(GEMINI_ENV_FILE);
    for (const key of Object.keys(env)) {
      if (/^(?:GOOGLE_GEMINI_|GEMINI_)/.test(key)) delete env[key];
    }
    if (Object.keys(env).length === 0) {
      if (fs.existsSync(GEMINI_ENV_FILE)) fs.rmSync(GEMINI_ENV_FILE, { force: true });
    } else {
      writeDotEnv(GEMINI_ENV_FILE, env);
    }
    logNote('official', `cleared managed env: ${GEMINI_ENV_FILE}`);
  }
  writeStateFile('gemini', 'official', '');
}

function activateProvider(agent, providerId, title = 'Activate provider') {
  ensureAgentLayout(agent);
  const providerFile = providerFileFor(agent, providerId);
  requireFile(providerFile);

  const name = providerValue(providerFile, 'name');
  const baseUrl = providerValue(providerFile, 'base_url') || '';
  const model = providerValue(providerFile, 'model') || '';

  if (agent === 'codex') {
    syncCodexProvider(providerId);
    printProviderHeader(title, agent, providerId, name, baseUrl, model);
    printChangeLogs();
    printResultSummary(agent, codexConfigMode(), authKind(CODEX_AUTH_FILE));
    return;
  }
  if (agent === 'claude') {
    syncClaudeProvider(providerId);
    printProviderHeader(title, agent, providerId, name, baseUrl, model);
    printChangeLogs();
    printResultSummary(agent, providerId, 'settings_json_env');
    return;
  }
  syncGeminiProvider(providerId);
  printProviderHeader(title, agent, providerId, name, baseUrl, model);
  printChangeLogs();
  printResultSummary(agent, providerId, 'env_file');
}

function switchToOfficial(agent) {
  resetChangeLogs();
  ensureAgentLayout(agent);

  if (agent === 'codex') {
    switchCodexToOfficial();
    printBlockTitle(`Switch to official auth: ${agent}`);
    printChangeLogs();
    const authMode = fs.existsSync(CODEX_AUTH_FILE) ? authKind(CODEX_AUTH_FILE) : 'missing';
    printResultSummary(agent, codexConfigMode(), authMode);
    return;
  }
  if (agent === 'claude') {
    switchClaudeToOfficial();
    printBlockTitle(`Switch to official auth: ${agent}`);
    printChangeLogs();
    printResultSummary(agent, 'official', 'settings_json');
    return;
  }
  switchGeminiToOfficial();
  printBlockTitle(`Switch to official auth: ${agent}`);
  printChangeLogs();
  printResultSummary(agent, 'official', 'env_file');
}

function parseProviderOptions(commandName, args, current = null) {
  const options = {
    name: current?.name || '',
    baseUrl: current?.baseUrl || '',
    apiKey: current?.apiKey || '',
    model: current?.model || '',
    addEnvEntries: [],
    unsetEnvKeys: [],
  };

  let index = 0;
  while (index < args.length) {
    const arg = args[index];
    const next = args[index + 1];
    if (arg === '--name') {
      if (!next) fail('missing value for --name');
      options.name = next;
      index += 2;
      continue;
    }
    if (arg === '--url' || arg === '--base-url') {
      if (!next) fail('missing value for --url');
      options.baseUrl = next;
      index += 2;
      continue;
    }
    if (arg === '--key' || arg === '--api-key') {
      if (!next) fail('missing value for --key');
      options.apiKey = next;
      index += 2;
      continue;
    }
    if (arg === '--model') {
      if (!next) fail('missing value for --model');
      options.model = next;
      index += 2;
      continue;
    }
    if (arg === '--env') {
      if (!next) fail('missing value for --env');
      if (!next.includes('=')) fail('--env expects KEY=VALUE');
      const envKey = next.split('=', 1)[0];
      if (!envKey) fail('--env expects non-empty KEY');
      options.addEnvEntries.push(next);
      index += 2;
      continue;
    }
    if (arg === '--unset-env') {
      if (commandName !== 'update') fail('--unset-env is only supported by update');
      if (!next) fail('missing value for --unset-env');
      options.unsetEnvKeys.push(next);
      index += 2;
      continue;
    }
    fail(`unknown option for ${commandName}: ${arg}`);
  }

  return options;
}

function addProvider(agent, providerId, args) {
  validateProviderId(providerId);
  const options = parseProviderOptions('add', args);
  const name = options.name || providerId;
  if (!options.baseUrl) fail('--url is required');
  if (!options.apiKey) fail('--key is required');

  resetChangeLogs();
  writeProviderFile(agent, providerId, name, options.baseUrl, options.apiKey, options.model, options.addEnvEntries);
  activateProvider(agent, providerId, 'Add provider');
}

function updateProvider(agent, providerId, args) {
  validateProviderId(providerId);
  const providerFile = providerFileFor(agent, providerId);
  requireFile(providerFile);

  const current = {
    name: providerValue(providerFile, 'name') || providerId,
    baseUrl: providerValue(providerFile, 'base_url') || '',
    apiKey: providerValue(providerFile, 'api_key') || '',
    model: providerValue(providerFile, 'model') || '',
  };
  const currentEnvEntries = providerEnvEntries(providerFile);
  const options = parseProviderOptions('update', args, current);
  const envEntries = mergedEnvEntriesForUpdate(providerFile, options.addEnvEntries, options.unsetEnvKeys);

  const unchanged =
    options.name === current.name &&
    options.baseUrl === current.baseUrl &&
    options.apiKey === current.apiKey &&
    options.model === current.model &&
    currentEnvEntries.join('\n') === envEntries.join('\n');

  if (unchanged) fail(`no provider fields changed for ${agent}/${providerId}`);

  resetChangeLogs();
  writeProviderFile(agent, providerId, options.name, options.baseUrl, options.apiKey, options.model, envEntries);

  if (stateValue(agent, 'provider_id') === providerId) {
    activateProvider(agent, providerId, 'Update provider');
    return;
  }

  printProviderHeader('Update provider', agent, providerId, options.name, options.baseUrl, options.model);
  printChangeLogs();
  printBlockTitle('Result');
  printKv('agent', agent);
  printKv('active', 'no');
  printKv('stored', 'yes');
}

function deleteProvider(agent, providerId) {
  validateProviderId(providerId);
  const providerFile = providerFileFor(agent, providerId);
  requireFile(providerFile);

  const activeProvider = stateValue(agent, 'provider_id') || '';
  resetChangeLogs();

  if (activeProvider === providerId) {
    if (agent === 'codex') switchCodexToOfficial();
    else if (agent === 'claude') switchClaudeToOfficial();
    else switchGeminiToOfficial();
    resetChangeLogs();
  }

  fs.rmSync(providerFile, { force: true });
  logNote('provider', `deleted: ${providerFile}`);

  if (agent === 'codex') {
    removeLegacyCodexProviderIfPresent(providerId);
    requireWritablePath(CODEX_CONFIG_FILE, 'codex config');
    removeCodexProviderSection(providerId);
  }

  printBlockTitle(`Delete provider: ${agent}/${providerId}`);
  printChangeLogs();
  printBlockTitle('Result');
  printKv('agent', agent);
  printKv('provider_id', providerId);
  printKv('deleted', 'yes');
  printKv('was_active', activeProvider === providerId ? 'yes' : 'no');
  printKv('state_mode', stateValue(agent, 'mode') || 'unknown');
}

function listProviders(agent) {
  ensureAgentLayout(agent);
  const dir = providerDirFor(agent);
  const files = fs.readdirSync(dir).filter((entry) => entry.endsWith('.json')).sort().map((entry) => path.join(dir, entry));
  if (files.length === 0) {
    printBlockTitle(`Providers: ${agent}`);
    process.stdout.write('(none)\n');
    return;
  }

  const headers = ['PROVIDER_ID', 'NAME', 'BASE_URL', 'MODEL', 'ENV_KEYS', 'UPDATED_AT'];
  const rows = files.map((file) => {
    const data = readJson(file);
    let envKeys = '-';
    if (data.env && typeof data.env === 'object' && !Array.isArray(data.env)) {
      const keys = Object.keys(data.env).sort().join(',');
      if (keys) envKeys = keys;
    }
    return [
      data.provider_id || '-',
      data.name || '-',
      data.base_url || '-',
      data.model || '-',
      envKeys,
      data.updated_at || '-',
    ];
  });
  const widths = headers.map((header, index) => Math.max(header.length, ...rows.map((row) => String(row[index]).length)));
  const format = (row) => row.map((cell, index) => String(cell).padEnd(widths[index])).join('  ');

  printBlockTitle(`Providers: ${agent}`);
  process.stdout.write(`${format(headers)}\n`);
  process.stdout.write(`${widths.map((width) => '-'.repeat(width)).join('  ')}\n`);
  for (const row of rows) process.stdout.write(`${format(row)}\n`);
}

function printStatus(agent) {
  ensureAgentLayout(agent);
  const mode = stateValue(agent, 'mode') || 'unknown';
  const activeProvider = stateValue(agent, 'provider_id') || '-';
  const providersCount = fs.readdirSync(providerDirFor(agent)).filter((entry) => entry.endsWith('.json')).length;

  printBlockTitle('Status');
  printKv('agent', agent);
  printKv('state_mode', mode);
  printKv('state_file', describeFileState(stateFileFor(agent)));
  printKv('active_provider', activeProvider);
  printKv('runtime_target', runtimeTargetFor(agent));
  printKv('official_backup', describeFileState(officialBackupFor(agent)));
  printKv('providers_dir', providerDirFor(agent));
  printKv('providers', String(providersCount));

  if (agent === 'codex') {
    requireFile(CODEX_CONFIG_FILE);
    const currentAuthKind = fs.existsSync(CODEX_AUTH_FILE) ? authKind(CODEX_AUTH_FILE) : 'missing';
    printKv('config_mode', codexConfigMode());
    printKv('config_file', CODEX_CONFIG_FILE);
    printKv('auth_file', describeFileState(CODEX_AUTH_FILE));
    printKv('auth_kind', currentAuthKind);
  } else if (agent === 'claude') {
    printKv('settings_file', describeFileState(CLAUDE_SETTINGS_FILE));
  } else {
    printKv('env_file', describeFileState(GEMINI_ENV_FILE));
  }
}

async function main(argv) {
  const action = argv[0] || '';
  if (action === 'help' || action === '-h' || action === '--help' || action === '') {
    if (argv.length > 1) fail('unexpected arguments for help');
    usage();
    return;
  }
  if (action === 'agents') {
    if (argv.length !== 1) fail('unexpected arguments for agents');
    listAgents();
    return;
  }

  const agent = action;
  validateAgent(agent);
  if (agent === 'codex') migrateLegacyCodexStorageIfNeeded();

  const subcommand = argv[1] || 'help';
  const rest = argv.slice(2);

  if (subcommand === 'help' || subcommand === '-h' || subcommand === '--help') {
    if (rest.length !== 0) fail(`unexpected arguments for ${agent} help`);
    usageForAgent(agent);
    return;
  }
  if (subcommand === 'list') {
    if (rest.length !== 0) fail(`unexpected arguments for ${agent} list`);
    listProviders(agent);
    return;
  }
  if (subcommand === 'status') {
    if (rest.length !== 0) fail(`unexpected arguments for ${agent} status`);
    printStatus(agent);
    return;
  }
  if (subcommand === 'sessions' || subcommand === 'session') {
    if (agent !== 'codex') fail(`unknown command for ${agent}: ${subcommand}`);
    const { runCodexSessionsList } = await import('./codex_sessions_list.mjs');
    const code = await runCodexSessionsList(rest, {
      stdout: process.stdout,
      stderr: process.stderr,
      terminalWidth: process.stdout.columns,
    });
    if (code !== 0) process.exit(code);
    return;
  }
  if (subcommand === 'official') {
    if (rest.length !== 0) fail(`unexpected arguments for ${agent} official`);
    switchToOfficial(agent);
    return;
  }
  if (subcommand === 'use') {
    if (rest.length < 1) fail(`provider_id is required for ${agent} use`);
    if (rest.length > 1) fail(`unexpected arguments for ${agent} use`);
    resetChangeLogs();
    activateProvider(agent, rest[0]);
    return;
  }
  if (subcommand === 'add') {
    if (rest.length < 1) fail(`provider_id is required for ${agent} add`);
    addProvider(agent, rest[0], rest.slice(1));
    return;
  }
  if (subcommand === 'update') {
    if (rest.length < 1) fail(`provider_id is required for ${agent} update`);
    updateProvider(agent, rest[0], rest.slice(1));
    return;
  }
  if (subcommand === 'delete' || subcommand === 'remove' || subcommand === 'rm') {
    if (rest.length < 1) fail(`provider_id is required for ${agent} delete`);
    if (rest.length > 1) fail(`unexpected arguments for ${agent} delete`);
    deleteProvider(agent, rest[0]);
    return;
  }

  fail(`unknown command for ${agent}: ${subcommand}`);
}

main(process.argv.slice(2)).catch((err) => fail(err?.message ?? String(err)));
