#!/usr/bin/env node
/**
 * List Codex local sessions from ~/.codex/sessions by scanning rollout-*.jsonl.
 *
 * Usage:
 *   node scripts/codex_sessions_list.mjs            # full scan
 *   node scripts/codex_sessions_list.mjs 2025       # year
 *   node scripts/codex_sessions_list.mjs 202504     # year+month
 *   node scripts/codex_sessions_list.mjs 20250401   # year+month+day
 *
 * Output (default): human-friendly table.
 * Output (tsv): timestamp, session_id, cwd, brief, rollout_path
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { pathToFileURL } from "node:url";

const BRIEF_MAX_CHARS = 120;
const BRIEF_MAX_CHARS_FULL = 260;

const DEFAULT_LIMIT = 200;

export function buildUsageText() {
  return (
    [
      "Usage:",
      "  agent-auth codex sessions [YYYY|YYYYMM|YYYYMMDD] [--table|--tsv|--json] [--full] [--short-id] [--limit N]",
      "  codex_sessions_list.mjs [YYYY|YYYYMM|YYYYMMDD] [--table|--tsv|--json] [--full] [--short-id] [--limit N]",
      "",
      "Examples:",
      "  agent-auth codex sessions",
      "  agent-auth codex sessions 2026",
      "  agent-auth codex sessions 202604 --tsv | fzf",
      "  agent-auth codex sessions --json | jq '.[0]'",
      "",
      "Notes:",
      "  - Reads local rollout logs under $CODEX_DIR/sessions (default: ~/.codex/sessions).",
      "  - Brief is derived from the first meaningful user prompt in the rollout.",
    ].join("\n") + "\n"
  );
}

export function printUsage(message, { stream = process.stderr } = {}) {
  if (message) stream.write(`${message}\n\n`);
  stream.write(buildUsageText());
}

function usageAndExit(message) {
  printUsage(message);
  process.exit(message ? 1 : 0);
}

function normalizeDateArg(dateArg) {
  if (!dateArg) return null;
  const raw = String(dateArg).trim();
  if (!raw) return null;

  // Allow 2025-04-01 or 2025/04/01 as convenience.
  const digits = raw.replaceAll(/[^0-9]/g, "");
  if (![4, 6, 8].includes(digits.length)) return null;
  return digits;
}

function existsDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function splitYmd(digits) {
  const year = digits.slice(0, 4);
  const month = digits.length >= 6 ? digits.slice(4, 6) : null;
  const day = digits.length >= 8 ? digits.slice(6, 8) : null;
  return { year, month, day };
}

function computeSearchRoot(baseRoot, digits) {
  if (!digits) return baseRoot;
  const { year, month, day } = splitYmd(digits);
  if (day) return path.join(baseRoot, year, month, day);
  if (month) return path.join(baseRoot, year, month);
  return path.join(baseRoot, year);
}

function resolveSessionsBaseRoot() {
  const codexDir = process.env.CODEX_DIR
    ? path.resolve(process.env.CODEX_DIR)
    : path.join(os.homedir(), ".codex");

  const sessionsRoot = path.join(codexDir, "sessions");
  const sessionRootFallback = path.join(codexDir, "session");

  if (existsDir(sessionsRoot)) return sessionsRoot;
  if (existsDir(sessionRootFallback)) return sessionRootFallback;
  return null;
}

function walkRolloutFiles(rootDir) {
  const files = [];
  const stack = [rootDir];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (
        ent.isFile() &&
        ent.name.startsWith("rollout-") &&
        ent.name.endsWith(".jsonl")
      ) {
        files.push(full);
      }
    }
  }
  return files;
}

function extractUserBrief(text, maxChars = BRIEF_MAX_CHARS) {
  const normalized = String(text).replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  if (normalized.length <= maxChars) return normalized;
  return normalized.slice(0, maxChars - 1) + "…";
}

function isLikelyHarnessPrelude(text) {
  const t = String(text);
  if (!t) return false;
  return (
    t.startsWith("# AGENTS.md instructions") ||
    t.includes("<INSTRUCTIONS>") ||
    t.includes("<environment_context>") ||
    t.includes("Files mentioned by the user:")
  );
}

async function extractSessionInfo(rolloutPath) {
  const stream = fs.createReadStream(rolloutPath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let sessionId = null;
  let timestamp = null;
  let cwd = null;
  let brief = null;
  let fallbackBrief = null;

  try {
    for await (const line of rl) {
      if (!line) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }

      if (!sessionId && obj.type === "session_meta") {
        sessionId = obj.payload?.id ?? null;
        timestamp = obj.payload?.timestamp ?? obj.timestamp ?? null;
        cwd = obj.payload?.cwd ?? null;
        continue;
      }

      if (
        !brief &&
        obj.type === "response_item" &&
        obj.payload?.type === "message" &&
        obj.payload?.role === "user"
      ) {
        const content = Array.isArray(obj.payload?.content) ? obj.payload.content : [];
        const firstText = content.find(
          (c) => c?.type === "input_text" && typeof c?.text === "string",
        )?.text;
        if (firstText) {
          const candidate = extractUserBrief(firstText);
          if (candidate && !fallbackBrief) fallbackBrief = candidate;
          if (candidate && !isLikelyHarnessPrelude(firstText)) brief = candidate;
        }
      }

      if (sessionId && brief) break;
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  if (!sessionId) return null;

  return {
    sessionId,
    timestamp,
    cwd,
    brief: brief ?? fallbackBrief ?? "",
    rolloutPath,
  };
}

function toIsoOrEmpty(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts);
  return d.toISOString();
}

function formatLocalDateTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts);
  const y = String(d.getFullYear()).padStart(4, "0");
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${day} ${hh}:${mm}`;
}

function replaceHome(p) {
  if (!p) return "";
  const home = os.homedir();
  if (p === home) return "~";
  if (p.startsWith(home + path.sep)) return "~" + p.slice(home.length);
  return p;
}

function shortenPath(p, maxLen) {
  const s = replaceHome(p);
  if (!s) return "";
  if (!maxLen || s.length <= maxLen) return s;
  const keepTail = Math.max(12, Math.floor(maxLen * 0.6));
  const tail = s.slice(-keepTail);
  const head = s.slice(0, Math.max(0, maxLen - keepTail - 1));
  return `${head}…${tail}`;
}

function shortSessionId(id) {
  const s = String(id ?? "");
  if (s.length <= 14) return s;
  return `${s.slice(0, 8)}…${s.slice(-4)}`;
}

// Minimal display-width helpers (avoid accidental wraps / "blank lines" in CJK terminals).
// This is intentionally lightweight and conservative; it doesn't need to be perfect wcwidth.
function isCombiningMark(cp) {
  return (
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe20 && cp <= 0xfe2f)
  );
}

function isWide(cp) {
  // Rough East Asian wide ranges (covers most CJK/Hangul/fullwidth forms + emoji blocks).
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2329 && cp <= 0x232a) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff)
  );
}

function displayWidth(s) {
  const str = String(s ?? "");
  let w = 0;
  for (const ch of str) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    if (ch === "\n" || ch === "\r" || ch === "\t") continue;
    if (isCombiningMark(cp)) continue;
    w += isWide(cp) ? 2 : 1;
  }
  return w;
}

function truncateToWidth(s, maxWidth) {
  const str = String(s ?? "");
  if (!Number.isFinite(maxWidth) || maxWidth <= 0) return "";
  if (displayWidth(str) <= maxWidth) return str;
  const ellipsis = "…";
  const target = Math.max(1, maxWidth - displayWidth(ellipsis));

  let w = 0;
  let out = "";
  for (const ch of str) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    if (ch === "\n" || ch === "\r" || ch === "\t") continue;
    if (isCombiningMark(cp)) {
      out += ch;
      continue;
    }
    const inc = isWide(cp) ? 2 : 1;
    if (w + inc > target) break;
    out += ch;
    w += inc;
  }
  return out + ellipsis;
}

function padRight(s, width) {
  const str = String(s ?? "");
  const trimmed = truncateToWidth(str, width);
  const w = displayWidth(trimmed);
  if (w >= width) return trimmed;
  return trimmed + " ".repeat(width - w);
}

function clampText(s, maxLen) {
  const str = String(s ?? "").replace(/\s+/g, " ").trim();
  if (!maxLen || str.length <= maxLen) return str;
  if (maxLen <= 1) return "…";
  return str.slice(0, maxLen - 1) + "…";
}

export async function runCodexSessionsList(args, io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;

  let dateArg = null;
  let format = "table"; // table | tsv | json
  let full = false;
  let shortId = false;
  let limit = DEFAULT_LIMIT;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--help" || a === "-h") {
      printUsage(null, { stream: stdout });
      return 0;
    }
    if (a === "--json") {
      format = "json";
      continue;
    }
    if (a === "--tsv") {
      format = "tsv";
      continue;
    }
    if (a === "--table") {
      format = "table";
      continue;
    }
    if (a === "--full") {
      full = true;
      continue;
    }
    if (a === "--short-id") {
      shortId = true;
      continue;
    }
    if (a === "--limit") {
      const n = args[i + 1];
      if (!n) {
        printUsage("Missing value for --limit", { stream: stderr });
        return 1;
      }
      const parsed = Number.parseInt(n, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        printUsage(`Invalid --limit: ${n}`, { stream: stderr });
        return 1;
      }
      limit = parsed;
      i++;
      continue;
    }
    if (!dateArg) dateArg = a;
    else {
      printUsage(`Unexpected extra arg: ${a}`, { stream: stderr });
      return 1;
    }
  }

  const digits = normalizeDateArg(dateArg);
  if (dateArg && !digits) {
    printUsage(`Invalid date filter: ${dateArg} (expected YYYY / YYYYMM / YYYYMMDD)`, {
      stream: stderr,
    });
    return 1;
  }

  const baseRoot = resolveSessionsBaseRoot();
  if (!baseRoot) {
    const codexDir = process.env.CODEX_DIR
      ? path.resolve(process.env.CODEX_DIR)
      : path.join(os.homedir(), ".codex");
    printUsage(`Missing sessions directory: ${path.join(codexDir, "sessions")}`, { stream: stderr });
    return 1;
  }

  const searchRoot = computeSearchRoot(baseRoot, digits);
  if (!existsDir(searchRoot)) {
    printUsage(`No such directory for filter '${digits ?? "full"}': ${searchRoot}`, { stream: stderr });
    return 1;
  }

  const rolloutFiles = walkRolloutFiles(searchRoot);
  const byId = new Map();

  for (const f of rolloutFiles) {
    // Sequential scan keeps memory stable; jsonl files can be large.
    const info = await extractSessionInfo(f);
    if (!info) continue;
    const existing = byId.get(info.sessionId);
    if (!existing) {
      byId.set(info.sessionId, info);
      continue;
    }
    // Keep the record with the latest timestamp if duplicates exist.
    const a = new Date(existing.timestamp ?? 0).getTime();
    const b = new Date(info.timestamp ?? 0).getTime();
    if ((Number.isNaN(a) ? 0 : a) <= (Number.isNaN(b) ? 0 : b)) byId.set(info.sessionId, info);
  }

  const rows = Array.from(byId.values()).sort((a, b) => {
    const at = new Date(a.timestamp ?? 0).getTime();
    const bt = new Date(b.timestamp ?? 0).getTime();
    return (Number.isNaN(bt) ? 0 : bt) - (Number.isNaN(at) ? 0 : at);
  });

  const sliced = rows.slice(0, limit);

  if (format === "json") {
    stdout.write(JSON.stringify(sliced, null, 2) + "\n");
    return 0;
  }

  if (format === "tsv") {
    for (const r of sliced) {
      stdout.write(
        [toIsoOrEmpty(r.timestamp), r.sessionId, r.cwd ?? "", r.brief ?? "", r.rolloutPath].join(
          "\t",
        ) + "\n",
      );
    }
    return 0;
  }

  // table output
  const terminalWidth = Number.isFinite(io.terminalWidth)
    ? io.terminalWidth
    : Number.isFinite(stdout.columns)
      ? stdout.columns
      : 120;
  const idWidth = shortId ? 13 : 36;
  const timeWidth = 16;
  const cwdWidth = full
    ? Math.min(64, Math.floor(terminalWidth * 0.35))
    : Math.min(40, Math.floor(terminalWidth * 0.25));
  const logWidth = full ? Math.min(52, Math.floor(terminalWidth * 0.25)) : 0;

  const fixed = timeWidth + 1 + idWidth + 1 + cwdWidth + 1 + (logWidth ? logWidth + 1 : 0);
  const briefWidth = Math.max(20, terminalWidth - fixed);

  const headerParts = [
    padRight("Updated", timeWidth),
    padRight("Session", idWidth),
    padRight("CWD", cwdWidth),
  ];
  if (logWidth) headerParts.push(padRight("Log", logWidth));
  headerParts.push(padRight("Brief", briefWidth));

  stdout.write(`${headerParts.join(" ")}\n`);
  stdout.write(`${"-".repeat(Math.min(terminalWidth, headerParts.join(" ").length))}\n`);

  for (const r of sliced) {
    const updated = formatLocalDateTime(r.timestamp);
    const sid = shortId ? shortSessionId(r.sessionId) : r.sessionId;
    const cwdOut = shortenPath(r.cwd ?? "", cwdWidth);
    const logOut = logWidth ? shortenPath(r.rolloutPath ?? "", logWidth) : "";
    const briefOut = clampText(
      full ? extractUserBrief(r.brief ?? "", BRIEF_MAX_CHARS_FULL) ?? "" : r.brief ?? "",
      briefWidth,
    );

    const parts = [
      padRight(updated, timeWidth),
      padRight(sid, idWidth),
      padRight(cwdOut, cwdWidth),
    ];
    if (logWidth) parts.push(padRight(logOut, logWidth));
    parts.push(padRight(briefOut, briefWidth));
    stdout.write(parts.join(" ") + "\n");
  }

  return 0;
}

const isMain = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  return import.meta.url === pathToFileURL(path.resolve(argv1)).href;
})();

if (isMain) {
  process.exitCode = await runCodexSessionsList(process.argv.slice(2), {
    stdout: process.stdout,
    stderr: process.stderr,
    terminalWidth: process.stdout.columns,
  });
}
