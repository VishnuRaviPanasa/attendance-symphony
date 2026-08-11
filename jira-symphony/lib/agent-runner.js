// Spawns a REAL Claude Code process for one ticket and streams its execution.
//
// Everything the dashboard shows about a working agent originates here. There is no
// simulation path and no fallback that invents activity: if the process emits nothing,
// the card shows nothing.
//
// Windows notes, both learned the hard way in Phase 0:
//   * we invoke the CLI's cli.js with the current node binary. Spawning `claude.cmd`
//     needs shell:true on Node >=20 (CVE-2024-27980), which then reintroduces quoting
//     bugs. Running the JS directly avoids the shell completely.
//   * every CLAUDE* env var is scrubbed. Claude Code refuses to start inside another
//     Claude Code session, and would exit 1 with EMPTY stdout — a confusing failure.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

import { createJsonlSplitter } from "./jsonl.js";
import { normalize } from "./events.js";
import { buildPrompt, systemPromptFor, roleFor, ALLOWED_TOOLS, DISALLOWED_TOOLS } from "./prompts.js";

const require = createRequire(import.meta.url);

/** Locate the Claude Code cli.js so we can run it with node directly. */
export function resolveCli() {
  if (process.env.SYMPHONY_CLAUDE_CLI && fs.existsSync(process.env.SYMPHONY_CLAUDE_CLI)) {
    return process.env.SYMPHONY_CLAUDE_CLI;
  }
  try {
    return require.resolve("@anthropic-ai/claude-code/cli.js");
  } catch { /* not a local dependency — try the global install */ }

  const candidates = [
    path.join(process.env.APPDATA || "", "npm", "node_modules", "@anthropic-ai", "claude-code", "cli.js"),
    path.join(process.env.HOME || process.env.USERPROFILE || "", "AppData", "Roaming", "npm", "node_modules", "@anthropic-ai", "claude-code", "cli.js"),
    "/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js",
    "/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js",
  ];
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  return null;
}

/** Strip the parent session's Claude vars so the child is not seen as a nested session. */
export function childEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^CLAUDE(CODE)?(_|$)/.test(k)) delete env[k];
  return { ...env, ...extra };
}

/** Inline settings carrying the scope hook — never touches the user's global settings. */
function buildSettings(hookScript) {
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: "Write|Edit|MultiEdit|NotebookEdit|Bash",
          hooks: [{ type: "command", command: `node "${hookScript}"`, timeout: 20 }],
        },
      ],
    },
  };
}

/**
 * Run one ticket. Returns { promise, kill, sessionId }.
 *
 * onEvent(normalisedEvent) fires for every event parsed from the live stream.
 */
export function runAgent({
  agentId,
  ticket,
  workspace,
  runDir,
  model = process.env.AGENT_MODEL || "sonnet",
  effort = process.env.AGENT_EFFORT || "medium",
  budgetUsd = +(process.env.MAX_BUDGET_USD || 2),
  timeoutMs = +(process.env.AGENT_TIMEOUT_MS || 12 * 60 * 1000),
  hookScript,
  onEvent = () => {},
  onLog = () => {},
}) {
  const cli = resolveCli();
  if (!cli) {
    return {
      sessionId: null,
      kill: () => {},
      promise: Promise.resolve({
        ok: false,
        exitCode: null,
        error: "Claude Code CLI not found. Install it, or set SYMPHONY_CLAUDE_CLI to cli.js.",
        sawResult: false,
      }),
    };
  }

  fs.mkdirSync(runDir, { recursive: true });
  const rawPath = path.join(runDir, `${agentId}.jsonl`);
  const denialsPath = path.join(runDir, `${agentId}.denials.jsonl`);
  // Timing lives in a sidecar so the transcript itself stays a byte-faithful record of what
  // Claude Code emitted. Replay needs the offsets; anyone auditing the run wants the raw file.
  const timingPath = path.join(runDir, `${agentId}.timing.jsonl`);
  const rawStream = fs.createWriteStream(rawPath, { flags: "a" });
  const timingStream = fs.createWriteStream(timingPath, { flags: "a" });
  const t0 = Date.now();
  let lineNo = 0;

  const sessionId = randomUUID();
  const settings = JSON.stringify(buildSettings(hookScript));
  const prompt = buildPrompt(ticket, { workspace });
  const systemPrompt = systemPromptFor(ticket);

  const args = [
    cli,
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--append-system-prompt", systemPrompt,
    "--permission-mode", "acceptEdits",
    "--allowedTools", ALLOWED_TOOLS.join(" "),
    "--disallowedTools", DISALLOWED_TOOLS.join(" "),
    "--model", model,
    "--effort", effort,
    "--max-budget-usd", String(budgetUsd),
    "--session-id", sessionId,
    "--add-dir", workspace,
    "--settings", settings,
    // 15 unauthenticated MCP servers are configured on this machine; loading them on every
    // spawn adds latency and failure modes for no benefit here.
    "--strict-mcp-config",
    "--mcp-config", JSON.stringify({ mcpServers: {} }),
  ];

  const env = childEnv({
    SYMPHONY_WORKSPACE: workspace,
    SYMPHONY_SCOPE: JSON.stringify(ticket.scope || []),
    SYMPHONY_DENIALS_FILE: denialsPath,
  });

  const child = spawn(process.execPath, args, { cwd: workspace, env, windowsHide: true });

  let sawResult = false;
  let resultEvent = null;
  let stderrBuf = "";
  let killedForTimeout = false;

  const ctx = { cwd: workspace };
  const splitter = createJsonlSplitter(
    (obj, line) => {
      rawStream.write(line + "\n");
      timingStream.write(JSON.stringify({ n: lineNo++, t: Date.now() - t0 }) + "\n");
      for (const ev of normalize(obj, ctx)) {
        if (ev.kind === "result") { sawResult = true; resultEvent = ev; }
        try { onEvent(ev); } catch (e) { onLog("w", `event handler threw: ${e.message}`); }
      }
    },
    (line) => onLog("w", `unparseable stream line (${line.length} bytes)`)
  );

  child.stdout.on("data", (c) => splitter.push(c));
  child.stderr.on("data", (c) => { stderrBuf += c.toString("utf8"); if (stderrBuf.length > 8000) stderrBuf = stderrBuf.slice(-8000); });

  // The prompt goes over stdin, not argv: it is long, contains quotes and newlines, and
  // Windows argv quoting is a reliable source of corruption.
  child.stdin.on("error", () => { /* the child may exit before we finish writing */ });
  child.stdin.end(prompt);

  const timer = setTimeout(() => { killedForTimeout = true; try { child.kill(); } catch {} }, timeoutMs);

  const promise = new Promise((resolve) => {
    child.on("error", (err) => {
      clearTimeout(timer);
      rawStream.end(); timingStream.end();
      resolve({ ok: false, exitCode: null, error: `spawn failed: ${err.message}`, sawResult: false, rawPath });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      splitter.end();
      rawStream.end(); timingStream.end();

      const denials = readDenials(denialsPath);

      // A process that exits WITHOUT a result event has failed, whatever the exit code.
      // The nested-session refusal exits 1 with completely empty stdout.
      let ok = code === 0 && sawResult && !resultEvent?.isError;
      let error = null;
      if (killedForTimeout) error = `timed out after ${Math.round(timeoutMs / 1000)}s`;
      else if (!sawResult) error = stderrBuf.trim().split("\n")[0] || `exited ${code} with no result event`;
      else if (resultEvent?.isError) error = `run reported ${resultEvent.subtype}`;
      else if (code !== 0) error = `exit code ${code}`;

      resolve({ ok, exitCode: code, error, sawResult, resultEvent, denials, rawPath, sessionId, stderr: stderrBuf.trim().slice(0, 500) });
    });
  });

  return {
    sessionId,
    rawPath,
    kill: () => { try { child.kill(); } catch {} },
    promise,
  };
}

function readDenials(p) {
  try {
    return fs.readFileSync(p, "utf8").split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { reason: l }; } });
  } catch { return []; }
}

export function agentPersona(ticket) { return roleFor(ticket); }
