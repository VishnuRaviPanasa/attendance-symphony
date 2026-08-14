// Independent verification of an agent's work.
//
// Until this existed, a ticket was "completed" when the agent's process exited cleanly and
// emitted a result event — that is the AGENT'S claim about its own work. An agent that wrote a
// failing test, or broke an existing one, still showed green on the dashboard.
//
// The orchestrator now runs the suite itself, in the agent's own worktree, after the agent has
// finished and before anything is merged. Red means the ticket failed and gets retried.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { childEnv } from "./agent-runner.js";

/**
 * Environment for the verification run.
 *
 * Beyond the CLAUDE* scrubbing childEnv() does, this drops the variables Node's own test runner
 * exports to its children. `NODE_TEST_CONTEXT` in particular switches a nested `node --test`
 * into machine-reporting mode: no human-readable "ℹ pass N" lines to parse, and different exit
 * semantics. Inheriting it makes the gate silently misreport whenever the orchestrator is itself
 * run from a test.
 */
function verifyEnv() {
  const env = childEnv();
  for (const k of ["NODE_TEST_CONTEXT", "NODE_OPTIONS", "NODE_V8_COVERAGE", "TEST_PARALLEL"]) delete env[k];
  return env;
}

/** Run a shell command in a directory and capture its output. */
function run(command, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, env: verifyEnv(), windowsHide: true });
    let out = "";
    let killed = false;
    const timer = setTimeout(() => { killed = true; try { child.kill(); } catch {} }, timeoutMs);

    const take = (d) => { out += d.toString("utf8"); if (out.length > 200_000) out = out.slice(-200_000); };
    child.stdout.on("data", take);
    child.stderr.on("data", take);

    child.on("error", (e) => { clearTimeout(timer); resolve({ code: null, out: e.message, killed }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, out, killed }); });
  });
}

/** Pull pass/fail counts out of node:test output. */
function summarise(out) {
  const num = (label) => {
    const m = out.match(new RegExp(`^\\s*(?:ℹ|#)?\\s*${label}\\s+(\\d+)\\s*$`, "m"));
    return m ? Number(m[1]) : null;
  };
  const pass = num("pass");
  const fail = num("fail");
  const tests = num("tests");
  if (pass == null && fail == null) return null;
  return { tests, pass: pass ?? 0, fail: fail ?? 0 };
}

/**
 * Verify a finished ticket.
 *
 * @returns {Promise<{ok, kind, command, summary, counts, output, durationMs}>}
 */
export async function verifyTask(task, workspaceDir, { timeoutMs = 180_000, onLog = () => {} } = {}) {
  const started = Date.now();

  // UI work has no test suite to run, so the gate checks the thing that actually matters:
  // the file is still a complete, parseable document. A truncated or syntactically broken
  // index.html is the realistic failure mode for an agent editing a 100 KB single-file app.
  if (task.kind === "frontend") {
    const result = verifyHtml(workspaceDir, task);
    return { ...result, kind: "html", durationMs: Date.now() - started };
  }

  const command = task.ticket?.verify || "npm test";
  onLog("i", `${task.key}: verifying with \`${command}\``);

  const { code, out, killed } = await run(command, workspaceDir, timeoutMs);
  const counts = summarise(out);
  const ok = code === 0 && !killed;

  let summary;
  if (killed) summary = `verification timed out after ${Math.round(timeoutMs / 1000)}s`;
  else if (counts) summary = `${counts.pass} passed${counts.fail ? `, ${counts.fail} FAILED` : ""}`;
  else summary = ok ? "command succeeded" : `exit code ${code}`;

  return {
    ok, kind: "command", command, counts, summary,
    output: tail(out, 40),
    durationMs: Date.now() - started,
  };
}

/** Structural check for single-file HTML apps. */
function verifyHtml(workspaceDir, task) {
  const files = (task.scope || []).filter((f) => f.endsWith(".html"));
  if (!files.length) return { ok: true, command: "(no html in scope)", summary: "nothing to check", counts: null, output: "" };

  const problems = [];
  for (const rel of files) {
    const file = path.join(workspaceDir, rel);
    if (!fs.existsSync(file)) { problems.push(`${rel}: missing`); continue; }

    const html = fs.readFileSync(file, "utf8");
    if (!/<\/html>\s*$/i.test(html.trim())) problems.push(`${rel}: does not end with </html> — file looks truncated`);
    if (!/<\/body>/i.test(html)) problems.push(`${rel}: no closing </body>`);

    // Every inline script must actually parse. A stray brace in a 100 KB file breaks the
    // whole app silently, and the browser is the only thing that would have told you.
    const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
    scripts.forEach(([, body], i) => {
      try { new Function(body); }
      catch (e) { problems.push(`${rel}: inline script #${i + 1} has a syntax error — ${e.message}`); }
    });
    if (!scripts.length) problems.push(`${rel}: no inline script found — did the app lose its code?`);

    // The app must stay self-contained; an external request breaks offline use.
    if (/<script[^>]*\bsrc=|<link[^>]*rel=["']?stylesheet/i.test(html)) {
      problems.push(`${rel}: introduces an external resource — the app must stay self-contained`);
    }
  }

  return {
    ok: problems.length === 0,
    command: `structural check of ${files.join(", ")}`,
    counts: null,
    summary: problems.length ? `${problems.length} problem(s)` : `${files.join(", ")} intact and parseable`,
    output: problems.join("\n"),
  };
}

function tail(s, lines) {
  return String(s).split(/\r?\n/).filter(Boolean).slice(-lines).join("\n");
}
