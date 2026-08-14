#!/usr/bin/env node
// PreToolUse hook — the real containment boundary for a spawned agent.
//
// Phase 0 established that `--allowedTools "… Bash(node:*)"` did NOT stop the agent running
// `ls`, so the allowlist cannot be relied on as a sandbox. This hook is what actually enforces:
//   * writes land only on the files the ticket declared
//   * Bash is limited to a known-safe set of command heads
//
// Contract: hook JSON arrives on stdin. Exit 0 allows; exit 2 blocks and feeds stderr back to
// the agent as the tool's error result.
//
// Configured per-invocation through `--settings '<inline json>'`, so the user's global
// ~/.claude/settings.json is never touched.

import fs from "node:fs";
import path from "node:path";

const WORKSPACE = process.env.SYMPHONY_WORKSPACE || process.cwd();
const SCOPE = safeParse(process.env.SYMPHONY_SCOPE) || [];
const DENIALS = process.env.SYMPHONY_DENIALS_FILE || "";

const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/** Command heads an agent may run. Anything else is blocked. */
const ALLOWED_HEADS = [
  "node", "npm", "npx",
  "ls", "dir", "pwd", "echo", "cat", "type", "head", "tail", "wc", "find", "grep", "where",
  "git",
  // `cd` is harmless and agents reach for it constantly (`cd <ws> && npm test`).
  // Blocking it cost a wasted turn in the first live run for no security benefit.
  "cd", "true", "set",
];
/** Blocked outright wherever they appear — destructive or network. */
const FORBIDDEN = /\b(rm|rmdir|del|erase|format|mkfs|shutdown|reboot|curl|wget|Invoke-WebRequest|iwr|scp|ssh|nc|telnet|chmod|chown|takeown|icacls|reg|schtasks|taskkill|kill)\b|>\s*\/dev\/|:\(\)\{/i;
/** git is read-only here. */
const GIT_OK = /^git\s+(status|diff|log|show|ls-files|rev-parse)\b/i;
/** npm is limited to running tests. */
const NPM_OK = /^(npm|npx)\s+(run\s+)?(test|--version|-v)\b/i;

main();

function main() {
  let input = "";
  try { input = fs.readFileSync(0, "utf8"); } catch { /* no stdin */ }
  const payload = safeParse(input) || {};
  const tool = payload.tool_name;
  const ti = payload.tool_input || {};

  if (WRITE_TOOLS.has(tool)) return checkWrite(tool, ti);
  if (tool === "Bash") return checkBash(ti);
  process.exit(0); // Read/Glob/Grep/TodoWrite etc. are unrestricted
}

function checkWrite(tool, ti) {
  const target = ti.file_path;
  if (!target) return allow();

  const rel = toRel(target);
  if (rel === null) {
    return block(`Write blocked: ${target} is outside the workspace (${WORKSPACE}). ` +
      `You may only create the files assigned to this task: ${SCOPE.join(", ") || "(none)"}.`);
  }
  if (!inScope(rel)) {
    return block(`Write blocked: you do not own \`${rel}\`. ` +
      `This task owns exactly: ${SCOPE.join(", ") || "(none)"}. ` +
      `Another agent may be working on that file right now — create your own file instead.`);
  }
  allow();
}

function checkBash(ti) {
  const cmd = String(ti.command || "");
  if (!cmd.trim()) return allow();

  if (FORBIDDEN.test(cmd)) return block(`Bash blocked: command contains a forbidden operation.\n${cmd}`);

  // Check every segment of a chained command, not just the first — but split on operators
  // OUTSIDE quotes only. `node -e "console.log(a); f()"` is one command, and splitting on the
  // semicolon inside the script made the guard reject perfectly ordinary one-liners.
  for (const seg of splitUnquoted(cmd)) {
    const s = seg.trim();
    if (!s) continue;
    const head = (s.split(/\s+/)[0] || "").replace(/^.*[\\/]/, "").toLowerCase();
    if (!ALLOWED_HEADS.includes(head)) {
      return block(`Bash blocked: \`${head}\` is not an allowed command here. ` +
        `Allowed: ${ALLOWED_HEADS.join(", ")}. Use the Read/Glob/Grep tools for inspection.`);
    }
    if (head === "git" && !GIT_OK.test(s)) return block(`Bash blocked: git is read-only here (status/diff/log/show).`);
    if ((head === "npm" || head === "npx") && !NPM_OK.test(s)) return block(`Bash blocked: only \`npm test\` is permitted.`);
  }
  allow();
}

/* ---------- helpers ---------- */

function inScope(rel) {
  if (!SCOPE.length) return false;
  const r = norm(rel);
  return SCOPE.some((entry) => {
    const e = norm(entry);
    if (e.endsWith("/")) return r.startsWith(e);          // directory grant
    if (r === e) return true;                              // exact file
    return r.startsWith(e + "/");                          // dir named without slash
  });
}

/** Absolute or relative target → workspace-relative posix path, or null if outside. */
function toRel(target) {
  const abs = path.resolve(WORKSPACE, String(target));
  const rel = path.relative(WORKSPACE, abs);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join("/");
}

/**
 * Split a shell command on &&, ||, ; and | — ignoring any that appear inside quotes.
 *
 * A naive split rejected `node -e "console.log(JSON.stringify(x)); f()"`, because the
 * semicolon inside the script looked like a command separator and `console.log(...)` looked
 * like an unknown command head.
 */
function splitUnquoted(cmd) {
  const parts = [];
  let buf = "";
  let quote = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      if (c === "\\" && quote !== "'") { buf += c + (cmd[++i] ?? ""); continue; }
      if (c === quote) quote = null;
      buf += c;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") { quote = c; buf += c; continue; }
    if (c === ";" || c === "|" || c === "&") {
      // consume a doubled operator (&& / ||) so the second char is not treated as a segment
      if ((c === "|" || c === "&") && cmd[i + 1] === c) i++;
      parts.push(buf); buf = "";
      continue;
    }
    buf += c;
  }
  parts.push(buf);
  return parts.filter((s) => s.trim());
}

// NB: function declaration, not a const arrow — main() runs above this point and a
// const would be in the temporal dead zone.
function norm(s) { return String(s).replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase(); }
function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }
function allow() { process.exit(0); }

function block(reason) {
  if (DENIALS) {
    try {
      fs.appendFileSync(DENIALS, JSON.stringify({ at: new Date().toISOString(), reason }) + "\n");
    } catch { /* never let logging break the hook */ }
  }
  process.stderr.write(reason + "\n");
  process.exit(2); // 2 = block, stderr is returned to the agent
}
